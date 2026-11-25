import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import type { DatabaseSync } from "node:sqlite";

import { loadHashStore, shutdownHashStore, type HashStore } from "../../src/hash-store";
import { ANCHOR_GENERATION } from "../../src/hashline/hash-identity.js";
import { snapshotHashFor } from "../../src/snapshot-store";
import { readNormFile } from "../../src/file-reader";
import { createSessionHandle, loadLeases } from "../../src/served-session/index.js";
import { visLines } from "../../src/utils";
import {
  upsertSnapshotsFor,
  vacuumSnapshots,
  VACUUM_GLOBAL_BUDGET_BYTES,
  VACUUM_LINEAGE_BYTES_PER_LINE,
  VACUUM_MAX_SNAPSHOTS_PER_PATH,
  VACUUM_PER_PATH_BUDGET_BYTES,
  VACUUM_SOFT_OVERFLOW_BYTES,
} from "../../src/snapshot-store";
import { initHasher } from "../../src/hashline/hasher";
import { getWritableTempRoot } from "../support/fixtures";

beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-vacuum-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", "");
  try {
    await run(home);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
}

/** One committed version of `path` plus one lineage row, so cascades are observable. */
function seedVersion(
  db: DatabaseSync,
  path: string,
  hash: string,
  lineCount: number,
  createdAt: number,
): number {
  const row = db
    .prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) " +
        "VALUES (?, ?, ?, ?, 1, ?) RETURNING snapshot_id",
    )
    .get(path, hash, lineCount, createdAt, ANCHOR_GENERATION) as { snapshot_id: number };
  db.prepare(
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) " +
      "VALUES (?, 1, ?, ?, ?)",
  ).run(row.snapshot_id, row.snapshot_id * 1000, `canon-${hash}`, `anchor-${hash}`);
  return row.snapshot_id;
}

function seedLease(
  db: DatabaseSync,
  input: {
    path: string;
    snapshotHash: string;
    retiredAt?: number | null;
    updatedAt?: number;
    session?: string;
  },
): void {
  db.prepare(
    "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, " +
      "served_snapshot_hash, served_line_number, updated_at, retired_at) VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?)",
  ).run(
    input.session ?? "sessionA",
    input.path,
    `anchor-${input.snapshotHash}`,
    `canon-${input.snapshotHash}`,
    input.snapshotHash,
    input.updatedAt ?? Date.now(),
    input.retiredAt ?? null,
  );
}

function seedUndoPin(db: DatabaseSync, path: string, snapshotHash: string): void {
  db.prepare(
    "INSERT INTO file_undo (path, content, bom, ending, hashes, result_content, snapshot_hash, updated_at) " +
      "VALUES (?, 'x', '', '\\n', '[]', 'x', ?, ?)",
  ).run(path, snapshotHash, Date.now());
}

/**
 * (ticket-04b §4) One cut transaction writes TWO `file_undo` rows sharing a `transaction_id`. The
 * vacuum pin predicate is per (path, snapshot_hash) and never reads the id, which is why this shape
 * needs its own witness: the mutation is the NEW row-set a transaction produces (doubled pinned
 * rows), not the predicate. Falsifier: a predicate narrowed to `transaction_id IS NULL` would evict
 * a pinned transaction member here.
 */
function seedUndoTxnPin(db: DatabaseSync, path: string, snapshotHash: string, txnId: string): void {
  db.prepare(
    "INSERT INTO file_undo (path, content, bom, ending, hashes, result_content, snapshot_hash, " +
      "transaction_id, updated_at) VALUES (?, 'x', '', '\\n', '[]', 'x', ?, ?, ?)",
  ).run(path, snapshotHash, txnId, Date.now());
}

function versions(db: DatabaseSync): { path: string; snapshot_hash: string }[] {
  return db
    .prepare(
      "SELECT path, snapshot_hash FROM file_snapshots ORDER BY created_at ASC, snapshot_id ASC",
    )
    .all() as unknown as { path: string; snapshot_hash: string }[];
}

/** A committed snapshot whose lineage carries the real anchors a lease grant needs. */
function seedAnchoredSnapshot(
  db: DatabaseSync,
  path: string,
  hash: string,
  anchors: string[],
  createdAt: number,
): number {
  const row = db
    .prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) " +
        "VALUES (?, ?, ?, ?, 1, ?) RETURNING snapshot_id",
    )
    .get(path, hash, anchors.length, createdAt, ANCHOR_GENERATION) as { snapshot_id: number };
  const insert = db.prepare(
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) " +
      "VALUES (?, ?, ?, ?, ?)",
  );
  anchors.forEach((anchor, index) => {
    insert.run(
      row.snapshot_id,
      index + 1,
      row.snapshot_id * 1000 + index,
      `canon-${anchor}`,
      anchor,
    );
  });
  return row.snapshot_id;
}

/** The production read path: materialize the file's committed bytes, then serve them. */
async function readAndServe(store: HashStore, file: string, cwd: string, sessionKey: string) {
  const norm = await readNormFile(file, cwd, { store });
  const session = createSessionHandle(sessionKey, norm.absolutePath, store);
  await session.recordEpoch({
    rows: norm.fileHashes.map((hash, position) => ({ position, hash })),
    lineCount: visLines(norm.normalized).length,
    fullReadHashes: norm.fileHashes,
    contentHash: snapshotHashFor(norm.normalized),
    isFullRead: true,
  });
  return norm;
}

function snapshotCount(db: DatabaseSync, path: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ? AND committed = 1")
      .get(path) as { n: number }
  ).n;
}

function lineageRows(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM line_lineage").get() as { n: number }).n;
}

function totalBytes(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(line_count), 0) AS n FROM file_snapshots WHERE committed = 1")
    .get() as { n: number };
  return row.n * VACUUM_LINEAGE_BYTES_PER_LINE;
}

/**
 * Priced at the per-line figure `VACUUM_LINEAGE_BYTES_PER_LINE` charges: 220_000 lines x 52 bytes = 11.44 MB per
 * version, so 6 versions (68.64 MB) overflow the 50 MB hard budget and evicting the 2 oldest lands at 45.76 MB.
 * One path still clears the 10 MB per-path budget, keeping the floor-of-2 case reachable.
 */
const BIG_LINES = 220_000;
const BIG_FILES = 6;

function seedBigStore(db: DatabaseSync): void {
  for (let i = 0; i < BIG_FILES; i++) {
    seedVersion(db, `/p${i}.ts`, `hash-${i}`, BIG_LINES, 1000 * (i + 1));
  }
}

describe("global LRU vacuum (spec §3.6.1)", () => {
  it("evicts globally oldest-created_at first until the 50 MB budget holds", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedBigStore(db);
      expect(totalBytes(db)).toBeGreaterThan(VACUUM_GLOBAL_BUDGET_BYTES);

      const result = vacuumSnapshots(db);

      expect(result.evicted).toBe(2);
      expect(versions(db).map((v) => v.path)).toEqual(["/p2.ts", "/p3.ts", "/p4.ts", "/p5.ts"]);
      expect(totalBytes(db)).toBeLessThanOrEqual(VACUUM_GLOBAL_BUDGET_BYTES);
      expect(result.totalBytes).toBe(totalBytes(db));
    });
  });

  it("evicts the evicted snapshot's line_lineage with it", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedBigStore(db);
      expect(lineageRows(db)).toBe(BIG_FILES);

      vacuumSnapshots(db);

      expect(lineageRows(db)).toBe(BIG_FILES - 2);
    });
  });

  it("never evicts a snapshot referenced by an active served_leases row", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedBigStore(db);
      seedLease(db, { path: "/p0.ts", snapshotHash: "hash-0" });

      const result = vacuumSnapshots(db);

      expect(result.evicted).toBe(2);
      expect(versions(db).map((v) => v.snapshot_hash)).toEqual([
        "hash-0",
        "hash-3",
        "hash-4",
        "hash-5",
      ]);
      expect(totalBytes(db)).toBeLessThanOrEqual(VACUUM_GLOBAL_BUDGET_BYTES);
      expect(result.pinnedBytes).toBe(BIG_LINES * VACUUM_LINEAGE_BYTES_PER_LINE);
    });
  });

  it("never evicts a snapshot pinned by file_undo.snapshot_hash", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedBigStore(db);
      seedUndoPin(db, "/p0.ts", "hash-0");

      vacuumSnapshots(db);

      expect(versions(db).map((v) => v.snapshot_hash)).toEqual([
        "hash-0",
        "hash-3",
        "hash-4",
        "hash-5",
      ]);
    });
  });

  it("pins BOTH files of one cut transaction and evicts only unrelated versions to hold the budget", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedBigStore(db);
      seedUndoTxnPin(db, "/p0.ts", "hash-0", "txn-cut-1");
      seedUndoTxnPin(db, "/p1.ts", "hash-1", "txn-cut-1");

      const result = vacuumSnapshots(db);

      expect(result.evicted).toBe(2);
      expect(versions(db).map((v) => v.snapshot_hash)).toEqual([
        "hash-0",
        "hash-1",
        "hash-4",
        "hash-5",
      ]);
      expect(totalBytes(db)).toBeLessThanOrEqual(VACUUM_GLOBAL_BUDGET_BYTES);
      expect(result.pinnedBytes).toBe(2 * BIG_LINES * VACUUM_LINEAGE_BYTES_PER_LINE);
      const ids = db
        .prepare("SELECT transaction_id FROM file_undo ORDER BY path")
        .all() as unknown as { transaction_id: string }[];
      expect(ids.map((r) => r.transaction_id)).toEqual(["txn-cut-1", "txn-cut-1"]);
    });
  });

  it("defers the budget rather than evicting any member when every version is a transaction pin", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      for (let i = 0; i < BIG_FILES; i++) {
        seedVersion(db, `/p${i}.ts`, `hash-${i}`, BIG_LINES, 1000 * (i + 1));
        seedUndoTxnPin(db, `/p${i}.ts`, `hash-${i}`, `txn-${i >> 1}`);
      }
      expect(totalBytes(db)).toBeGreaterThan(VACUUM_GLOBAL_BUDGET_BYTES);

      const result = vacuumSnapshots(db);

      expect(result.evicted).toBe(0);
      expect(versions(db)).toHaveLength(BIG_FILES);
      expect(result.deferredBytes).toBe(totalBytes(db) - VACUUM_GLOBAL_BUDGET_BYTES);
    });
  });

  it("never evicts a snapshot whose lease retired inside the 1-hour grace", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedBigStore(db);
      seedLease(db, {
        path: "/p0.ts",
        snapshotHash: "hash-0",
        retiredAt: Date.now() - 10 * 60 * 1000,
      });

      vacuumSnapshots(db);

      expect(versions(db).map((v) => v.snapshot_hash)).toContain("hash-0");
      expect(versions(db).map((v) => v.snapshot_hash)).not.toContain("hash-1");
    });
  });

  it("unpins a lease retired beyond the 1-hour grace", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedBigStore(db);
      seedLease(db, { path: "/p0.ts", snapshotHash: "hash-0" });
      seedLease(db, {
        path: "/p1.ts",
        snapshotHash: "hash-1",
        retiredAt: Date.now() - 2 * 60 * 60 * 1000,
      });

      vacuumSnapshots(db);

      const remaining = versions(db).map((v) => v.snapshot_hash);
      expect(remaining).toContain("hash-0");
      expect(remaining).not.toContain("hash-1");
    });
  });

  it(`keeps at most ${VACUUM_MAX_SNAPSHOTS_PER_PATH} snapshots per path, newest first`, async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      for (let i = 0; i < 12; i++) seedVersion(db, "/solo.ts", `solo-${i}`, 1, 1000 * (i + 1));

      const result = vacuumSnapshots(db);

      expect(result.evicted).toBe(2);
      expect(versions(db).map((v) => v.snapshot_hash)).toEqual(
        Array.from({ length: 10 }, (_, i) => `solo-${i + 2}`),
      );
    });
  });

  it("keeps the per-path floor of 2 versions for a multi-megabyte file", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      for (let i = 0; i < 5; i++)
        seedVersion(db, "/huge.ts", `huge-${i}`, BIG_LINES, 1000 * (i + 1));

      const result = vacuumSnapshots(db);

      expect(result.evicted).toBe(3);
      expect(versions(db).map((v) => v.snapshot_hash)).toEqual(["huge-3", "huge-4"]);
      expect(VACUUM_PER_PATH_BUDGET_BYTES).toBeLessThan(BIG_LINES * VACUUM_LINEAGE_BYTES_PER_LINE);
    });
  });

  it("defers to a soft overflow while every remaining candidate is pinned", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedBigStore(db);
      for (let i = 0; i < BIG_FILES; i++) {
        seedLease(db, { path: `/p${i}.ts`, snapshotHash: `hash-${i}` });
      }

      const result = vacuumSnapshots(db);

      expect(result.evicted).toBe(0);
      expect(versions(db)).toHaveLength(BIG_FILES);
      expect(result.deferredBytes).toBe(totalBytes(db) - VACUUM_GLOBAL_BUDGET_BYTES);
      expect(result.overSoftOverflow).toBe(false);
    });
  });

  it("still never evicts a pin when the deferred overflow passes the soft cap", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      for (let i = 0; i < 10; i++) {
        seedVersion(db, `/p${i}.ts`, `hash-${i}`, BIG_LINES, 1000 * (i + 1));
        seedLease(db, { path: `/p${i}.ts`, snapshotHash: `hash-${i}` });
      }
      expect(totalBytes(db)).toBeGreaterThan(VACUUM_SOFT_OVERFLOW_BYTES);

      const result = vacuumSnapshots(db);

      expect(result.evicted).toBe(0);
      expect(versions(db)).toHaveLength(10);
      expect(result.overSoftOverflow).toBe(true);
    });
  });

  it("is a no-op on an empty store", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const result = vacuumSnapshots(store.db);
      expect(result).toEqual({
        evicted: 0,
        totalBytes: 0,
        pinnedBytes: 0,
        deferredBytes: 0,
        overSoftOverflow: false,
      });
    });
  });

  it("is idempotent", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      seedBigStore(store.db);
      vacuumSnapshots(store.db);
      const after = versions(store.db).map((v) => v.snapshot_hash);
      const second = vacuumSnapshots(store.db);
      expect(second.evicted).toBe(0);
      expect(versions(store.db).map((v) => v.snapshot_hash)).toEqual(after);
    });
  });

  it("keeps the snapshot an in-flight read materialized when every candidate is pinned", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      seedBigStore(store.db);
      for (let i = 0; i < BIG_FILES; i++) {
        seedLease(store.db, { path: `/p${i}.ts`, snapshotHash: `hash-${i}` });
      }
      expect(totalBytes(store.db)).toBeGreaterThan(VACUUM_GLOBAL_BUDGET_BYTES);

      const file = join(home, "served.ts");
      await writeFile(file, "alpha\nbeta\ngamma\n");

      const norm = await readAndServe(store, file, home, "sessionA");

      expect(snapshotCount(store.db, norm.absolutePath)).toBe(1);
      expect(loadLeases(store, "sessionA", norm.absolutePath).length).toBeGreaterThan(0);
    });
  });

  it("does not sweep an over-budget store when a read adopts a served snapshot", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const db = store.db;
      for (let i = 0; i < 5; i++) {
        seedVersion(db, `/pinned${i}.ts`, `pinned-hash-${i}`, BIG_LINES, 1000 * (i + 1));
        seedLease(db, { path: `/pinned${i}.ts`, snapshotHash: `pinned-hash-${i}` });
      }
      const file = join(home, "served.ts");
      await writeFile(file, "alpha\nbeta\ngamma\n");
      const probe = await readNormFile(file, home, { store, noPersist: true });
      seedAnchoredSnapshot(
        db,
        probe.absolutePath,
        snapshotHashFor(probe.normalized),
        probe.fileHashes,
        10_000,
      );
      seedVersion(db, probe.absolutePath, "stale-version", 1, 11_000);
      seedVersion(db, "/other.ts", "other-hash", 1, 12_000);
      expect(totalBytes(db)).toBeGreaterThan(VACUUM_GLOBAL_BUDGET_BYTES);

      const norm = await readAndServe(store, file, home, "sessionA");

      expect(snapshotCount(db, norm.absolutePath)).toBe(2);
      expect(loadLeases(store, "sessionA", norm.absolutePath).length).toBeGreaterThan(0);
      expect(totalBytes(db)).toBeGreaterThan(VACUUM_GLOBAL_BUDGET_BYTES);
    });
  });

  it("runs on store open so a restart enforces the budget", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      seedBigStore(store.db);
      expect(versions(store.db)).toHaveLength(BIG_FILES);

      shutdownHashStore();
      const reopened = await loadHashStore();

      expect(totalBytes(reopened.db)).toBeLessThanOrEqual(VACUUM_GLOBAL_BUDGET_BYTES);
      expect(versions(reopened.db)).toHaveLength(4);
    });
  });
});

describe("retention is owed only by a fresh commit", () => {
  it("does not sweep when a batch adopts an already-committed snapshot", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedBigStore(db);
      expect(totalBytes(db)).toBeGreaterThan(VACUUM_GLOBAL_BUDGET_BYTES);

      await upsertSnapshotsFor([
        {
          descriptor: {
            path: "/p3.ts",
            snapshotHash: "hash-3",
            lineCount: BIG_LINES,
            hashes: [],
            content: "",
          },
        },
      ]);

      expect(versions(db)).toHaveLength(BIG_FILES);
      expect(totalBytes(db)).toBeGreaterThan(VACUUM_GLOBAL_BUDGET_BYTES);
    });
  });

  it("still sweeps once after a batch inserts a fresh snapshot", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedBigStore(db);

      await upsertSnapshotsFor([
        {
          descriptor: {
            path: "/p6.ts",
            snapshotHash: "hash-6",
            lineCount: BIG_LINES,
            hashes: [],
            content: "",
          },
        },
      ]);

      expect(versions(db).map((v) => v.snapshot_hash)).toEqual([
        "hash-3",
        "hash-4",
        "hash-5",
        "hash-6",
      ]);
      expect(totalBytes(db)).toBeLessThanOrEqual(VACUUM_GLOBAL_BUDGET_BYTES);
    });
  });
});
