/**
 * Ticket #160 benchmark: the janitor's hard-expiry GC and what it buys the vacuum.
 *
 * Builds the issue's fixture SHAPE in a throwaway store — 200 paths × 5 versions × 2,000 leases
 * (400k lease rows, 57% of them active past the 7-day TTL) — then reports:
 * - the lease population and the vacuum's p50/p95 over repeated passes BEFORE the janitor GC;
 * - the janitor's deletions (at 2c83761 it deletes none of the active-expired rows; at the fix it
 *   deletes the expired-active family);
 * - the same vacuum pass AFTER the GC, so the script can run at both commits and be compared.
 *
 * Dev-only; run `node scripts/bench-lease-gc.mjs`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHashStore, shutdownHashStore } from "../src/hash-store";
import { vacuumSnapshots } from "../src/snapshot-store";
import { STORE_JANITOR_DEFAULTS } from "../src/store-kernel/settings.js";
import { runJanitor } from "../src/store-janitor";
import { SERVED_TTL_MS } from "../src/constants";
import { CANON_VERSION, ANCHOR_GENERATION } from "../src/hashline/hash-identity.js";

const PATHS = 200;
const VERSIONS = 5;
const LEASES_PER_PATH = 2_000;
const SAMPLES = 20;
const EXPIRED_SHARE = 0.57;

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
};

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
        (_, version) => `${CANON_VERSION}:${ANCHOR_GENERATION}:bench-${path}-${version}`,
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

const count = (db: DatabaseSync): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }).n;

const vacuumSamples = (db: DatabaseSync): { p50: number; p95: number } => {
  const times: number[] = [];
  for (let run = 0; run < SAMPLES; run++) {
    const started = performance.now();
    vacuumSnapshots(db);
    times.push(performance.now() - started);
  }
  return { p50: percentile(times, 0.5), p95: percentile(times, 0.95) };
};

const dir = await mkdtemp(join(tmpdir(), "pi-bench-lease-gc-"));
process.env.PI_BETTER_EDIT_CONFIG_DIR = dir;
const store = await loadHashStore();
const db = store.db;
const now = Date.now();
seed(db, now);

const leasesBefore = count(db);
const before = vacuumSamples(db);
const plan = db
  .prepare(
    "EXPLAIN QUERY PLAN SELECT DISTINCT fs.snapshot_id FROM file_snapshots fs WHERE fs.committed = 1 " +
      "AND EXISTS (SELECT 1 FROM served_leases WHERE served_leases.file_path = fs.path " +
      "AND served_leases.served_snapshot_hash = fs.snapshot_hash AND served_leases.retired_at IS NULL " +
      "AND served_leases.updated_at >= ?)",
  )
  .all(now - SERVED_TTL_MS) as { detail: string }[];

const janitor = runJanitor({
  db: store.db,
  now,
  settings: { ...STORE_JANITOR_DEFAULTS, intervalMs: 1, batchSize: 4_096 },
});
const leasesAfter = count(db);
const after = vacuumSamples(db);

console.log(`fixture: ${PATHS} paths × ${VERSIONS} versions × ${LEASES_PER_PATH} leases`);
console.log(
  `lease rows            before ${leasesBefore}  after ${leasesAfter}  (removed ${janitor.deleted.expiredLeases})`,
);
console.log(
  `vacuum p50            before ${before.p50.toFixed(1)} ms  after ${after.p50.toFixed(1)} ms`,
);
console.log(
  `vacuum p95            before ${before.p95.toFixed(1)} ms  after ${after.p95.toFixed(1)} ms`,
);
console.log(`pin-probe plan        ${plan.map((row) => row.detail).join(" | ")}`);

shutdownHashStore();
await rm(dir, { recursive: true, force: true });
