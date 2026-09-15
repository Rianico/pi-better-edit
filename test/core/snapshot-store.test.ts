import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

import { loadHashStore, shutdownHashStore, type HashStore } from "../../src/hash-store";
import {
  getSnapshot,
  upsertSnapshot,
  upsertSnapshotFor,
  snapshotHashFor,
  pruneMissing,
} from "../../src/snapshot-store";
import { upsertUndo, getUndoEntry } from "../../src/undo-store";
import { initHasher, contentChecksum, xxh32 } from "../../src/hashline/hasher";
import { CANON_VERSION, canon, _lineHashesPure, lineHashes } from "../../src/hashline";
import { splitLines } from "../../src/utils";
import { getWritableTempRoot } from "../support/fixtures";

let tmpHome: string;
beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-snapshot-test-"));
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

function openRaw(home: string): DatabaseSync {
  return new DatabaseSync(sqlitePath(home), { defensive: false } as any);
}

function put(store: HashStore, path: string, content: string, hashes: string[]): void {
  upsertSnapshot(store, {
    path,
    snapshotHash: snapshotHashFor(content),
    lineCount: splitLines(content).length,
    hashes,
    content,
  });
}

interface SnapshotRow {
  snapshot_id: number;
  snapshot_hash: string;
  line_count: number;
  committed: number;
}

interface LineageRow {
  line_number: number;
  line_id: number;
  canon_hash: string;
  anchor: string;
}

function snapshotRows(db: DatabaseSync, path: string): SnapshotRow[] {
  return db
    .prepare(
      "SELECT snapshot_id, snapshot_hash, line_count, committed FROM file_snapshots " +
        "WHERE path = ? ORDER BY snapshot_id ASC",
    )
    .all(path) as unknown as SnapshotRow[];
}

function counterRows(db: DatabaseSync, path: string): { next_id: number }[] {
  return db.prepare("SELECT next_id FROM line_id_counters WHERE path = ?").all(path) as unknown as {
    next_id: number;
  }[];
}

function lineageRows(db: DatabaseSync, path: string, snapshotHash: string): LineageRow[] {
  return db
    .prepare(
      "SELECT ll.line_number, ll.line_id, ll.canon_hash, ll.anchor FROM line_lineage ll " +
        "JOIN file_snapshots fs ON fs.snapshot_id = ll.snapshot_id " +
        "WHERE fs.path = ? AND fs.snapshot_hash = ? ORDER BY ll.line_number ASC",
    )
    .all(path, snapshotHash) as unknown as LineageRow[];
}

function nextId(db: DatabaseSync, path: string): number | undefined {
  const row = db.prepare("SELECT next_id FROM line_id_counters WHERE path = ?").get(path) as
    | { next_id: number }
    | undefined;
  return row?.next_id;
}

function canonHashOf(line: string): string {
  return String(xxh32(canon(line)));
}

function standardizedHash(content: string): string {
  return `${CANON_VERSION}:${contentChecksum(content)}`;
}

describe("snapshot-store — normalized CAS snapshot get / upsert", () => {
  it("round-trips a snapshot through file_snapshots and line_lineage", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const content = "hello\nworld\n";
      const hashes = ["aB3", "xY7"];
      put(store, "/path/to/file.ts", content, hashes);

      expect(getSnapshot(store, "/path/to/file.ts", content)).toEqual(hashes);

      const db = openRaw(home);
      try {
        const snapshots = snapshotRows(db, "/path/to/file.ts");
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]!.snapshot_hash).toBe(standardizedHash(content));
        expect(snapshots[0]!.line_count).toBe(2);
        expect(snapshots[0]!.committed).toBe(1);

        const lineage = lineageRows(db, "/path/to/file.ts", snapshots[0]!.snapshot_hash);
        expect(lineage.map((row) => row.anchor)).toEqual(hashes);
        expect(lineage.map((row) => row.line_number)).toEqual([1, 2]);
        expect(lineage.map((row) => row.line_id)).toEqual([1, 2]);
        expect(lineage.map((row) => row.canon_hash)).toEqual([
          canonHashOf("hello"),
          canonHashOf("world"),
        ]);
        expect(nextId(db, "/path/to/file.ts")).toBe(3);
      } finally {
        db.close();
      }
    });
  });

  it("accepts one cohesive descriptor on both upsert seams", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const content = "alpha\nbravo\n";
      const hashes = ["aB3", "xY7"];
      upsertSnapshot(store, {
        path: "/descriptor.ts",
        snapshotHash: standardizedHash(content),
        lineCount: 2,
        hashes,
        content,
      });
      expect(getSnapshot(store, "/descriptor.ts", content)).toEqual(hashes);

      const other = "charlie\n";
      await upsertSnapshotFor({
        path: "/descriptor-async.ts",
        snapshotHash: snapshotHashFor(other),
        lineCount: 1,
        hashes: ["zZ9"],
        content: other,
      });
      expect(getSnapshot(store, "/descriptor-async.ts", other)).toEqual(["zZ9"]);

      const db = openRaw(home);
      try {
        expect(snapshotRows(db, "/descriptor.ts")[0]!.snapshot_hash).toBe(
          standardizedHash(content),
        );
        expect(snapshotRows(db, "/descriptor-async.ts")[0]!.snapshot_hash).toBe(
          snapshotHashFor(other),
        );
      } finally {
        db.close();
      }
    });
  });

  it("returns undefined on a checksum miss and allocates zero line ids", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      put(store, "/p.ts", "aaa\nbbb\n", ["aB3", "xY7"]);

      expect(getSnapshot(store, "/p.ts", "aaa\nbbb\n")).toEqual(["aB3", "xY7"]);

      const db = openRaw(home);
      const before = nextId(db, "/p.ts");
      db.close();

      expect(getSnapshot(store, "/p.ts", "aaa\nBBB\n")).toBeUndefined();

      const after = openRaw(home);
      expect(nextId(after, "/p.ts")).toBe(before);
      after.close();
    });
  });

  it("keeps each committed version addressable and inherits surviving line_ids", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const first = "one\ntwo\nthree\n";
      const second = "one\ntwo\n";
      put(store, "/p.ts", first, ["111", "222", "333"]);
      put(store, "/p.ts", second, ["111", "222"]);

      const db = openRaw(home);
      try {
        const snapshots = snapshotRows(db, "/p.ts");
        expect(snapshots.map((row) => row.snapshot_hash)).toEqual([
          standardizedHash(first),
          standardizedHash(second),
        ]);
        const firstBlock = lineageRows(db, "/p.ts", standardizedHash(first)).map((r) => r.line_id);
        const secondBlock = lineageRows(db, "/p.ts", standardizedHash(second)).map(
          (r) => r.line_id,
        );
        expect(firstBlock).toEqual([1, 2, 3]);
        // Survivors inherit their exact previous `line_id`s (spec §3.1.3.2), so deleting the
        // trailing line allocates nothing and the counter does not move.
        expect(secondBlock).toEqual([1, 2]);
        expect(nextId(db, "/p.ts")).toBe(4);

        expect(getSnapshot(store, "/p.ts", first)).toEqual(["111", "222", "333"]);
        expect(getSnapshot(store, "/p.ts", second)).toEqual(["111", "222"]);
        expect(getSnapshot(store, "/p.ts", "one\n")).toBeUndefined();
      } finally {
        db.close();
      }
    });
  });

  it("keeps allocations strictly monotonic without rewinding across many versions", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const counters: number[] = [];
      for (let i = 0; i < 5; i++) {
        const content = "line\n".repeat(i + 1);
        put(store, "/grow.ts", content, ["AAA"]);
        const db = openRaw(home);
        counters.push(nextId(db, "/grow.ts")!);
        db.close();
      }
      for (let i = 1; i < counters.length; i++) {
        expect(counters[i]).toBeGreaterThan(counters[i - 1]!);
      }

      const db = openRaw(home);
      const blocks = snapshotRows(db, "/grow.ts").map((row) =>
        lineageRows(db, "/grow.ts", row.snapshot_hash).map((r) => r.line_id),
      );
      db.close();
      for (let i = 1; i < blocks.length; i++) {
        expect(blocks[i]!.length).toBeGreaterThan(0);
        expect(Math.min(...blocks[i]!)).toBeGreaterThan(Math.max(...blocks[i - 1]!));
      }
    });
  });

  it("allocates an independent monotonic block per path", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      put(store, "/a.ts", "a1\na2\n", ["A1A", "A2A"]);
      put(store, "/b.ts", "b1\n", ["B1B"]);
      put(store, "/a.ts", "a3\n", ["A3A"]);

      const db = openRaw(home);
      try {
        expect(nextId(db, "/a.ts")).toBe(4);
        expect(nextId(db, "/b.ts")).toBe(2);
        expect(
          lineageRows(db, "/a.ts", standardizedHash("a3\n")).map((row) => row.line_id),
        ).toEqual([3]);
      } finally {
        db.close();
      }
    });
  });

  it("returns persisted anchors verbatim instead of recomputing them", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const content = "x\n";
      put(store, "/p.ts", content, ["zZ9"]);

      expect(_lineHashesPure(content)).not.toEqual(["zZ9"]);
      expect(getSnapshot(store, "/p.ts", content)).toEqual(["zZ9"]);
    });
  });

  it("returns byte-identical anchor arrays on re-reads of unchanged content", async () => {
    await withTempHome(async () => {
      const content = "alpha\nbeta\ngamma\n";
      const first = await lineHashes(content, "/stable.ts");
      const second = await lineHashes(content, "/stable.ts");
      expect(second).toEqual(first);
    });
  });

  it("pre-allocates zero ids when the same content is upserted again", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const content = "same\n";
      put(store, "/p.ts", content, ["AAA"]);
      const db = openRaw(home);
      const before = nextId(db, "/p.ts");
      const beforeRows = snapshotRows(db, "/p.ts").length;
      db.close();

      put(store, "/p.ts", content, ["AAA"]);

      const after = openRaw(home);
      expect(nextId(after, "/p.ts")).toBe(before);
      expect(snapshotRows(after, "/p.ts").length).toBe(beforeRows);
      after.close();
      expect(getSnapshot(store, "/p.ts", content)).toEqual(["AAA"]);
    });
  });
});

describe("snapshot-store — corrupt lineage handling", () => {
  async function corruptAnchors(home: string, path: string, anchors: string[]): Promise<void> {
    const db = openRaw(home);
    const snapshot = db
      .prepare("SELECT snapshot_id FROM file_snapshots WHERE path = ?")
      .get(path) as { snapshot_id: number };
    const update = db.prepare(
      "UPDATE line_lineage SET anchor = ? WHERE snapshot_id = ? AND line_number = ?",
    );
    anchors.forEach((anchor, index) => update.run(anchor, snapshot.snapshot_id, index + 1));
    db.close();
  }

  function snapshotCount(home: string, path: string): number {
    const db = openRaw(home);
    const row = db.prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?").get(path) as {
      n: number;
    };
    db.close();
    return row.n;
  }

  it("treats a row with malformed anchors as a cache miss and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      put(store, "/p.ts", "x\ny\n", ["AAA", "BBB"]);
      await corruptAnchors(home, "/p.ts", ["ZZ", "ZZZZ"]);

      expect(getSnapshot(store, "/p.ts", "x\ny\n")).toBeUndefined();
      expect(snapshotCount(home, "/p.ts")).toBe(0);
    });
  });

  it("keeps a corrupt snapshot when deletion is suppressed", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      put(store, "/p.ts", "x\ny\n", ["AAA", "BBB"]);
      await corruptAnchors(home, "/p.ts", ["ZZ", "ZZZZ"]);

      expect(getSnapshot(store, "/p.ts", "x\ny\n", false)).toBeUndefined();
      expect(snapshotCount(home, "/p.ts")).toBe(1);
    });
  });

  it("treats a truncated lineage as a cache miss and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      put(store, "/p.ts", "x\ny\n", ["AAA", "BBB"]);
      const db = openRaw(home);
      db.prepare(
        "DELETE FROM line_lineage WHERE snapshot_id IN " +
          "(SELECT snapshot_id FROM file_snapshots WHERE path = ?) AND line_number = 2",
      ).run("/p.ts");
      db.close();

      expect(getSnapshot(store, "/p.ts", "x\ny\n")).toBeUndefined();
      expect(snapshotCount(home, "/p.ts")).toBe(0);
    });
  });
});

describe("snapshot-store — pruneMissing", () => {
  it("removes snapshots and their lineage for files that no longer exist", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      put(store, "/gone.ts", "old\n", ["ZZZ"]);
      await pruneMissing(store);
      expect(getSnapshot(store, "/gone.ts", "old\n")).toBeUndefined();

      const db = openRaw(home);
      const lineage = db
        .prepare(
          "SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id IN " +
            "(SELECT snapshot_id FROM file_snapshots WHERE path = ?)",
        )
        .get("/gone.ts") as { n: number };
      db.close();
      expect(lineage.n).toBe(0);
    });
  });

  it("removes undo entries for files that no longer exist", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      upsertUndo(store, "/gone.ts", {
        content: "old",
        bom: "",
        ending: "\n",
        hashes: ["ZZZ"],
        resultContent: "new",
      });
      await pruneMissing(store);
      expect(getUndoEntry(store, "/gone.ts")).toBeUndefined();
    });
  });

  it("keeps undo entries for files that still exist", async () => {
    await withTempHome(async (home) => {
      const existing = join(home, "keep.ts");
      await writeFile(existing, "keep\n", "utf-8");

      const store = await loadHashStore();
      upsertUndo(store, existing, {
        content: "old",
        bom: "",
        ending: "\n",
        hashes: ["KEP"],
        resultContent: "new",
      });
      await pruneMissing(store);
      expect(getUndoEntry(store, existing)).toBeDefined();
    });
  });

  it("keeps snapshots for files that still exist", async () => {
    await withTempHome(async (home) => {
      const existing = join(home, "keep.ts");
      await writeFile(existing, "keep\n", "utf-8");

      const store = await loadHashStore();
      put(store, existing, "keep\n", ["KEP"]);
      put(store, "/gone.ts", "gone\n", ["GON"]);
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
      put(store, keep, "keep\n", ["KEP"]);
      put(store, "/gone.ts", "gone\n", ["GON"]);
      put(store, grown, "grow\n", ["GRW"]);
      await pruneMissing(store);

      expect(getSnapshot(store, keep, "keep\n")).toEqual(["KEP"]);
      expect(getSnapshot(store, grown, "grow\n")).toEqual(["GRW"]);
      expect(getSnapshot(store, "/gone.ts", "gone\n")).toBeUndefined();
    });
  });

  it("prunes across multiple stat batches", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const existing: { path: string; hash: string }[] = [];
      for (let i = 0; i < 70; i++) {
        const path = join(home, `keep-${i}.ts`);
        await writeFile(path, "keep\n", "utf-8");
        const hash = `K${String(i).padStart(2, "0")}`;
        put(store, path, "keep\n", [hash]);
        existing.push({ path, hash });
      }
      for (let i = 0; i < 70; i++) {
        put(store, `/gone-${i}.ts`, "gone\n", [`G${String(i).padStart(2, "0")}`]);
      }
      await pruneMissing(store);
      for (const entry of existing) {
        expect(getSnapshot(store, entry.path, "keep\n")).toEqual([entry.hash]);
      }
      for (let i = 0; i < 70; i++) {
        expect(getSnapshot(store, `/gone-${i}.ts`, "gone\n")).toBeUndefined();
      }
    });
  });

  it("preserves the counter of a pruned path that still held a snapshot when pruning began", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      put(store, "/gone.ts", "old\n", ["ZZZ"]);
      const counterBefore = nextId(store.db, "/gone.ts");
      expect(counterBefore).toBeDefined();

      await pruneMissing(store);

      // Spec §3.6.3: the counter is never dropped while the path holds a snapshot or a lease. The
      // guard is evaluated BEFORE the purge deletes those rows, so the id block survives and a
      // re-created file can never re-issue a `line_id` a surviving anchor still claims.
      expect(counterRows(store.db, "/gone.ts")).toHaveLength(1);
      expect(nextId(store.db, "/gone.ts")).toBe(counterBefore);
      const db = openRaw(home);
      const persisted = db
        .prepare("SELECT next_id FROM line_id_counters WHERE path = ?")
        .get("/gone.ts") as { next_id: number } | undefined;
      db.close();
      expect(persisted?.next_id).toBe(counterBefore);
    });
  });

  it("drops the line_id counter of a pruned path once it holds no snapshot and no lease", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      put(store, "/gone.ts", "old\n", ["ZZZ"]);
      expect(counterRows(store.db, "/gone.ts")).toHaveLength(1);
      // Simulate the LRU vacuum that evicted the path's last snapshot: only the counter row is left.
      store.db.prepare("DELETE FROM file_snapshots WHERE path = ?").run("/gone.ts");
      expect(counterRows(store.db, "/gone.ts")).toHaveLength(1);

      await pruneMissing(store);

      expect(counterRows(store.db, "/gone.ts")).toHaveLength(0);
      const db = openRaw(home);
      const leftovers = db
        .prepare("SELECT next_id FROM line_id_counters WHERE path = ?")
        .all("/gone.ts") as { next_id: number }[];
      db.close();
      expect(leftovers).toHaveLength(0);
    });
  });

  it("keeps the line_id counter of a live path", async () => {
    await withTempHome(async (home) => {
      const existing = join(home, "keep.ts");
      await writeFile(existing, "keep\n", "utf-8");
      const store = await loadHashStore();
      put(store, existing, "keep\n", ["KEP"]);

      await pruneMissing(store);

      expect(counterRows(store.db, existing)).toHaveLength(1);
    });
  });
});
