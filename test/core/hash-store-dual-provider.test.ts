vi.mock("better-sqlite3", () => {
  throw new Error("Mocked: better-sqlite3 unavailable");
});

import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  loadHashStore,
  shutdownHashStore,
  getSnapshot,
  upsertSnapshot,
  deleteSnapshot,
  pruneMissing,
} from "../../src/hash-store";
import { initHasher, contentChecksum } from "../../src/hashline/hasher";

let tmpHome: string;

beforeAll(async () => {
  await initHasher();
});

beforeEach(() => {
  shutdownHashStore();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(process.cwd(), ".tmp", "pi-hashline-dual-test-"));
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

describe("hash-store dual-provider — sql.js fallback", () => {
  it("selects sql.js backend when better-sqlite3 is unavailable", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      expect(store.engine).toBe("sql.js");
    });
  });

  it("round-trips a snapshot", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const content = "hello\nworld\n";
      const hashes = ["aB3", "xY7"];
      upsertSnapshot(store, "/p.ts", contentChecksum(content), content.split("\n").length, hashes);
      expect(getSnapshot(store, "/p.ts", content)).toEqual(hashes);
    });
  });

  it("returns undefined when content changed", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertSnapshot(store, "/p.ts", contentChecksum("aaa\nbbb\n"), "aaa\nbbb\n".split("\n").length, ["A", "B"]);
      expect(getSnapshot(store, "/p.ts", "aaa\nbbb\n")).toEqual(["A", "B"]);
      expect(getSnapshot(store, "/p.ts", "aaa\nBBB\n")).toBeUndefined();
    });
  });

  it("overwrites an existing path", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertSnapshot(store, "/p.ts", contentChecksum("old\n"), "old\n".split("\n").length, ["O"]);
      upsertSnapshot(store, "/p.ts", contentChecksum("new\n"), "new\n".split("\n").length, ["N"]);
      expect(getSnapshot(store, "/p.ts", "old\n")).toBeUndefined();
      expect(getSnapshot(store, "/p.ts", "new\n")).toEqual(["N"]);
    });
  });

  it("keeps unrelated snapshots intact", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertSnapshot(store, "/big.ts", contentChecksum("x\n"), "x\n".split("\n").length, ["X"]);
      upsertSnapshot(store, "/small.ts", contentChecksum("y\n"), "y\n".split("\n").length, ["Y"]);
      expect(getSnapshot(store, "/big.ts", "x\n")).toEqual(["X"]);
      expect(getSnapshot(store, "/small.ts", "y\n")).toEqual(["Y"]);
    });
  });

  it("deletes a snapshot", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertSnapshot(store, "/p.ts", contentChecksum("x\n"), "x\n".split("\n").length, ["X"]);
      deleteSnapshot(store, "/p.ts");
      expect(getSnapshot(store, "/p.ts", "x\n")).toBeUndefined();
    });
  });

  it("prunes missing snapshots", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertSnapshot(store, "/gone.ts", contentChecksum("old\n"), "old\n".split("\n").length, ["ZZZ"]);
      await pruneMissing(store);
      expect(getSnapshot(store, "/gone.ts", "old\n")).toBeUndefined();
    });
  });

  it("persists data across shutdown and reload", async () => {
    await withTempHome(async () => {
      const a = await loadHashStore();
      expect(a.engine).toBe("sql.js");
      upsertSnapshot(a, "/first.ts", contentChecksum("one\n"), "one\n".split("\n").length, ["1"]);
      shutdownHashStore();

      const b = await loadHashStore();
      expect(b.engine).toBe("sql.js");
      upsertSnapshot(b, "/second.ts", contentChecksum("two\n"), "two\n".split("\n").length, ["2"]);
      shutdownHashStore();

      const c = await loadHashStore();
      expect(c.engine).toBe("sql.js");
      expect(getSnapshot(c, "/first.ts", "one\n")).toEqual(["1"]);
      expect(getSnapshot(c, "/second.ts", "two\n")).toEqual(["2"]);
    });
  });

  it("creates a sqlite file on first load", async () => {
    await withTempHome(async (home) => {
      await loadHashStore();
      expect(existsSync(sqlitePath(home))).toBe(true);
    });
  });

  it("creates the config directory", async () => {
    await withTempHome(async () => {
      await loadHashStore();
      const { stat } = await import("fs/promises");
      const s = await stat(configHome(tmpHome));
      expect(s.isDirectory()).toBe(true);
    });
  });
});
