import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

import {
  loadHashStore,
  shutdownHashStore,
  ensureFileUndoSchema,
  type HashStore,
} from "../../src/hash-store";
import { getSnapshot, upsertSnapshot, snapshotHashFor } from "../../src/snapshot-store";
import { upsertUndo, getUndoEntry } from "../../src/undo-store";
import { HASH_STORE_VERSION } from "../../src/constants";
import { ANCHOR_GENERATION } from "../../src/hashline";
import { initHasher } from "../../src/hashline/hasher";
import { splitLines } from "../../src/utils";
import { getWritableTempRoot } from "../support/fixtures";

let tmpHome: string;
beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-hashstore-test-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  try {
    await run(tmpHome);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}

function configHome(home: string): string {
  return join(home, ".config", "pi-better-edit");
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
  upsertSnapshot(store, {
    path,
    snapshotHash: snapshotHashFor(content),
    lineCount: splitLines(content).length,
    hashes,
    content,
  });
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

describe("hash-store — migration from legacy hash-store.json", () => {
  it("imports valid legacy snapshot rows and renames the file to .bak (rows are old-canon, so they rebuild on next read)", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/valid.ts": { content: "ok\n", hashes: ["ABCC"] },
        "/also.ts": { content: "good\nmore\n", hashes: ["XYZZ", "QWEE"] },
      });

      const store = await loadHashStore();

      expect(getSnapshot(store, "/valid.ts", "ok\n")).toBeUndefined();
      expect(getSnapshot(store, "/also.ts", "good\nmore\n")).toBeUndefined();
      expect(existsSync(legacyPath(home))).toBe(false);
      expect(existsSync(`${legacyPath(home)}.bak`)).toBe(true);
    });
  });

  it("drops structurally invalid legacy entries, imports valid rows (old-canon, rebuilt on next read)", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/valid.ts": { content: "ok\n", hashes: ["ABCC"] },
        "/missing-hashes.ts": { content: "x\n" },
        "/null-content.ts": { content: null, hashes: ["DEFF"] },
        "/hashes-not-array.ts": { content: "y\n", hashes: "not-an-array" },
        "/hash-not-string.ts": { content: "z\n", hashes: [42] },
        "/also-valid.ts": { content: "good\n", hashes: ["XYZZ"] },
      });

      const store = await loadHashStore();

      expect(getSnapshot(store, "/valid.ts", "ok\n")).toBeUndefined();
      expect(getSnapshot(store, "/also-valid.ts", "good\n")).toBeUndefined();
      expect(getSnapshot(store, "/missing-hashes.ts", "x\n")).toBeUndefined();
      expect(getSnapshot(store, "/null-content.ts", "")).toBeUndefined();
      expect(getSnapshot(store, "/hashes-not-array.ts", "y\n")).toBeUndefined();
      expect(getSnapshot(store, "/hash-not-string.ts", "z\n")).toBeUndefined();
      const paths = (
        store.db.prepare("SELECT path FROM snapshots").all() as { path: string }[]
      ).map((row) => row.path);
      expect(paths).toEqual(expect.arrayContaining(["/valid.ts", "/also-valid.ts"]));
    });
  });

  it("skips legacy snapshots with duplicate hashes so they re-hash on next read", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/dup.ts": { content: "a\nb\n", hashes: ["AAAA", "AAAA"] },
        "/valid.ts": { content: "ok\n", hashes: ["ABCC"] },
      });

      const store = await loadHashStore();

      expect(getSnapshot(store, "/dup.ts", "a\nb\n")).toBeUndefined();
      expect(getSnapshot(store, "/valid.ts", "ok\n")).toBeUndefined();
    });
  });

  it("skips legacy snapshots with malformed hashes so they re-hash on next read", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/bad.ts": { content: "x\n", hashes: ["ZZ", "ZZZZ"] },
        "/valid.ts": { content: "ok\n", hashes: ["ABCC"] },
      });

      const store = await loadHashStore();

      expect(getSnapshot(store, "/bad.ts", "x\n")).toBeUndefined();
      expect(getSnapshot(store, "/valid.ts", "ok\n")).toBeUndefined();
    });
  });

  it("ignores a legacy snapshots field that is an array", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, ["not-an-object"]);

      const store = await loadHashStore();
      const paths = store.db.prepare("SELECT path FROM snapshots").all();
      expect(paths).toEqual([]);
    });
  });

  it("does not run migration when no legacy file exists", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      expect(store.db.prepare("SELECT path FROM snapshots").all()).toEqual([]);
      expect(existsSync(`${legacyPath(home)}.bak`)).toBe(false);
    });
  });

  it("migrates only once even if legacy file reappears", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/one.ts": { content: "1\n", hashes: ["AAAA"] },
      });
      const first = await loadHashStore();
      expect(getSnapshot(first, "/one.ts", "1\n")).toBeUndefined();
      expect(existsSync(`${legacyPath(home)}.bak`)).toBe(true);

      await writeFile(
        legacyPath(home),
        JSON.stringify({
          version: 1,
          snapshots: { "/two.ts": { content: "2\n", hashes: ["BBBB"] } },
        }),
        "utf-8",
      );

      const second = await loadHashStore();
      expect(getSnapshot(second, "/two.ts", "2\n")).toBeUndefined();
      expect(getSnapshot(second, "/one.ts", "1\n")).toBeUndefined();
    });
  });
});

describe("hash-store — concurrency (issue #10)", () => {
  it("preserves snapshots written by a separately-opened connection", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/a.ts", "alpha\n", ["AABB"]);

      const second = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      second.exec("PRAGMA foreign_keys = ON");
      second.exec("BEGIN IMMEDIATE");
      second
        .prepare(
          "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) VALUES (?, ?, ?, ?, 1, ?)",
        )
        .run(
          "/b.ts",
          snapshotHashFor("beta\n"),
          splitLines("beta\n").length,
          Date.now(),
          ANCHOR_GENERATION,
        );
      const snapshotId = (
        second.prepare("SELECT snapshot_id FROM file_snapshots WHERE path = ?").get("/b.ts") as {
          snapshot_id: number;
        }
      ).snapshot_id;
      second
        .prepare(
          "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?, ?, ?, ?, ?)",
        )
        .run(snapshotId, 1, 1, "canon-beta", "BBCC");
      second.prepare("INSERT INTO line_id_counters (path, next_id) VALUES (?, ?)").run("/b.ts", 2);
      second.exec("COMMIT");
      second.close();
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/a.ts", "alpha\n")).toEqual(["AABB"]);
      expect(getSnapshot(reloaded, "/b.ts", "beta\n")).toEqual(["BBCC"]);
    });
  });

  it("a fresh reopen sees snapshots written by a prior session", async () => {
    await withTempHome(async () => {
      const a = await loadHashStore();
      await put(a, "/first.ts", "one\n", ["1111"]);
      shutdownHashStore();

      const b = await loadHashStore();
      await put(b, "/second.ts", "two\n", ["2222"]);
      shutdownHashStore();

      const c = await loadHashStore();
      expect(getSnapshot(c, "/first.ts", "one\n")).toEqual(["1111"]);
      expect(getSnapshot(c, "/second.ts", "two\n")).toEqual(["2222"]);
    });
  });
});

describe("hash-store — incremental writes (issue #8)", () => {
  it("upserting a new path does not alter an existing path's stored hashes", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const bigContent = "x\n".repeat(2000);
      const bigHashes = bigContent.split("\n").map((_, i) => i.toString(16).padStart(3, "0"));
      await put(store, "/big.ts", bigContent, bigHashes);
      const before = getSnapshot(store, "/big.ts", bigContent);

      await put(store, "/other.ts", "y\n", ["YYZZ"]);

      expect(getSnapshot(store, "/big.ts", bigContent)).toEqual(before);
    });
  });
});

describe("hash-store — WAL checkpoint on shutdown", () => {
  it("truncates the WAL file after shutdownHashStore", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZZ"]);

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

      upsertSnapshot(store, {
        path: "/x.ts",
        snapshotHash: snapshotHashFor("a\n"),
        lineCount: 1,
        hashes: ["AAAA"],
        content: "a\n",
      });
      expect(getSnapshot(store, "/x.ts", "a\n")).toEqual(["AAAA"]);
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
      upsertSnapshot(store, {
        path: "/p.ts",
        snapshotHash: snapshotHashFor("b\n"),
        lineCount: 1,
        hashes: ["BBBB"],
        content: "b\n",
      });
      expect(getSnapshot(store, "/p.ts", "b\n")).toEqual(["BBBB"]);
      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
    });
  });
});

describe("hash-store — schema versioning", () => {
  it("writes the current version on first open", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZZ"]);
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      db.close();

      expect(row?.value).toBe(String(HASH_STORE_VERSION));
    });
  });

  it("keeps snapshots when the stored version matches", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZZ"]);
      shutdownHashStore();

      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toEqual(["XYZZ"]);
    });
  });

  it("never drops v7 tables or compat shells when the stored version differs", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZZ"]);
      upsertUndo(store, "/u.ts", {
        content: "old",
        bom: "",
        ending: "\n",
        hashes: ["UVWW"],
        resultContent: "new",
      });
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.prepare("UPDATE meta SET value = '999' WHERE key = 'version'").run();
      db.close();

      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toEqual(["XYZZ"]);
      expect(getUndoEntry(reloaded, "/u.ts")).toMatchObject({ content: "old" });

      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const row = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      const tables = (
        check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      check.close();
      expect(row?.value).toBe(String(HASH_STORE_VERSION));
      for (const t of [
        "file_snapshots",
        "line_id_counters",
        "line_lineage",
        "served_leases",
        "served_session_meta",
        "file_undo",
        "snapshots",
        "served",
        "undo",
      ]) {
        expect(tables).toContain(t);
      }
    });
  });

  it("keeps snapshots from a pre-versioning database and writes the version", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZZ"]);
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.exec("DROP TABLE meta");
      db.close();

      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toEqual(["XYZZ"]);

      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const row = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      check.close();
      expect(row?.value).toBe(String(HASH_STORE_VERSION));
    });
  });
});

describe("hash-store — anchor_generation rename (issue #20)", () => {
  it("renames a pre-rename canon_version column in place, keeps generation-gated behavior, and is idempotent", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/live.ts", "x\n", ["XYZZ"]);
      shutdownHashStore();
      // WHY: simulates the pre-rename merged build — old column name, old 2-part key, stamped 3.
      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      db.exec("ALTER TABLE file_snapshots RENAME COLUMN anchor_generation TO canon_version");
      db.exec("ALTER TABLE file_undo RENAME COLUMN anchor_generation TO canon_version");
      db.prepare(
        "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, canon_version) VALUES (?,?,?,?,1,?)",
      ).run("/old.ts", "3:deadbeef", 1, Date.now(), 3);
      const sid = (
        db.prepare("SELECT snapshot_id FROM file_snapshots WHERE path = ?").get("/old.ts") as {
          snapshot_id: number;
        }
      ).snapshot_id;
      db.prepare(
        "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?,?,?,?,?)",
      ).run(sid, 1, 1, "canon-old", "ZZZZ");
      db.prepare(
        "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, served_snapshot_hash, served_line_number, updated_at, retired_at) VALUES (?,?,?,?,?,?,?,?,NULL)",
      ).run("s1", "/old.ts", "ZZZZ", 1, "canon-old", "3:deadbeef", 1, Date.now());
      db.prepare(
        "INSERT INTO file_undo (path, content, bom, ending, hashes, result_content, snapshot_hash, updated_at, canon_version) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run("/old.ts", "old", "", "\n", '["UVWW"]', "new", "3:deadbeef", Date.now(), 3);
      db.close();
      // WHY: the pre-rename store still opens — the guarded rename preserves stamped values.
      const reopened = await loadHashStore();
      const snapCols = (
        reopened.db.prepare("PRAGMA table_info(file_snapshots)").all() as { name: string }[]
      ).map((row) => row.name);
      const undoCols = (
        reopened.db.prepare("PRAGMA table_info(file_undo)").all() as { name: string }[]
      ).map((row) => row.name);
      expect(snapCols).toContain("anchor_generation");
      expect(snapCols).not.toContain("canon_version");
      expect(undoCols).toContain("anchor_generation");
      expect(undoCols).not.toContain("canon_version");
      // WHY: generation-gated behavior intact — the live row hits, pre-rename rows miss/sweep.
      expect(getSnapshot(reopened, "/live.ts", "x\n")).toEqual(["XYZZ"]);
      expect(getSnapshot(reopened, "/old.ts", "old")).toBeUndefined();
      expect(getUndoEntry(reopened, "/old.ts")).toMatchObject({
        content: "old",
        anchorGeneration: 3,
      });
      expect(
        (
          reopened.db
            .prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?")
            .get("/old.ts") as { n: number }
        ).n,
      ).toBe(0);
      expect(
        (
          reopened.db
            .prepare("SELECT COUNT(*) AS n FROM served_leases WHERE file_path = ?")
            .get("/old.ts") as { n: number }
        ).n,
      ).toBe(0);
      // WHY: idempotent across re-opens — the live row survives every later sweep.
      shutdownHashStore();
      const again = await loadHashStore();
      expect(getSnapshot(again, "/live.ts", "x\n")).toEqual(["XYZZ"]);
      shutdownHashStore();
      const third = await loadHashStore();
      expect(getSnapshot(third, "/live.ts", "x\n")).toEqual(["XYZZ"]);
    });
  });
});

describe("hash-store — v7 CAS schema (issue #79)", () => {
  const V7_TABLES = [
    "file_snapshots",
    "line_id_counters",
    "line_lineage",
    "served_leases",
    "served_session_meta",
    "file_undo",
  ] as const;

  function tableNames(db: DatabaseSync): string[] {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
  }

  function columnNames(db: DatabaseSync, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name,
    );
  }

  function indexNames(db: DatabaseSync): string[] {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
  }

  it("creates all v7 normalized tables with the spec columns", async () => {
    await withTempHome(async (home) => {
      await loadHashStore();
      shutdownHashStore();
      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      try {
        const tables = tableNames(db);
        for (const t of [
          "file_snapshots",
          "line_id_counters",
          "line_lineage",
          "served_leases",
          "served_session_meta",
          "file_undo",
        ]) {
          expect(tables).toContain(t);
        }
        expect(columnNames(db, "file_snapshots")).toEqual(
          expect.arrayContaining([
            "snapshot_id",
            "path",
            "snapshot_hash",
            "line_count",
            "created_at",
            "committed",
            "anchor_generation",
          ]),
        );
        expect(columnNames(db, "line_id_counters")).toEqual(
          expect.arrayContaining(["path", "next_id"]),
        );
        expect(columnNames(db, "line_lineage")).toEqual(
          expect.arrayContaining(["snapshot_id", "line_number", "line_id", "canon_hash", "anchor"]),
        );
        expect(columnNames(db, "served_leases")).toEqual(
          expect.arrayContaining([
            "session_id",
            "file_path",
            "anchor",
            "line_id",
            "canon_hash",
            "served_snapshot_hash",
            "served_line_number",
            "updated_at",
            "retired_at",
          ]),
        );
        expect(columnNames(db, "served_session_meta")).toEqual(
          expect.arrayContaining(["session_id", "file_path", "reported", "updated_at"]),
        );
        expect(columnNames(db, "file_undo")).toEqual(
          expect.arrayContaining([
            "path",
            "content",
            "bom",
            "ending",
            "hashes",
            "result_content",
            "snapshot_hash",
            "anchor_generation",
            "updated_at",
          ]),
        );
      } finally {
        db.close();
      }
    });
  });

  it("creates the v7 indexes and enforces foreign keys", async () => {
    await withTempHome(async (home) => {
      await loadHashStore();
      shutdownHashStore();
      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      try {
        const indexes = indexNames(db);
        for (const idx of [
          "idx_snapshots_created",
          "idx_lineage_snapshot_line_id",
          "idx_leases_line",
          "idx_leases_line_num",
          "idx_leases_file_retired",
        ]) {
          expect(indexes).toContain(idx);
        }
        const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number };
        expect(fk.foreign_keys).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("maintains complete v6 compatibility shells", async () => {
    await withTempHome(async (home) => {
      await loadHashStore();
      shutdownHashStore();
      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      try {
        const tables = tableNames(db);
        for (const t of ["snapshots", "served", "undo"]) {
          expect(tables).toContain(t);
        }
        expect(columnNames(db, "undo")).toEqual(
          expect.arrayContaining([
            "path",
            "content",
            "bom",
            "ending",
            "hashes",
            "result_content",
            "updated_at",
          ]),
        );
        expect(columnNames(db, "served")).toEqual(
          expect.arrayContaining([
            "session_id",
            "path",
            "hashes",
            "reported",
            "retired",
            "canons",
            "snapshotId",
            "updated_at",
          ]),
        );
      } finally {
        db.close();
      }
    });
  });

  function seedV7Rows(db: DatabaseSync): void {
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(
      "INSERT INTO file_snapshots (snapshot_id, path, snapshot_hash, line_count, created_at, committed) " +
        "VALUES (1, '/a.ts', 'v1:aaaa', 3, 111, 1)",
    ).run();
    db.prepare("INSERT INTO line_id_counters (path, next_id) VALUES ('/a.ts', 42)").run();
    db.prepare(
      "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) " +
        "VALUES (1, 1, 42, 'canon42', 'abc|let x = 1;')",
    ).run();
    db.prepare(
      "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, " +
        "served_snapshot_hash, served_line_number, updated_at, retired_at) " +
        "VALUES ('s1', '/a.ts', 'abcc', 42, 'canon42', 'v1:aaaa', 1, 111, NULL)",
    ).run();
    db.prepare(
      "INSERT INTO served_session_meta (session_id, file_path, reported, updated_at) " +
        "VALUES ('s1', '/a.ts', '[\"v1:aaaa\"]', 111)",
    ).run();
    db.prepare(
      "INSERT INTO file_undo (path, content, bom, ending, hashes, result_content, snapshot_hash, updated_at) " +
        "VALUES ('/a.ts', 'old', '', '\n', '[\"abcc\"]', 'new', 'v1:aaaa', 111)",
    ).run();
  }

  function v7Rows(db: DatabaseSync): Record<string, unknown[]> {
    const rows: Record<string, unknown[]> = {};
    for (const table of V7_TABLES) {
      rows[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as unknown[];
    }
    return rows;
  }

  /** Reproduces an un-restarted v6 process opening a v7 store: it drops and recreates the legacy shells and rewrites meta.version = '6'. */
  function simulateV6VersionFlap(db: DatabaseSync): void {
    db.exec("DROP TABLE IF EXISTS snapshots");
    db.exec("DROP TABLE IF EXISTS undo");
    db.exec("DROP TABLE IF EXISTS served");
    db.exec(
      "CREATE TABLE snapshots (path TEXT PRIMARY KEY, checksum TEXT NOT NULL, line_count INTEGER NOT NULL, hashes TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.exec(
      "CREATE TABLE undo (path TEXT PRIMARY KEY, content TEXT NOT NULL, bom TEXT NOT NULL, ending TEXT NOT NULL, hashes TEXT NOT NULL, result_content TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.exec(
      "CREATE TABLE served (session_id TEXT NOT NULL, path TEXT NOT NULL, hashes TEXT NOT NULL, reported TEXT, retired TEXT, canons TEXT, snapshotId TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, path))",
    );
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('version', '6') ON CONFLICT(key) DO UPDATE SET value = '6'",
    ).run();
  }

  it("preserves every v7 row across a meta.version flap to '6'", async () => {
    await withTempHome(async (home) => {
      await loadHashStore();
      shutdownHashStore();

      let db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      seedV7Rows(db);
      const seeded = v7Rows(db);
      db.close();

      db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      simulateV6VersionFlap(db);
      db.close();

      const reloaded = await loadHashStore();
      expect(getUndoEntry(reloaded, "/a.ts")).toMatchObject({
        content: "old",
        snapshotHash: "v1:aaaa",
      });
      shutdownHashStore();

      db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const version = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as {
        value: string;
      };
      const counter = db
        .prepare("SELECT next_id FROM line_id_counters WHERE path = '/a.ts'")
        .get() as { next_id: number };
      const survivors = v7Rows(db);
      // A v6 process can keep writing to its compatibility shell after the flap.
      db.prepare(
        "INSERT INTO served (session_id, path, hashes, reported, retired, canons, snapshotId, updated_at) " +
          "VALUES ('s2', '/b.ts', '[]', NULL, NULL, '[]', NULL, 5)",
      ).run();
      db.close();

      // WHY: generation discipline — unknown-generation snapshot/lineage/lease state is
      // WHY: swept at open (it can never verify), while undo, counters, and session
      // WHY: metadata survive untouched.
      expect(survivors).toEqual({
        ...seeded,
        file_snapshots: [],
        line_lineage: [],
        served_leases: [],
      });
      expect(counter.next_id).toBe(42);
      expect(version.value).toBe(String(HASH_STORE_VERSION));
    });
  });

  it("keeps initialization additive and idempotent across repeated opens", async () => {
    await withTempHome(async (home) => {
      await loadHashStore();
      shutdownHashStore();

      let db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      seedV7Rows(db);
      const seeded = v7Rows(db);
      db.close();

      for (let i = 0; i < 3; i++) {
        await loadHashStore();
        shutdownHashStore();
      }

      db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const tables = tableNames(db);
      const survivors = v7Rows(db);
      db.close();

      for (const table of V7_TABLES) {
        expect(tables.filter((name) => name === table)).toEqual([table]);
      }
      // WHY: the open-time sweep is idempotent — the first open removes the
      // WHY: unknown-generation anchor state, later opens find nothing to delete,
      // WHY: and non-anchor state is untouched throughout.
      expect(survivors).toEqual({
        ...seeded,
        file_snapshots: [],
        line_lineage: [],
        served_leases: [],
      });
    });
  });

  it("enforces the line_lineage foreign key and cascades snapshot deletes", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      expect(() =>
        store.db
          .prepare(
            "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) " +
              "VALUES (999, 1, 1, 'orphan', 'zzz|orphan')",
          )
          .run(),
      ).toThrow(/FOREIGN KEY/i);

      store.db
        .prepare(
          "INSERT INTO file_snapshots (snapshot_id, path, snapshot_hash, line_count, created_at) " +
            "VALUES (7, '/x.ts', 'v1:xxxx', 1, 1)",
        )
        .run();
      store.db
        .prepare(
          "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) " +
            "VALUES (7, 1, 7, 'canon7', 'ddd|const x = 1;')",
        )
        .run();
      store.db.prepare("DELETE FROM file_snapshots WHERE snapshot_id = 7").run();

      const remaining = store.db
        .prepare("SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id = 7")
        .get() as { n: number };
      expect(remaining.n).toBe(0);
    });
  });

  it("adds missing legacy served columns without wiping snapshots or undo", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZZ"]);
      upsertUndo(store, "/u.ts", {
        content: "old",
        bom: "",
        ending: "\n",
        hashes: ["UVWW"],
        resultContent: "new",
      });
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      // Legacy v6 undo history waiting to be migrated, plus a served table that
      // predates the retired/canons/snapshotId columns.
      db.prepare(
        "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) " +
          "VALUES ('/legacy.ts', 'old', '', '\n', '[\"UVW\"]', 'new', 1)",
      ).run();
      db.exec("DROP TABLE served");
      db.exec(
        "CREATE TABLE served (session_id TEXT NOT NULL, path TEXT NOT NULL, hashes TEXT NOT NULL, reported TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, path))",
      );
      db.close();

      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toEqual(["XYZZ"]);
      expect(getUndoEntry(reloaded, "/u.ts")).toMatchObject({ content: "old" });
      shutdownHashStore();

      const check = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const columns = columnNames(check, "served");
      const snapshots = check.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as {
        n: number;
      };
      const undo = check.prepare("SELECT COUNT(*) AS n FROM undo").get() as { n: number };
      check.close();

      expect(columns).toEqual(expect.arrayContaining(["retired", "canons", "snapshotId"]));
      expect(snapshots.n).toBe(1);
      expect(undo.n).toBe(1);
    });
  });

  it("declares an identical file_undo schema in the store and the undo domain", async () => {
    await withTempHome(async (home) => {
      await loadHashStore();
      shutdownHashStore();

      const fromStore = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const storeSql = (
        fromStore
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'file_undo'")
          .get() as { sql: string }
      ).sql;
      fromStore.close();

      const memory = new DatabaseSync(":memory:");
      ensureFileUndoSchema(memory);
      const domainSql = (
        memory
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'file_undo'")
          .get() as { sql: string }
      ).sql;
      memory.close();

      expect(domainSql).toBe(storeSql);
    });
  });

  it("keeps file_undo history immune to a legacy v6 undo drop", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      upsertUndo(store, "/u.ts", {
        content: "old",
        bom: "",
        ending: "\n",
        hashes: ["UVWW"],
        resultContent: "new",
      });
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      db.exec("DROP TABLE IF EXISTS undo");
      db.close();

      const reloaded = await loadHashStore();
      expect(getUndoEntry(reloaded, "/u.ts")).toMatchObject({ content: "old" });
    });
  });
});
