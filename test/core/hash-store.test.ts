import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

import {
  loadHashStore,
  shutdownHashStore,
  getSnapshot,
  upsertSnapshot,
  deleteSnapshot,
  pruneMissing,
  type HashStore,
} from "../../src/hash-store";
import { HASH_STORE_VERSION } from "../../src/constants";
import { initHasher, contentChecksum } from "../../src/hashline/hasher";
import { splitLines } from "../../src/utils";
import { getWritableTempRoot } from "../support/fixtures";

let tmpHome: string;
beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-hashstore-test-"));
  vi.stubEnv("HOME", tmpHome);
  try {
    await run(tmpHome);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}

function configHome(home: string): string {
  return join(home, ".config", "pi-hashline-edit-pro");
}

function sqlitePath(home: string): string {
  return join(configHome(home), "hash-store.sqlite");
}

function legacyPath(home: string): string {
  return join(configHome(home), "hash-store.json");
}

async function put(
  store: HashStore,
  path: string,
  content: string,
  hashes: string[],
): Promise<void> {
  upsertSnapshot(store, path, contentChecksum(content), splitLines(content).length, hashes);
}
async function writeLegacyStore(home: string, snapshots: unknown): Promise<void> {
  await mkdir(configHome(home), { recursive: true });
  await writeFile(legacyPath(home), JSON.stringify({ version: 1, snapshots }), "utf-8");
}

describe("hash-store — loadHashStore", () => {
  it("opens a fresh sqlite database when none exists", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      expect(existsSync(sqlitePath(home))).toBe(true);
      expect(getSnapshot(store, "/none.ts", "x\n")).toBeUndefined();
    });
  });

  it("creates the config directory", async () => {
    await withTempHome(async () => {
      await loadHashStore();
      const s = await stat(configHome(tmpHome));
      expect(s.isDirectory()).toBe(true);
    });
  });
});

describe("hash-store — snapshot get / upsert / delete", () => {
  it("round-trips a snapshot by path and content matching checksum", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const content = "hello\nworld\n";
      const hashes = ["aB3", "xY7"];
      await put(store, "/path/to/file.ts", content, hashes);

      expect(getSnapshot(store, "/path/to/file.ts", content)).toEqual(hashes);
    });
  });

  it("returns undefined when content changed (checksum mismatch)", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "aaa\nbbb\n", ["A", "B"]);

      expect(getSnapshot(store, "/p.ts", "aaa\nbbb\n")).toEqual(["A", "B"]);
      expect(getSnapshot(store, "/p.ts", "aaa\nBBB\n")).toBeUndefined();
    });
  });

  it("overwrites an existing path with new content+hashes", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "old\n", ["O"]);
      await put(store, "/p.ts", "new\n", ["N"]);

      expect(getSnapshot(store, "/p.ts", "old\n")).toBeUndefined();
      expect(getSnapshot(store, "/p.ts", "new\n")).toEqual(["N"]);
    });
  });

  it("keeps unrelated snapshots intact when upserting another path", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const aContent = "a\nb\nc\nd\ne\n".repeat(50);
      const aHashes = aContent.split("\n").map((_, i) => `A${i}`);
      await put(store, "/big.ts", aContent, aHashes);
      await put(store, "/small.ts", "x\n", ["X"]);

      expect(getSnapshot(store, "/big.ts", aContent)).toEqual(aHashes);
      expect(getSnapshot(store, "/small.ts", "x\n")).toEqual(["X"]);
    });
  });

  it("deletes a snapshot", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["X"]);
      deleteSnapshot(store, "/p.ts");
      expect(getSnapshot(store, "/p.ts", "x\n")).toBeUndefined();
    });
  });
});

describe("hash-store — corrupt row handling", () => {
  async function corruptHashes(home: string, path: string, value: string): Promise<void> {
    const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
    db.prepare("UPDATE snapshots SET hashes = ? WHERE path = ?").run(value, path);
    db.close();
  }

  it("treats a row with unparseable hashes as a cache miss", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["AAA"]);
      await corruptHashes(home, "/p.ts", "not json");
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toBeUndefined();
      upsertSnapshot(reloaded, "/p.ts", contentChecksum("x\n"), 1, ["BBB"]);
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toEqual(["BBB"]);
    });
  });

  it("treats a row with non-string hashes as a cache miss", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["AAA"]);
      await corruptHashes(home, "/p.ts", "[1,2]");
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toBeUndefined();
    });
  });
});

describe("hash-store — migration from legacy hash-store.json", () => {
  it("imports valid legacy snapshots and renames the file to .bak", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/valid.ts": { content: "ok\n", hashes: ["ABC"] },
        "/also.ts": { content: "good\nmore\n", hashes: ["XYZ", "QWE"] },
      });

      const store = await loadHashStore();

      expect(getSnapshot(store, "/valid.ts", "ok\n")).toEqual(["ABC"]);
      expect(getSnapshot(store, "/also.ts", "good\nmore\n")).toEqual(["XYZ", "QWE"]);
      expect(existsSync(legacyPath(home))).toBe(false);
      expect(existsSync(`${legacyPath(home)}.bak`)).toBe(true);
    });
  });

  it("drops structurally invalid legacy entries, keeps valid ones", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/valid.ts": { content: "ok\n", hashes: ["ABC"] },
        "/missing-hashes.ts": { content: "x\n" },
        "/null-content.ts": { content: null, hashes: ["DEF"] },
        "/hashes-not-array.ts": { content: "y\n", hashes: "not-an-array" },
        "/hash-not-string.ts": { content: "z\n", hashes: [42] },
        "/also-valid.ts": { content: "good\n", hashes: ["XYZ"] },
      });

      const store = await loadHashStore();

      expect(getSnapshot(store, "/valid.ts", "ok\n")).toEqual(["ABC"]);
      expect(getSnapshot(store, "/also-valid.ts", "good\n")).toEqual(["XYZ"]);
      expect(getSnapshot(store, "/missing-hashes.ts", "x\n")).toBeUndefined();
      expect(getSnapshot(store, "/null-content.ts", "")).toBeUndefined();
      expect(getSnapshot(store, "/hashes-not-array.ts", "y\n")).toBeUndefined();
      expect(getSnapshot(store, "/hash-not-string.ts", "z\n")).toBeUndefined();
    });
  });

  it("ignores a legacy snapshots field that is an array", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, ["not-an-object"]);

      const store = await loadHashStore();
      const paths = store.stmts.allPaths();
      expect(paths).toEqual([]);
    });
  });

  it("does not run migration when no legacy file exists", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      expect(store.stmts.allPaths()).toEqual([]);
      expect(existsSync(`${legacyPath(home)}.bak`)).toBe(false);
    });
  });

  it("migrates only once even if legacy file reappears", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/one.ts": { content: "1\n", hashes: ["AAA"] },
      });
      const first = await loadHashStore();
      expect(getSnapshot(first, "/one.ts", "1\n")).toEqual(["AAA"]);
      expect(existsSync(`${legacyPath(home)}.bak`)).toBe(true);

      await writeFile(legacyPath(home), JSON.stringify({
        version: 1,
        snapshots: { "/two.ts": { content: "2\n", hashes: ["BBB"] } },
      }), "utf-8");

      const second = await loadHashStore();
      expect(getSnapshot(second, "/two.ts", "2\n")).toBeUndefined();
      expect(getSnapshot(second, "/one.ts", "1\n")).toEqual(["AAA"]);
    });
  });
});

describe("hash-store — pruneMissing", () => {
  it("removes snapshots for files that no longer exist", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await put(store, "/gone.ts", "old\n", ["ZZZ"]);
      await pruneMissing(store);
      expect(getSnapshot(store, "/gone.ts", "old\n")).toBeUndefined();
    });
  });

  it("keeps snapshots for files that still exist", async () => {
    await withTempHome(async (home) => {
      const existing = join(home, "keep.ts");
      await writeFile(existing, "keep\n", "utf-8");

      const store = await loadHashStore();
      await put(store, existing, "keep\n", ["KEP"]);
      await put(store, "/gone.ts", "gone\n", ["GON"]);
      await pruneMissing(store);

      expect(getSnapshot(store, existing, "keep\n")).toEqual(["KEP"]);
      expect(getSnapshot(store, "/gone.ts", "gone\n")).toBeUndefined();
    });
  });

  it("prunes against live rows, not a stale snapshot", async () => {
    await withTempHome(async (home) => {
      const keep = join(home, "keep.ts");
      const grown = join(home, "grow.ts");
      await writeFile(keep, "keep\n", "utf-8");
      await writeFile(grown, "grow\n", "utf-8");

      const store = await loadHashStore();
      await put(store, keep, "keep\n", ["KEP"]);
      await put(store, "/gone.ts", "gone\n", ["GON"]);
      await put(store, grown, "grow\n", ["GRW"]);
      await pruneMissing(store);

      expect(getSnapshot(store, keep, "keep\n")).toEqual(["KEP"]);
      expect(getSnapshot(store, grown, "grow\n")).toEqual(["GRW"]);
      expect(getSnapshot(store, "/gone.ts", "gone\n")).toBeUndefined();
    });
  });
});

describe("hash-store — concurrency (issue #10)", () => {
  it("preserves snapshots written by a separately-opened connection", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/a.ts", "alpha\n", ["AA"]);

      const second = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const ins = second.prepare(
        "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
      );
      second.exec("BEGIN IMMEDIATE");
      ins.run("/b.ts", contentChecksum("beta\n"), splitLines("beta\n").length, JSON.stringify(["BB"]), Date.now());
      second.exec("COMMIT");

      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/a.ts", "alpha\n")).toEqual(["AA"]);
      expect(getSnapshot(reloaded, "/b.ts", "beta\n")).toEqual(["BB"]);
    });
  });

  it("a fresh reopen sees snapshots written by a prior session", async () => {
    await withTempHome(async () => {
      const a = await loadHashStore();
      await put(a, "/first.ts", "one\n", ["1"]);
      shutdownHashStore();

      const b = await loadHashStore();
      await put(b, "/second.ts", "two\n", ["2"]);
      shutdownHashStore();

      const c = await loadHashStore();
      expect(getSnapshot(c, "/first.ts", "one\n")).toEqual(["1"]);
      expect(getSnapshot(c, "/second.ts", "two\n")).toEqual(["2"]);
    });
  });
});

describe("hash-store — incremental writes (issue #8)", () => {
  it("upserting a new path does not alter an existing path's stored hashes", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const bigContent = "x\n".repeat(2000);
      const bigHashes = bigContent.split("\n").map((_, i) => `H${i}`);
      await put(store, "/big.ts", bigContent, bigHashes);
      const before = getSnapshot(store, "/big.ts", bigContent);

      await put(store, "/other.ts", "y\n", ["YY"]);

      expect(getSnapshot(store, "/big.ts", bigContent)).toEqual(before);
    });
  });
});

describe("hash-store — WAL checkpoint on shutdown", () => {
  it("truncates the WAL file after shutdownHashStore", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["X"]);

      const walPath = sqlitePath(home) + "-wal";
      expect(existsSync(walPath)).toBe(true);

      shutdownHashStore();

      expect(existsSync(walPath)).toBe(false);
    });
  });
});

describe("hash-store — corrupt database recovery", () => {
  it("rebuilds the store when the database file is corrupt", async () => {
    await withTempHome(async (home) => {
      await mkdir(configHome(home), { recursive: true });
      await writeFile(sqlitePath(home), "this is not a sqlite database", "utf-8");

      const store = await loadHashStore();
      expect(getSnapshot(store, "/x.ts", "a\n")).toBeUndefined();

      upsertSnapshot(store, "/x.ts", contentChecksum("a\n"), 1, ["AAA"]);
      expect(getSnapshot(store, "/x.ts", "a\n")).toEqual(["AAA"]);
    });
  });

  it("quarantines the corrupt file instead of deleting it", async () => {
    await withTempHome(async (home) => {
      await mkdir(configHome(home), { recursive: true });
      await writeFile(sqlitePath(home), "garbage bytes", "utf-8");

      await loadHashStore();

      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(true);
      expect(existsSync(sqlitePath(home))).toBe(true);
    });
  });

  it("keeps working when the store is healthy", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      upsertSnapshot(store, "/p.ts", contentChecksum("b\n"), 1, ["BBB"]);
      expect(getSnapshot(store, "/p.ts", "b\n")).toEqual(["BBB"]);
      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
    });
  });
});

describe("hash-store — schema versioning", () => {
  it("writes the current version on first open", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["X"]);
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
      db.close();

      expect(row?.value).toBe(String(HASH_STORE_VERSION));
    });
  });

  it("keeps snapshots when the stored version matches", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["X"]);
      shutdownHashStore();

      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toEqual(["X"]);
    });
  });

  it("invalidates all snapshots when the stored version differs", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["X"]);
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      db.prepare("UPDATE meta SET value = '999' WHERE key = 'version'").run();
      db.close();

      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toBeUndefined();

      const check = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const row = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
      check.close();
      expect(row?.value).toBe(String(HASH_STORE_VERSION));
    });
  });

  it("keeps snapshots from a pre-versioning database and writes the version", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["X"]);
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      db.exec("DROP TABLE meta");
      db.close();

      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toEqual(["X"]);

      const check = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const row = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
      check.close();
      expect(row?.value).toBe(String(HASH_STORE_VERSION));
    });
  });
});
