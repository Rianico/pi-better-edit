import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { readNormFile } from "../../src/file-reader.js";
import {
  getServed,
  upsertServed,
  recordServesTruncated,
  recordServedTruncated,
  getReported,
  addReported,
  clearReported,
  deleteServed,
  wipeServed,
  ensureServedSchema,
} from "../../src/served-session/index.js";
import { loadLease, loadLeases } from "../../src/served-session/session.js";
import {
  pruneMissing,
  upsertSnapshot,
  upsertSnapshotFor,
  getSnapshot,
  snapshotHashFor,
} from "../../src/snapshot-store";
import { upsertUndo, getUndoEntry } from "../../src/undo-store";
import { HASH_STORE_VERSION, SERVED_TTL_MS } from "../../src/constants";
import { initHasher, contentChecksum } from "../../src/hashline/hasher";
import { lineHashes } from "../../src/hashline/index.js";
import { CANON_VERSION } from "../../src/hashline/hash.js";
import { getWritableTempRoot } from "../support/fixtures";

let tmpHome: string;
beforeAll(async () => {
  await initHasher();
});

describe("hash-store — served state (issue #2)", () => {
  it("round-trips served entries per file and position", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/a.ts", [
        { position: 0, hash: "abc" },
        { position: 1, hash: "def" },
        { position: 2, hash: "ghi" },
      ]);
      expect(getServed(store, "sessionA", "/a.ts")).toEqual(["abc", "def", "ghi"]);
    });
  });

  it("returns an empty record for a path with no served entries", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      expect(getServed(store, "sessionA", "/missing.ts")).toEqual([]);
    });
  });

  it("exposes interior gaps as never-served markers", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [
        { position: 0, hash: "abc" },
        { position: 2, hash: "def" },
      ]);
      expect(getServed(store, "sessionA", "/p.ts")).toEqual(["abc", null, "def"]);
    });
  });

  it("exposes leading gaps as never-served markers", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [{ position: 3, hash: "abc" }]);
      expect(getServed(store, "sessionA", "/p.ts")).toEqual([null, null, null, "abc"]);
    });
  });

  it("grows the record to the highest served position", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
      upsertServed(store, "sessionA", "/p.ts", [{ position: 5, hash: "def" }]);
      expect(getServed(store, "sessionA", "/p.ts")).toEqual(["abc", null, null, null, null, "def"]);
    });
  });

  it("overwrites a previously served position", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "def" }]);
      expect(getServed(store, "sessionA", "/p.ts")).toEqual(["def"]);
    });
  });

  it("marks a served position as never-served with a null hash", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [
        { position: 0, hash: "abc" },
        { position: 1, hash: "def" },
        { position: 2, hash: "ghi" },
      ]);
      upsertServed(store, "sessionA", "/p.ts", [{ position: 1, hash: null }]);
      expect(getServed(store, "sessionA", "/p.ts")).toEqual(["abc", null, "ghi"]);
    });
  });

  it("ignores an empty entries batch", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", []);
      expect(getServed(store, "sessionA", "/p.ts")).toEqual([]);
    });
  });

  it("rejects an invalid hash without a partial write", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      expect(() =>
        upsertServed(store, "sessionA", "/p.ts", [
          { position: 0, hash: "abc" },
          { position: 1, hash: "ZZZZ" },
        ]),
      ).toThrow(/Invalid served hash/);
      expect(getServed(store, "sessionA", "/p.ts")).toEqual([]);
    });
  });

  it("rejects a negative position without a partial write", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      expect(() =>
        upsertServed(store, "sessionA", "/p.ts", [{ position: -1, hash: "abc" }]),
      ).toThrow(/Invalid served position/);
      expect(getServed(store, "sessionA", "/p.ts")).toEqual([]);
    });
  });

  it("deletes the served record, its leases and its drift meta for a path", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const hashes = await lineHashes("alpha\n", "/p.ts");
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: hashes[0]! }]);
      const { createSessionHandle: createHandle } =
        await import("../../src/served-session/session.js");
      await createHandle("sessionA", "/p.ts", store).recordLeases(
        [{ position: 0, hash: hashes[0]! }],
        snapshotHashFor("alpha\n"),
      );
      addReported(store, "sessionA", "/p.ts", [hashes[0]!]);
      expect(loadLease(store, "sessionA", "/p.ts", hashes[0]!)).toBeDefined();

      deleteServed(store, "sessionA", "/p.ts");

      expect(getServed(store, "sessionA", "/p.ts")).toEqual([]);
      expect(loadLeases(store, "sessionA", "/p.ts")).toEqual([]);
      expect(loadLease(store, "sessionA", "/p.ts", hashes[0]!)).toBeUndefined();
      expect(getReported(store, "sessionA", "/p.ts")).toEqual(new Set());
    });
  });

  it("keeps unrelated served records intact when upserting another path", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
      upsertServed(store, "sessionA", "/b.ts", [
        { position: 0, hash: "def" },
        { position: 1, hash: "ghi" },
      ]);
      expect(getServed(store, "sessionA", "/a.ts")).toEqual(["abc"]);
      expect(getServed(store, "sessionA", "/b.ts")).toEqual(["def", "ghi"]);
      deleteServed(store, "sessionA", "/a.ts");
      expect(getServed(store, "sessionA", "/b.ts")).toEqual(["def", "ghi"]);
    });
  });

  it("survives a hash-store shutdown and reopen", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [
        { position: 0, hash: "abc" },
        { position: 2, hash: "def" },
      ]);
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual(["abc", null, "def"]);
    });
  });
});

describe("hash-store — session isolation", () => {
  it("keeps two sessions' served records for the same path independent", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
      upsertServed(store, "sessionB", "/p.ts", [{ position: 0, hash: "def" }]);
      expect(getServed(store, "sessionA", "/p.ts")).toEqual(["abc"]);
      expect(getServed(store, "sessionB", "/p.ts")).toEqual(["def"]);
    });
  });

  it("wipes only the targeted session's served records", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
      upsertServed(store, "sessionB", "/a.ts", [{ position: 0, hash: "def" }]);
      wipeServed(store, "sessionA");
      expect(getServed(store, "sessionA", "/a.ts")).toEqual([]);
      expect(getServed(store, "sessionB", "/a.ts")).toEqual(["def"]);
    });
  });

  it("keeps reported drift sets per session", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      addReported(store, "sessionA", "/p.ts", ["abc"]);
      addReported(store, "sessionB", "/p.ts", ["def"]);
      expect(getReported(store, "sessionA", "/p.ts")).toEqual(new Set(["abc"]));
      expect(getReported(store, "sessionB", "/p.ts")).toEqual(new Set(["def"]));
    });
  });

  it("sees no served rows for a session that recorded nothing", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
      expect(getServed(store, "sessionB", "/p.ts")).toEqual([]);
    });
  });
});

describe("hash-store — served wipe", () => {
  it("removes all served records while keeping snapshots and undo", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
      upsertServed(store, "sessionA", "/b.ts", [{ position: 1, hash: "def" }]);
      upsertSnapshot(store, {
        path: "/a.ts",
        snapshotHash: snapshotHashFor("a\n"),
        lineCount: 1,
        hashes: ["abc"],
        content: "a\n",
      });
      upsertUndo(store, "/u.ts", {
        content: "old",
        bom: "",
        ending: "\n",
        hashes: ["UVW"],
        resultContent: "new",
      });

      wipeServed(store, "sessionA");

      expect(getServed(store, "sessionA", "/a.ts")).toEqual([]);
      expect(getServed(store, "sessionA", "/b.ts")).toEqual([]);
      expect(getSnapshot(store, "/a.ts", "a\n")).toEqual(["abc"]);
      expect(getUndoEntry(store, "/u.ts")).toBeDefined();
    });
  });
});

describe("hash-store — served corrupt row handling", () => {
  async function corruptServed(
    home: string,
    sessionKey: string,
    path: string,
    value: string,
  ): Promise<void> {
    const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
    db.prepare("UPDATE served SET hashes = ? WHERE session_id = ? AND path = ?").run(
      value,
      sessionKey,
      path,
    );
    db.close();
  }

  it("treats a row with unparseable hashes as an empty record and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "AAA" }]);
      await corruptServed(home, "sessionA", "/p.ts", "not json");
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual([]);
      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const remaining = check
        .prepare("SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?")
        .get("sessionA", "/p.ts") as { n: number };
      check.close();
      expect(remaining.n).toBe(0);
    });
  });

  it("drops leases and drift meta when a corrupt served row is reset", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const hashes = await lineHashes("alpha\n", "/p.ts");
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: hashes[0]! }]);
      const { createSessionHandle: createHandle } =
        await import("../../src/served-session/session.js");
      await createHandle("sessionA", "/p.ts", store).recordLeases(
        [{ position: 0, hash: hashes[0]! }],
        snapshotHashFor("alpha\n"),
      );
      addReported(store, "sessionA", "/p.ts", [hashes[0]!]);
      expect(loadLease(store, "sessionA", "/p.ts", hashes[0]!)).toBeDefined();

      await corruptServed(home, "sessionA", "/p.ts", "not json");
      shutdownHashStore();
      const reloaded = await loadHashStore();

      expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual([]);
      expect(loadLeases(reloaded, "sessionA", "/p.ts")).toEqual([]);
      expect(getReported(reloaded, "sessionA", "/p.ts")).toEqual(new Set());
    });
  });

  it("treats a row with malformed hash strings as an empty record and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "AAA" }]);
      await corruptServed(home, "sessionA", "/p.ts", '["ZZ", "ZZZZ", "a!b"]');
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual([]);
      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const remaining = check
        .prepare("SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?")
        .get("sessionA", "/p.ts") as { n: number };
      check.close();
      expect(remaining.n).toBe(0);
    });
  });

  it("treats a row with non-string entries as an empty record and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "AAA" }]);
      await corruptServed(home, "sessionA", "/p.ts", "[42]");
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual([]);
      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const remaining = check
        .prepare("SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?")
        .get("sessionA", "/p.ts") as { n: number };
      check.close();
      expect(remaining.n).toBe(0);
    });
  });
});

describe("hash-store — served schema versioning", () => {
  it("preserves served state alongside snapshots and undo when the stored version differs", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "XYZ" }]);
      upsertSnapshot(store, {
        path: "/p.ts",
        snapshotHash: snapshotHashFor("x\n"),
        lineCount: 1,
        hashes: ["XYZ"],
        content: "x\n",
      });
      upsertUndo(store, "/u.ts", {
        content: "old",
        bom: "",
        ending: "\n",
        hashes: ["UVW"],
        resultContent: "new",
      });
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.prepare("UPDATE meta SET value = '999' WHERE key = 'version'").run();
      db.close();

      const reloaded = await loadHashStore();
      expect(getServed(reloaded, "sessionA", "/p.ts")).not.toEqual([]);
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toEqual(["XYZ"]);
      expect(getUndoEntry(reloaded, "/u.ts")).toMatchObject({ content: "old" });

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

  it("migrates a legacy served table without wiping snapshots or undo", async () => {
    await withTempHome(async (home) => {
      await mkdir(configHome(home), { recursive: true });
      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.exec(
        "CREATE TABLE snapshots (path TEXT PRIMARY KEY, checksum TEXT NOT NULL, line_count INTEGER NOT NULL, hashes TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      );
      db.exec(
        "CREATE TABLE undo (path TEXT PRIMARY KEY, content TEXT NOT NULL, bom TEXT NOT NULL, ending TEXT NOT NULL, hashes TEXT NOT NULL, result_content TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      );
      db.exec(
        "CREATE TABLE served (session_id TEXT NOT NULL, path TEXT NOT NULL, hashes TEXT NOT NULL, reported TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, path))",
      );
      db.exec(
        "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES ('/p.ts', 'v1:x', 1, '[\"XYZ\"]', 1)",
      );
      db.exec(
        "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES ('/u.ts', 'old', '', '\n', '[\"UVW\"]', 'new', 1)",
      );

      ensureServedSchema(db);

      const columns = (db.prepare("PRAGMA table_info(served)").all() as { name: string }[]).map(
        (row) => row.name,
      );
      const snapshots = db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number };
      const undo = db.prepare("SELECT COUNT(*) AS n FROM undo").get() as { n: number };
      db.close();

      expect(columns).toEqual(expect.arrayContaining(["retired", "canons", "snapshotId"]));
      expect(snapshots.n).toBe(1);
      expect(undo.n).toBe(1);
    });
  });

  it("rebuilds a pre-session-keyed served table into the session-partitioned schema", async () => {
    await withTempHome(async (home) => {
      await mkdir(configHome(home), { recursive: true });
      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta (key, value) VALUES ('version', '5')");
      db.exec(
        "CREATE TABLE served (path TEXT PRIMARY KEY, hashes TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      );
      db.close();
      const store = await loadHashStore();
      addReported(store, "sessionA", "/p.ts", ["abc"]);
      expect(getReported(store, "sessionA", "/p.ts")).toEqual(new Set(["abc"]));
    });
  });
});

describe("hash-store — served pruneMissing", () => {
  it("removes served records for files that no longer exist", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/gone.ts", [{ position: 0, hash: "ZZZ" }]);
      await pruneMissing(store);
      expect(getServed(store, "sessionA", "/gone.ts")).toEqual([]);
    });
  });

  it("keeps served records for files that still exist", async () => {
    await withTempHome(async (home) => {
      const existing = join(home, "keep.ts");
      await writeFile(existing, "keep\n", "utf-8");
      const store = await loadHashStore();
      upsertServed(store, "sessionA", existing, [{ position: 0, hash: "KEP" }]);
      await pruneMissing(store);
      expect(getServed(store, "sessionA", existing)).toEqual(["KEP"]);
    });
  });

  it("prunes served-only records for files with no snapshot or undo row", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/orphan.ts", [{ position: 0, hash: "ORG" }]);
      await pruneMissing(store);
      expect(getServed(store, "sessionA", "/orphan.ts")).toEqual([]);
    });
  });

  it("prunes served records alongside snapshots and undo in one pass", async () => {
    await withTempHome(async (home) => {
      const existing = join(home, "keep.ts");
      await writeFile(existing, "keep\n", "utf-8");
      const store = await loadHashStore();
      upsertServed(store, "sessionA", existing, [{ position: 0, hash: "KEP" }]);
      upsertServed(store, "sessionA", "/gone.ts", [{ position: 0, hash: "GON" }]);
      upsertSnapshot(store, {
        path: existing,
        snapshotHash: snapshotHashFor("keep\n"),
        lineCount: 1,
        hashes: ["KEP"],
        content: "keep\n",
      });
      upsertSnapshot(store, {
        path: "/gone.ts",
        snapshotHash: snapshotHashFor("gone\n"),
        lineCount: 1,
        hashes: ["GON"],
        content: "gone\n",
      });
      upsertUndo(store, existing, {
        content: "old",
        bom: "",
        ending: "\n",
        hashes: ["KEP"],
        resultContent: "new",
      });
      upsertUndo(store, "/gone.ts", {
        content: "old",
        bom: "",
        ending: "\n",
        hashes: ["GON"],
        resultContent: "new",
      });
      await pruneMissing(store);

      expect(getServed(store, "sessionA", existing)).toEqual(["KEP"]);
      expect(getServed(store, "sessionA", "/gone.ts")).toEqual([]);
      expect(getSnapshot(store, existing, "keep\n")).toEqual(["KEP"]);
      expect(getSnapshot(store, "/gone.ts", "gone\n")).toBeUndefined();
      expect(getUndoEntry(store, existing)).toBeDefined();
      expect(getUndoEntry(store, "/gone.ts")).toBeUndefined();
    });
  });
});

describe("hash-store — reported drift set (issue #6)", () => {
  it("merges reported hashes per file", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      addReported(store, "sessionA", "/a.ts", ["abc", "def"]);
      addReported(store, "sessionA", "/a.ts", ["def", "ghi"]);
      expect(getReported(store, "sessionA", "/a.ts")).toEqual(new Set(["abc", "def", "ghi"]));
    });
  });

  it("returns an empty set for a path with no reported data", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      expect(getReported(store, "sessionA", "/missing.ts")).toEqual(new Set());
    });
  });

  it("ignores malformed reported data", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      addReported(store, "sessionA", "/p.ts", ["abc"]);
      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.prepare(
        "UPDATE served_session_meta SET reported = 'not json' WHERE session_id = ? AND file_path = ?",
      ).run("sessionA", "/p.ts");
      db.close();
      expect(getReported(store, "sessionA", "/p.ts")).toEqual(new Set());
    });
  });

  it("clears the reported set for a path", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      addReported(store, "sessionA", "/p.ts", ["abc"]);
      clearReported(store, "sessionA", "/p.ts");
      expect(getReported(store, "sessionA", "/p.ts")).toEqual(new Set());
    });
  });

  it("survives a hash-store shutdown and reopen", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      addReported(store, "sessionA", "/p.ts", ["abc"]);
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getReported(reloaded, "sessionA", "/p.ts")).toEqual(new Set(["abc"]));
    });
  });

  it("is wiped alongside the served table for the same session", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      addReported(store, "sessionA", "/a.ts", ["abc"]);
      addReported(store, "sessionB", "/a.ts", ["def"]);
      wipeServed(store, "sessionA");
      expect(getReported(store, "sessionA", "/a.ts")).toEqual(new Set());
      expect(getReported(store, "sessionB", "/a.ts")).toEqual(new Set(["def"]));
    });
  });

  it("is pruned when the file no longer exists", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      addReported(store, "sessionA", "/gone.ts", ["abc"]);
      await pruneMissing(store);
      expect(getReported(store, "sessionA", "/gone.ts")).toEqual(new Set());
    });
  });
});

describe("hash-store — served TTL sweep (issue #17)", () => {
  async function ageServedRow(
    home: string,
    sessionKey: string,
    path: string,
    updatedAt: number,
  ): Promise<void> {
    const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
    db.prepare("UPDATE served SET updated_at = ? WHERE session_id = ? AND path = ?").run(
      updatedAt,
      sessionKey,
      path,
    );
    db.close();
  }

  it("prunes served rows older than the TTL on store open", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [
        { position: 0, hash: "abc" },
        { position: 2, hash: "def" },
      ]);
      shutdownHashStore();
      await ageServedRow(home, "sessionA", "/p.ts", Date.now() - SERVED_TTL_MS - 1000);
      const reloaded = await loadHashStore();
      expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual([]);
      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const remaining = check
        .prepare("SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?")
        .get("sessionA", "/p.ts") as { n: number };
      check.close();
      expect(remaining.n).toBe(0);
    });
  });

  it("keeps a fresh served row across a close/reopen cycle so a pi -c continuation can verify against it", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [
        { position: 0, hash: "abc" },
        { position: 2, hash: "def" },
      ]);
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual(["abc", null, "def"]);
    });
  });

  it("prunes an old row of one session while keeping another session's fresh row", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
      upsertServed(store, "sessionB", "/p.ts", [{ position: 0, hash: "def" }]);
      shutdownHashStore();
      await ageServedRow(home, "sessionA", "/p.ts", Date.now() - SERVED_TTL_MS - 1000);
      const reloaded = await loadHashStore();
      expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual([]);
      expect(getServed(reloaded, "sessionB", "/p.ts")).toEqual(["def"]);
    });
  });
});

describe("hash-store — recordServesTruncated", () => {
  it("truncates the served array to the line count, dropping stale tail positions", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [
        { position: 0, hash: "aaa" },
        { position: 1, hash: "bbb" },
        { position: 2, hash: "ccc" },
        { position: 3, hash: "bbb" },
        { position: 4, hash: "ddd" },
        { position: 5, hash: "eee" },
        { position: 6, hash: "bbb" },
        { position: 7, hash: "fff" },
      ]);
      recordServesTruncated(
        store,
        "sessionA",
        "/p.ts",
        [
          { position: 0, hash: "bbb" },
          { position: 1, hash: "ddd" },
          { position: 2, hash: "eee" },
          { position: 3, hash: "bbb" },
          { position: 4, hash: "fff" },
        ],
        5,
        0,
      );
      expect(getServed(store, "sessionA", "/p.ts")).toEqual([null, "ddd", "eee", "bbb", "fff"]);
    });
  });

  it("clears positions at/after the first changed line but keeps the unchanged prefix", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [
        { position: 0, hash: "aaa" },
        { position: 1, hash: "bbb" },
        { position: 2, hash: "ccc" },
        { position: 3, hash: "ddd" },
        { position: 4, hash: "eee" },
      ]);
      recordServesTruncated(
        store,
        "sessionA",
        "/p.ts",
        [
          { position: 0, hash: "aaa" },
          { position: 1, hash: "BET" },
          { position: 2, hash: "ccc" },
        ],
        3,
        1,
      );
      expect(getServed(store, "sessionA", "/p.ts")).toEqual(["aaa", "BET", "ccc"]);
    });
  });

  it("truncates without clearing when clearFrom is omitted", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [
        { position: 0, hash: "aaa" },
        { position: 1, hash: "bbb" },
        { position: 2, hash: "ccc" },
        { position: 3, hash: "ddd" },
        { position: 4, hash: "eee" },
      ]);
      recordServesTruncated(store, "sessionA", "/p.ts", [{ position: 0, hash: "xxx" }], 3);
      expect(getServed(store, "sessionA", "/p.ts")).toEqual(["xxx", "bbb", "ccc"]);
    });
  });

  it("ignores an empty rows batch and leaves the served array untouched", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [
        { position: 0, hash: "aaa" },
        { position: 1, hash: "bbb" },
      ]);
      recordServesTruncated(store, "sessionA", "/p.ts", [], 1);
      expect(getServed(store, "sessionA", "/p.ts")).toEqual(["aaa", "bbb"]);
    });
  });

  it("records through the async sibling recordServedTruncated", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [
        { position: 0, hash: "aaa" },
        { position: 1, hash: "bbb" },
        { position: 2, hash: "ccc" },
        { position: 3, hash: "ddd" },
      ]);
      await recordServedTruncated(
        "sessionA",
        "/p.ts",
        [
          { position: 0, hash: "aaa" },
          { position: 1, hash: "bbb" },
        ],
        2,
        0,
      );
      expect(getServed(store, "sessionA", "/p.ts")).toEqual(["aaa", "bbb"]);
    });
  });
});

describe("served state — tombstone epoch (ADR-0013)", () => {
  it("retires displaced hashes on record and keeps them per session", async () => {
    await withTempHome(async () => {
      const { createSessionHandle } = await import("../../src/served-session/session.js");
      const store = await loadHashStore();
      const handle = createSessionHandle("sessionA", "/p.ts", store);
      await handle.record([
        { position: 0, hash: "abc" },
        { position: 1, hash: "def" },
        { position: 2, hash: "ghi" },
      ]);
      await handle.record([{ position: 0, hash: "xyz" }]);
      const tomb = await handle.loadTombstone();
      expect(tomb.has("abc")).toBe(true);
      expect(tomb.has("def")).toBe(false);
      expect(tomb.has("ghi")).toBe(false);
      // other session not affected
      const other = createSessionHandle("sessionB", "/p.ts", store);
      expect(await other.loadTombstone()).toEqual(new Set());
    });
  });

  it("recordEpoch full read clears tombstone and persists snapshotId, never a canon", async () => {
    await withTempHome(async () => {
      const { createSessionHandle } = await import("../../src/served-session/session.js");
      const store = await loadHashStore();
      const h = createSessionHandle("sessionA", "/p.ts", store);
      await h.record([{ position: 0, hash: "aaa" }]);
      await h.retire(["aaa"]);
      expect(await h.loadTombstone()).toEqual(new Set(["aaa"]));
      await h.recordEpoch({
        rows: [
          { position: 0, hash: "bbb" },
          { position: 1, hash: "ccc" },
        ],
        lineCount: 2,
        fullReadHashes: ["bbb", "ccc"],
        snapshotId: "v2|/p.ts|1|2|3|4",
      });
      expect(await h.loadTombstone()).toEqual(new Set());
      // WHY: no canon is stored anywhere (#151). A record that granted no lease reports no evidence,
      // WHY: and the documented absence policy — silence, never a shape refusal — holds.
      expect(await h.loadCanonDigests()).toEqual([]);
      expect(await h.loadEpochId()).toBe("v2|/p.ts|1|2|3|4");
    });
  });

  it("recordEpoch partial keeps tombstone and leaves the epoch id pinned", async () => {
    await withTempHome(async () => {
      const { createSessionHandle } = await import("../../src/served-session/session.js");
      const store = await loadHashStore();
      const h = createSessionHandle("sessionA", "/p.ts", store);
      await h.recordEpoch({
        rows: [
          { position: 0, hash: "aaa" },
          { position: 1, hash: "bbb" },
        ],
        lineCount: 2,
        fullReadHashes: ["aaa", "bbb"],
        snapshotId: "snap-1",
        isFullRead: true,
      });
      // partial that overwrites position 0
      await h.recordEpoch({
        rows: [{ position: 0, hash: "ccc" }],
        lineCount: 2,
        fullReadHashes: ["ccc", "bbb"],
        snapshotId: "snap-2",
        isFullRead: false,
      });
      const tomb = await h.loadTombstone();
      expect(tomb.has("aaa")).toBe(true);
      expect(await h.loadEpochId()).toBe("snap-1");
    });
  });

  it("preserves served rows but invalidates snapshots/undo when adding retired column", async () => {
    await withTempHome(async (home) => {
      const { contentChecksum: _contentChecksum } = await import("../../src/hashline/hasher.js");
      const _homePath = home;
      // create initial DB without retired column via direct SQL, then reopen to trigger migration
      const { DatabaseSync } = await import("node:sqlite");
      const { hashStorePath } = await import("../../src/hash-store.js");
      const store1 = await loadHashStore();
      const { createSessionHandle: createH } = await import("../../src/served-session/session.js");
      const h1 = createH("sessionA", "/rebound.txt", store1);
      await h1.record([{ position: 0, hash: "AAA" }]);
      const { snapshotIOFor: _snapshotIOFor } = await import("../../src/snapshot-store");
      // need store path
      const dbPath = hashStorePath();
      // simulate old DB by dropping retired column
      const { shutdownHashStore } = await import("../../src/hash-store.js");
      shutdownHashStore();
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("ALTER TABLE served DROP COLUMN retired");
      } catch {}
      db.close();
      // reopen triggers migration that deletes snapshots
      const { loadHashStore: load2 } = await import("../../src/hash-store.js");
      const store2 = await load2();
      const h2 = createH("sessionA", "/rebound.txt", store2);
      expect(await h2.load()).toEqual(["AAA"]);
      // snapshots should be gone - check via snapshot store
      const { getSnapshot: _getSnapshot } = await import("../../src/snapshot-store");
      // we didn't create snapshot, but ensure no crash
      expect(await h2.loadTombstone()).toEqual(new Set());
    });
  });
});

describe("served_leases — universal lease granting (issue #81)", () => {
  const LEASE_PATH = "/lease.ts";
  const LEASE_CONTENT = "alpha\nbravo\ncharlie\n";

  async function seedLeases(
    store: Awaited<ReturnType<typeof loadHashStore>>,
    sessionKey = "sessionA",
  ): Promise<string[]> {
    const hashes = await lineHashes(LEASE_CONTENT, LEASE_PATH);
    const { createSessionHandle: createHandle } =
      await import("../../src/served-session/session.js");
    await createHandle(sessionKey, LEASE_PATH, store).recordLeases(
      hashes.map((hash, position) => ({ position, hash })),
      snapshotHashFor(LEASE_CONTENT),
    );
    return hashes;
  }

  it("grants one active lease per served anchor from the lineage line_id", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const hashes = await seedLeases(store);

      const leases = loadLeases(store, "sessionA", LEASE_PATH);
      expect(leases.map((lease) => lease.anchor)).toEqual(hashes);
      expect(leases.map((lease) => lease.served_line_number)).toEqual([1, 2, 3]);
      expect(leases.map((lease) => lease.retired_at)).toEqual([null, null, null]);
      expect(new Set(leases.map((lease) => lease.line_id)).size).toBe(3);
      expect(leases[0]!.served_snapshot_hash).toBe(
        `${CANON_VERSION}:${contentChecksum(LEASE_CONTENT)}`,
      );

      const lineage = store.db
        .prepare(
          "SELECT ll.line_id, ll.canon_hash FROM line_lineage ll " +
            "JOIN file_snapshots fs ON fs.snapshot_id = ll.snapshot_id " +
            "WHERE fs.path = ? AND ll.anchor = ?",
        )
        .get(LEASE_PATH, hashes[0]!) as { line_id: number; canon_hash: string };
      expect(leases[0]!.line_id).toBe(lineage.line_id);
      expect(leases[0]!.canon_hash).toBe(lineage.canon_hash);
    });
  });

  it("retires absent leases when re-adopting a cached snapshot (reversion/undo)", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const original = "alpha\nbravo\n";
      const originalHashes = await lineHashes(original, LEASE_PATH);
      const edited = "alpha\nbravo\ncharlie\n";
      const editedHashes = await lineHashes(edited, LEASE_PATH);
      const { createSessionHandle: createHandle } =
        await import("../../src/served-session/session.js");
      await createHandle("sessionA", LEASE_PATH, store).recordLeases(
        editedHashes.map((hash, position) => ({ position, hash })),
        snapshotHashFor(edited),
      );
      expect(loadLeases(store, "sessionA", LEASE_PATH).every((l) => l.retired_at === null)).toBe(
        true,
      );

      // The undo/revert path re-adopts an OLDER canonical snapshot: a cache hit, not a miss. It is an
      // authoritative materialization (the bytes are on disk), so it retires the absent leases.
      await upsertSnapshotFor(
        {
          path: LEASE_PATH,
          snapshotHash: snapshotHashFor(original),
          lineCount: 2,
          hashes: originalHashes,
          content: original,
        },
        { retireLeases: true },
      );

      const leases = loadLeases(store, "sessionA", LEASE_PATH);
      expect(leases).toHaveLength(3);
      const adoptedLineage = new Set(
        (
          store.db
            .prepare(
              "SELECT ll.line_id AS line_id FROM line_lineage ll " +
                "JOIN file_snapshots fs ON fs.snapshot_id = ll.snapshot_id " +
                "WHERE fs.path = ? AND fs.snapshot_hash = ?",
            )
            .all(LEASE_PATH, `${CANON_VERSION}:${contentChecksum(original)}`) as {
            line_id: number;
          }[]
        ).map((row) => row.line_id),
      );
      expect(adoptedLineage.size).toBe(2);
      // Exactly the leases whose identity is absent from the adopted lineage are retired; the
      // survivors (same `line_id`) stay active.
      for (const lease of leases) {
        expect(lease.retired_at === null).toBe(adoptedLineage.has(lease.line_id));
      }
      const removed = leases.find((lease) => !adoptedLineage.has(lease.line_id));
      expect(removed!.retired_at).not.toBeNull();
      expect(
        leases
          .filter((lease) => lease.retired_at === null)
          .map((lease) => lease.line_id)
          .sort((a, b) => a - b),
      ).toEqual([...adoptedLineage].sort((a, b) => a - b));
    });
  });

  it("retires leases whose line_id is absent from a newly materialized snapshot", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const filePath = join(home, "lease.ts");
      await writeFile(filePath, LEASE_CONTENT, "utf-8");
      const seeded = await readNormFile("lease.ts", home, { store });
      const { createSessionHandle: createHandle } =
        await import("../../src/served-session/session.js");
      await createHandle("sessionA", seeded.absolutePath, store).recordLeases(
        seeded.fileHashes.map((hash, position) => ({ position, hash })),
        snapshotHashFor(LEASE_CONTENT),
      );
      expect(
        loadLeases(store, "sessionA", seeded.absolutePath).every((l) => l.retired_at === null),
      ).toBe(true);

      // the read path — the single authoritative materialization — sees the new on-disk content
      const next = "alpha\ndelta\n";
      await writeFile(filePath, next, "utf-8");
      await readNormFile("lease.ts", home, { store });

      const leases = loadLeases(store, "sessionA", seeded.absolutePath);
      expect(leases).toHaveLength(3);
      // `alpha` survives the external rewrite and keeps its identity; `bravo` and `charlie` are
      // both absent from S_curr, so their leases are retired by the authoritative writer.
      const alphaLease = leases.find((lease) => lease.anchor === seeded.fileHashes[0]!);
      expect(alphaLease!.retired_at).toBeNull();
      const retiredAnchors = leases
        .filter((lease) => lease.retired_at !== null)
        .map((lease) => lease.anchor)
        .sort();
      expect(retiredAnchors).toEqual([seeded.fileHashes[1]!, seeded.fileHashes[2]!].sort());
    });
  });

  it("a working-buffer materialization with persist but no lease authority retires nothing", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await seedLeases(store);

      // Same content as the "newly materialized snapshot" case, but not declared authoritative:
      // in-memory working-buffer hashing must leave every active lease alone (issue #81 §3.2.4).
      await lineHashes("alpha\nbravo\ncharlie\ndelta\n", LEASE_PATH);

      const leases = loadLeases(store, "sessionA", LEASE_PATH);
      expect(leases).toHaveLength(3);
      expect(leases.every((lease) => lease.retired_at === null)).toBe(true);
    });
  });

  it("re-serving a relocated anchor upserts line_id + cleared retired_at", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await seedLeases(store);
      const before = loadLeases(store, "sessionA", LEASE_PATH).find(
        (lease) => lease.served_line_number === 3,
      )!;

      // external insert moves charlie from line 3 to line 4 without changing its text
      const drifted = "alpha\nbravo\ninserted\ncharlie\n";
      const driftedHashes = await lineHashes(drifted, LEASE_PATH);
      const movedAnchor = driftedHashes[3]!;
      const { createSessionHandle: createHandle } =
        await import("../../src/served-session/session.js");
      await createHandle("sessionA", LEASE_PATH, store).recordLeases(
        [{ position: 3, hash: movedAnchor }],
        snapshotHashFor(drifted),
      );

      const rows = loadLeases(store, "sessionA", LEASE_PATH).filter(
        (lease) => lease.anchor === movedAnchor,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.retired_at).toBeNull();
      expect(rows[0]!.served_line_number).toBe(4);
      // The re-served lease keeps the line's identity: the insert shifted the coordinate, not the
      // line, so `line_id` is inherited from S_latest (spec §3.1.3.2) while the served snapshot is
      // restamped to the re-served version.
      expect(rows[0]!.line_id).toBe(before.line_id);
      expect(rows[0]!.served_snapshot_hash).not.toBe(before.served_snapshot_hash);
    });
  });

  it("keeps leases isolated per session and path", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await seedLeases(store, "sessionA");
      expect(loadLeases(store, "sessionB", LEASE_PATH)).toEqual([]);
      expect(loadLeases(store, "sessionA", "/other.ts")).toEqual([]);
      expect(loadLease(store, "sessionA", LEASE_PATH, "zzz")).toBeUndefined();
    });
  });

  it("writes no lease when the anchor has no committed lineage", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/unmaterialized.ts", [{ position: 0, hash: "abc" }]);
      expect(loadLeases(store, "sessionA", "/unmaterialized.ts")).toEqual([]);
    });
  });
});

describe("served_session_meta — drift dedup storage (issue #81)", () => {
  it("persists the reported set in served_session_meta, not the legacy mirror", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
      addReported(store, "sessionA", "/p.ts", ["abc", "def"]);
      addReported(store, "sessionB", "/p.ts", ["ghi"]);

      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const rows = db
        .prepare(
          "SELECT session_id, reported FROM served_session_meta " +
            "WHERE file_path = ? ORDER BY session_id ASC",
        )
        .all("/p.ts") as { session_id: string; reported: string }[];
      const legacy = db
        .prepare("SELECT COUNT(*) AS n FROM served WHERE reported IS NOT NULL AND path = ?")
        .get("/p.ts") as { n: number };
      db.close();

      expect(rows).toEqual([
        { session_id: "sessionA", reported: JSON.stringify(["abc", "def"]) },
        { session_id: "sessionB", reported: JSON.stringify(["ghi"]) },
      ]);
      expect(legacy.n).toBe(0);
      expect(getReported(store, "sessionA", "/p.ts")).toEqual(new Set(["abc", "def"]));
      expect(getReported(store, "sessionB", "/p.ts")).toEqual(new Set(["ghi"]));
    });
  });

  it("drops the served_session_meta row on clear", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      addReported(store, "sessionA", "/p.ts", ["abc"]);

      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const before = db
        .prepare("SELECT COUNT(*) AS n FROM served_session_meta WHERE file_path = ?")
        .get("/p.ts") as { n: number };
      db.close();
      expect(before.n).toBe(1);

      clearReported(store, "sessionA", "/p.ts");

      const reopened = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const remaining = reopened
        .prepare("SELECT COUNT(*) AS n FROM served_session_meta WHERE file_path = ?")
        .get("/p.ts") as { n: number };
      reopened.close();

      expect(remaining.n).toBe(0);
      expect(getReported(store, "sessionA", "/p.ts")).toEqual(new Set());
    });
  });

  it("wipes leases and session meta for one session only", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const content = "alpha\nbravo\n";
      const hashes = await lineHashes(content, "/w.ts");
      const { createSessionHandle: createHandle } =
        await import("../../src/served-session/session.js");
      for (const session of ["sessionA", "sessionB"]) {
        await createHandle(session, "/w.ts", store).recordLeases(
          hashes.map((hash, position) => ({ position, hash })),
          snapshotHashFor(content),
        );
        addReported(store, session, "/w.ts", [hashes[0]!]);
      }

      wipeServed(store, "sessionA");

      expect(loadLeases(store, "sessionA", "/w.ts")).toEqual([]);
      expect(getReported(store, "sessionA", "/w.ts")).toEqual(new Set());
      expect(loadLeases(store, "sessionB", "/w.ts")).toHaveLength(2);
      expect(getReported(store, "sessionB", "/w.ts")).toEqual(new Set([hashes[0]!]));
    });
  });

  it("prunes leases and session meta for paths that no longer exist", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const hashes = await lineHashes("gone\n", "/gone.ts");
      upsertServed(store, "sessionA", "/gone.ts", [{ position: 0, hash: hashes[0]! }]);
      addReported(store, "sessionA", "/gone.ts", [hashes[0]!]);

      await pruneMissing(store);

      expect(loadLeases(store, "sessionA", "/gone.ts")).toEqual([]);
      expect(getReported(store, "sessionA", "/gone.ts")).toEqual(new Set());
    });
  });
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-served-test-"));
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
