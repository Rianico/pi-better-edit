import { describe, expect, it, beforeAll } from "vitest";
import { MemorySnapshotStore, SQLiteSnapshotStore } from "../../src/store";
import { initHasher, contentChecksum } from "../../src/hashline/hasher";
import { splitLines } from "../../src/utils";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { getWritableTempRoot } from "../support/fixtures";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { vi } from "vitest";

beforeAll(async () => {
  await initHasher();
});

describe("store — MemorySnapshotStore adapter", () => {
  it("round-trips a snapshot by path and content", () => {
    const mem = new MemorySnapshotStore();
    const content = "hello\nworld\n";
    const checksum = contentChecksum(content);
    const lineCount = splitLines(content).length;
    const hashes = ["aB3", "xY7"];
    mem.put("/p.ts", checksum, lineCount, hashes);
    expect(mem.get("/p.ts", checksum, lineCount)).toEqual(hashes);
  });

  it("returns undefined on checksum or lineCount mismatch", () => {
    const mem = new MemorySnapshotStore();
    mem.put("/p.ts", "cs1", 2, ["aaa"]);
    expect(mem.get("/p.ts", "cs2", 2)).toBeUndefined();
    expect(mem.get("/p.ts", "cs1", 3)).toBeUndefined();
  });

  it("deletes a snapshot", () => {
    const mem = new MemorySnapshotStore();
    mem.put("/p.ts", "cs", 1, ["aaa"]);
    mem.delete("/p.ts");
    expect(mem.get("/p.ts", "cs", 1)).toBeUndefined();
  });

  it("finds paths by hashes via allHashes()", () => {
    const mem = new MemorySnapshotStore();
    mem.put("/a.ts", "csa", 1, ["aaa", "bbb"]);
    mem.put("/b.ts", "csb", 1, ["bbb", "ccc"]);
    const rows = mem.allHashes();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/a.ts" }),
        expect.objectContaining({ path: "/b.ts" }),
      ]),
    );
    const matches = rows
      .filter((r) => {
        const parsed = JSON.parse(r.hashes);
        return ["bbb"].every((h) => parsed.includes(h));
      })
      .map((r) => r.path);
    expect(matches).toEqual(expect.arrayContaining(["/a.ts", "/b.ts"]));
  });

  it("tracks extra paths for pruneMissing parity", () => {
    const mem = new MemorySnapshotStore();
    mem.put("/snap.ts", "cs", 1, ["aaa"]);
    mem.__seedPath("/undo.ts");
    mem.__seedPath("/served.ts");
    const paths = mem.allPaths().map((p) => p.path);
    expect(paths).toEqual(expect.arrayContaining(["/snap.ts", "/undo.ts", "/served.ts"]));
  });

  it("SQLite and Memory adapters satisfy the same SnapshotStore contract", async () => {
    const mem = new MemorySnapshotStore();

    const home = await mkdtemp(join(await getWritableTempRoot(), "store-compare-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    try {
      const store = await loadHashStore();
      const sqlite = new SQLiteSnapshotStore(store.db);

      const checksum = contentChecksum("x\n");
      const lineCount = 1;
      const hashes = ["XYZ"];

      mem.put("/compare.ts", checksum, lineCount, hashes);
      sqlite.put("/compare.ts", checksum, lineCount, hashes);

      expect(mem.get("/compare.ts", checksum, lineCount)).toEqual(hashes);
      expect(sqlite.get("/compare.ts", checksum, lineCount)).toEqual(hashes);

      mem.delete("/compare.ts");
      sqlite.delete("/compare.ts");
      expect(mem.get("/compare.ts", checksum, lineCount)).toBeUndefined();
      expect(sqlite.get("/compare.ts", checksum, lineCount)).toBeUndefined();
    } finally {
      shutdownHashStore();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("store — withStore fail-loud", () => {
  it("throws when no store is open", async () => {
    const home = await mkdtemp(join(await getWritableTempRoot(), "store-fail-loud-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    try {
      shutdownHashStore();
      const { withStore } = await import("../../src/hash-store");
      expect(() => withStore(() => {})).toThrow(/requires an open SQLite store/);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("store — schema ownership", () => {
  it("creates snapshot, undo and served tables via domain ensureSchema hooks", async () => {
    const home = await mkdtemp(join(await getWritableTempRoot(), "store-schema-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    try {
      const store = await loadHashStore();
      const db = store.db;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const names = tables.map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(["snapshots", "undo", "served", "meta"]));
    } finally {
      shutdownHashStore();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("snapshot/undo/served ensureSchema are idempotent", async () => {
    const home = await mkdtemp(join(await getWritableTempRoot(), "store-idempotent-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    try {
      const store = await loadHashStore();
      const { ensureSnapshotSchema } = await import("../../src/snapshot-store");
      const { ensureUndoSchema } = await import("../../src/undo-store");
      const { ensureServedSchema } = await import("../../src/served-session/index.js");
      expect(() => ensureSnapshotSchema(store.db)).not.toThrow();
      expect(() => ensureUndoSchema(store.db)).not.toThrow();
      expect(() => ensureServedSchema(store.db)).not.toThrow();
      expect(() => ensureSnapshotSchema(store.db)).not.toThrow();
    } finally {
      shutdownHashStore();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});
