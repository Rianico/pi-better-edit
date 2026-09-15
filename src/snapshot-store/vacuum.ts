import type { DatabaseSync } from "node:sqlite";
import { getCached, withBusyRetry } from "../hash-store.js";
import { SERVED_TTL_MS } from "../constants.js";

// WHY: --- Global LRU vacuum (spec §3.6.1) ---
// WHY: The CAS store is a bounded cache of file versions: 50 MB globally, and
// WHY: `min(10, max(2, floor(10 MB / snapshot_lineage_bytes)))` versions per path where
// WHY: `snapshot_lineage_bytes ≈ 40 × line_count`. Eviction is global and oldest-`created_at`
// WHY: first across all paths. Identity wins over budget: a snapshot a session can still resolve
// WHY: through — an active lease, a `file_undo.snapshot_hash` restore target, or a lease retired
// WHY: inside the 1-hour grace — is PINNED and never evicted, so the vacuum only drops versions
// WHY: no live anchor points at. When every remaining candidate is pinned the vacuum defers,
// WHY: permitting a soft overflow that in practice lapses with the 7-day lease TTL; `overSoftOverflow`
// WHY: reports the deferred state and is the only thing the 100 MB ceiling governs.
// WHY: These are the production budgets the store that owns `file_snapshots` / `line_lineage`
// WHY: enforces; they are module-level policy, never call-site configuration.

export const VACUUM_GLOBAL_BUDGET_BYTES = 50 * 1024 * 1024;
export const VACUUM_SOFT_OVERFLOW_BYTES = 100 * 1024 * 1024;
export const VACUUM_PER_PATH_BUDGET_BYTES = 10 * 1024 * 1024;
export const VACUUM_MAX_SNAPSHOTS_PER_PATH = 10;
export const VACUUM_MIN_SNAPSHOTS_PER_PATH = 2;
export const VACUUM_LINEAGE_BYTES_PER_LINE = 40;
export const VACUUM_RETIRED_PIN_MS = 60 * 60 * 1000;

/** Bounds for one vacuum pass; the policy values are the module-level production constants. */
export interface VacuumOptions {
  /**
   * Snapshot ids that must survive this pass regardless of budget or per-path retention: the
   * version an in-flight materialization is about to serve. The sweep runs before `served_leases`
   * exists for that version, so without this the freshly materialized row is the unpinned
   * candidate oldest-first eviction takes (spec §3.6.1 — retention must never delete the row the
   * caller is serving, or the next edit is permanently uneditable).
   */
  protectSnapshotIds?: Iterable<number>;
}

export interface VacuumResult {
  /** Snapshots deleted by this pass. */
  evicted: number;
  /** Lineage bytes retained after the pass. */
  totalBytes: number;
  /** Lineage bytes retained by pinned snapshots (always retained). */
  pinnedBytes: number;
  /** Overflow past the hard budget that the pinned set forces the store to keep. */
  deferredBytes: number;
  /** Whether that deferred overflow exceeds the tolerated soft cap (spec §3.6.1). */
  overSoftOverflow: boolean;
}

interface VacuumSnapshotRow {
  snapshot_id: number;
  path: string;
  snapshot_hash: string;
  line_count: number;
  created_at: number;
}

interface VacuumStmts {
  listSnapshots: () => VacuumSnapshotRow[];
  listPinned: (activeCutoff: number, graceCutoff: number) => { snapshot_id: number }[];
  deleteLineage: (snapshotId: number) => void;
  deleteSnapshot: (snapshotId: number) => void;
}

const vacuumStmtsCache = new WeakMap<DatabaseSync, VacuumStmts>();

function vacuumStmts(db: DatabaseSync): VacuumStmts {
  return getCached(db, vacuumStmtsCache, buildVacuumStmts);
}

function buildVacuumStmts(db: DatabaseSync): VacuumStmts {
  const listStmt = db.prepare(
    "SELECT snapshot_id, path, snapshot_hash, line_count, created_at FROM file_snapshots " +
      "WHERE committed = 1 ORDER BY created_at ASC, snapshot_id ASC",
  );
  // WHY: pinning is a two-table predicate (spec §3.6.1): a lease that is still active inside the
  // WHY: session TTL, a lease retired inside the 1-hour grace, or an undo restore target.
  const pinnedStmt = db.prepare(
    "SELECT DISTINCT fs.snapshot_id AS snapshot_id FROM file_snapshots fs " +
      "WHERE fs.committed = 1 AND (" +
      "EXISTS (SELECT 1 FROM served_leases sl WHERE sl.file_path = fs.path " +
      "AND sl.served_snapshot_hash = fs.snapshot_hash " +
      "AND ((sl.retired_at IS NULL AND sl.updated_at >= ?) OR sl.retired_at >= ?)) " +
      "OR EXISTS (SELECT 1 FROM file_undo fu WHERE fu.path = fs.path " +
      "AND fu.snapshot_hash = fs.snapshot_hash))",
  );
  const deleteLineageStmt = db.prepare("DELETE FROM line_lineage WHERE snapshot_id = ?");
  const deleteSnapshotStmt = db.prepare("DELETE FROM file_snapshots WHERE snapshot_id = ?");
  return {
    listSnapshots: () => listStmt.all() as unknown as VacuumSnapshotRow[],
    listPinned: (...params) => pinnedStmt.all(...params) as unknown as { snapshot_id: number }[],
    deleteLineage: (snapshotId) => deleteLineageStmt.run(snapshotId),
    deleteSnapshot: (snapshotId) => deleteSnapshotStmt.run(snapshotId),
  };
}

function lineageBytes(row: VacuumSnapshotRow, perLine: number): number {
  // WHY: an empty file still owns one counter row, so its cost floors at one line.
  return perLine * Math.max(1, row.line_count);
}

function perPathRetention(
  newestLineCount: number,
  windowBudget: number,
  perLine: number,
  maxVersions: number,
  minVersions: number,
): number {
  const snapshotLineageBytes = perLine * Math.max(1, newestLineCount);
  const window = Math.floor(windowBudget / snapshotLineageBytes);
  return Math.min(maxVersions, Math.max(minVersions, window));
}

/**
 * Enforce store retention across all paths (spec §3.6.1). The pass is a single oldest-first sweep
 * of every committed snapshot: a snapshot is deleted when the running total is over the global
 * budget, or when its path already retains more than its retention window. Pinned snapshots are
 * skipped unconditionally — they are the versions a live anchor can still resolve through.
 */
export function vacuumSnapshots(db: DatabaseSync, options: VacuumOptions = {}): VacuumResult {
  const now = Date.now();
  const stmts = vacuumStmts(db);
  const rows = stmts.listSnapshots();
  const empty: VacuumResult = {
    evicted: 0,
    totalBytes: 0,
    pinnedBytes: 0,
    deferredBytes: 0,
    overSoftOverflow: false,
  };
  if (rows.length === 0) return empty;

  const pinned = new Set(
    stmts
      .listPinned(now - SERVED_TTL_MS, now - VACUUM_RETIRED_PIN_MS)
      .map((row) => row.snapshot_id),
  );
  // WHY: an in-flight materialization protects its own row: it names the snapshot before the serve
  // WHY: grants `served_leases`, so the sweep must treat it exactly like a live pin (spec §3.6.1).
  for (const id of options.protectSnapshotIds ?? []) pinned.add(id);
  // WHY: rows are ascending by `created_at`, so the last row seen for a path is its newest version
  // WHY: — the file size the per-path retention window is sized against.
  const newestLineCount = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    newestLineCount.set(row.path, row.line_count);
    pathCounts.set(row.path, (pathCounts.get(row.path) ?? 0) + 1);
    total += lineageBytes(row, VACUUM_LINEAGE_BYTES_PER_LINE);
  }

  const evict: number[] = [];
  let pinnedBytes = 0;
  for (const row of rows) {
    const cost = lineageBytes(row, VACUUM_LINEAGE_BYTES_PER_LINE);
    if (pinned.has(row.snapshot_id)) {
      pinnedBytes += cost;
      continue;
    }
    const retention = perPathRetention(
      newestLineCount.get(row.path) ?? row.line_count,
      VACUUM_PER_PATH_BUDGET_BYTES,
      VACUUM_LINEAGE_BYTES_PER_LINE,
      VACUUM_MAX_SNAPSHOTS_PER_PATH,
      VACUUM_MIN_SNAPSHOTS_PER_PATH,
    );
    const retained = pathCounts.get(row.path) ?? 0;
    if (total > VACUUM_GLOBAL_BUDGET_BYTES || retained > retention) {
      evict.push(row.snapshot_id);
      total -= cost;
      pathCounts.set(row.path, retained - 1);
    }
  }

  if (evict.length > 0) deleteVacuumSnapshots(db, evict);
  const deferredBytes = Math.max(0, total - VACUUM_GLOBAL_BUDGET_BYTES);
  return {
    evicted: evict.length,
    totalBytes: total,
    pinnedBytes,
    deferredBytes,
    overSoftOverflow: deferredBytes > VACUUM_SOFT_OVERFLOW_BYTES - VACUUM_GLOBAL_BUDGET_BYTES,
  };
}

/**
 * Delete the evicted snapshots and their lineage in one transaction. The pass owns its transaction
 * only when the caller is outside one: `vacuumSnapshots` is invoked both after an authoritative
 * materialization commits and from the store-open hook.
 */
function deleteVacuumSnapshots(db: DatabaseSync, snapshotIds: number[]): void {
  const stmts = vacuumStmts(db);
  withBusyRetry(() => {
    const inTransaction = (db as unknown as { isTransaction?: boolean }).isTransaction === true;
    if (inTransaction) {
      for (const id of snapshotIds) {
        stmts.deleteLineage(id);
        stmts.deleteSnapshot(id);
      }
      return;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of snapshotIds) {
        stmts.deleteLineage(id);
        stmts.deleteSnapshot(id);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError: unknown) {
        // SAFETY: best-effort rollback — the original failure is authoritative and must not be masked.
        console.error("[snapshot-store] failed to rollback vacuum transaction:", rollbackError);
      }
      throw error;
    }
  });
}
