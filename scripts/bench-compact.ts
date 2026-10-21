/**
 * Ticket #161 benchmark: what compaction reclaims after the lease GC, and what it costs.
 *
 * Seeds the #160 fixture shape (200 paths × 5 versions × 2,000 leases, 57% expired active) in a
 * throwaway store, then reports the on-disk size and wall time at three points:
 *   1. after seeding (the file at its high-water mark),
 *   2. after one janitor pass (GC; at 3ae75c4 this is GC only, at the fix it is GC + compaction),
 *   3. after an explicit VACUUM (the cost compaction pays, and what it buys when the janitor skipped).
 *
 * Dev-only; run `node scripts/bench-compact.mjs`. WAL is checkpointed before every size reading so
 * the number is the database file, not its write-ahead log.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { hashStorePath, loadHashStore, shutdownHashStore } from "../src/hash-store";
import { STORE_JANITOR_DEFAULTS } from "../src/store-config";
import { runJanitor } from "../src/store-janitor";
import { SERVED_TTL_MS } from "../src/constants";
import { CANON_VERSION, ANCHOR_GENERATION } from "../src/hashline/hash-identity.js";

const PATHS = 200;
const VERSIONS = 5;
const LEASES_PER_PATH = 2_000;
const EXPIRED_SHARE = 0.57;

const seed = (db: DatabaseSync, now: number): void => {
  const insertSnapshot = db.prepare(
    "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) VALUES (?, ?, ?, ?, 1, ?)",
  );
  const insertLease = db.prepare(
    "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, served_snapshot_hash, served_line_number, updated_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
  );
  db.exec("BEGIN");
  try {
    let lineId = 1;
    for (let path = 0; path < PATHS; path++) {
      const filePath = `/bench/p${path}.ts`;
      const hashes = Array.from(
        { length: VERSIONS },
        (_, version) => `${CANON_VERSION}:${ANCHOR_GENERATION}:compact-${path}-${version}`,
      );
      for (const [version, hash] of hashes.entries()) {
        insertSnapshot.run(
          filePath,
          hash,
          100,
          now - (VERSIONS - version) * 1000,
          ANCHOR_GENERATION,
        );
      }
      for (let lease = 0; lease < LEASES_PER_PATH; lease++) {
        const expired = lease / LEASES_PER_PATH < EXPIRED_SHARE;
        insertLease.run(
          "bench-session",
          filePath,
          `a${path.toString(36)}${lease.toString(36)}`,
          lineId++,
          "cafe",
          hashes[lease % VERSIONS],
          lease + 1,
          expired ? now - SERVED_TTL_MS - 1000 : now,
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

const checkpoint = (db: DatabaseSync): void => {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
};

const fileBytes = async (): Promise<number> => {
  const info = await stat(hashStorePath());
  return info.size;
};
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const dir = await mkdtemp(join(tmpdir(), "pi-bench-compact-"));
process.env.PI_BETTER_EDIT_CONFIG_DIR = dir;
const store = await loadHashStore();
const db = store.db;
const now = Date.now();
seed(db, now);
checkpoint(db);
const seeded = await fileBytes();

const gcStarted = performance.now();
const janitor = runJanitor({
  db,
  now,
  settings: { ...STORE_JANITOR_DEFAULTS, intervalMs: 1, batchSize: 4_096 },
});
const gcMs = performance.now() - gcStarted;
// WHY: at the parent commit the janitor has no compaction step at all; the report says "absent".
const compacted = janitor.compacted ?? { ran: false, reason: "absent", reclaimedBytes: 0 };
checkpoint(db);
const afterJanitor = await fileBytes();

const vacuumStarted = performance.now();
db.exec("VACUUM");
const vacuumMs = performance.now() - vacuumStarted;
checkpoint(db);
const afterVacuum = await fileBytes();

console.log(
  `fixture: ${PATHS} paths × ${VERSIONS} versions × ${LEASES_PER_PATH.toLocaleString()} leases`,
);
console.log(`leases removed by the janitor      ${janitor.deleted.expiredLeases.toLocaleString()}`);
console.log(
  `compaction                         ran=${compacted.ran} reason=${compacted.reason ?? "-"} reclaimed=${mb(compacted.reclaimedBytes)}`,
);
console.log(`file after seed                    ${mb(seeded)}`);
console.log(
  `file after janitor pass            ${mb(afterJanitor)}   (pass ${gcMs.toFixed(0)} ms)`,
);
console.log(
  `file after explicit VACUUM         ${mb(afterVacuum)}   (VACUUM ${vacuumMs.toFixed(0)} ms)`,
);

shutdownHashStore();
await rm(dir, { recursive: true, force: true });
