import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { contentChecksum, xxh32 } from "../hashline/hasher.js";
import {
  isValidHashList,
  CANON_VERSION,
  canon,
  setDefaultHashSnapshotIO,
  type HashSnapshotIO,
  type HashSnapshotUpsertOptions,
} from "../hashline/hash.js";
import { splitLines } from "../utils.js";
import {
  loadHashStore,
  onStoreOpen,
  ensureSnapshotTables,
  withStore,
  withBusyRetry,
  getCached,
  type HashStore,
} from "../hash-store.js";
import { deleteUndo } from "../undo-store.js";
import {
  deleteServedByPath,
  grantLeasesInTransaction,
  retireAbsentLeases,
} from "../served-session/session.js";
import { pairSnapshots, type LineDescriptor } from "../hashline/patience-pairing.js";
import { vacuumSnapshots } from "./vacuum.js";
import type { VacuumOptions, VacuumResult } from "./vacuum.js";
import { migrateLegacyStore } from "./migrate.js";

export { vacuumSnapshots };
export type { VacuumOptions, VacuumResult };
// WHY: the vacuum budgets are the store's retention policy constants, so the module entry keeps
// WHY: them on the public surface; consumers must never reach into the eviction module directly.
export {
  VACUUM_GLOBAL_BUDGET_BYTES,
  VACUUM_SOFT_OVERFLOW_BYTES,
  VACUUM_PER_PATH_BUDGET_BYTES,
  VACUUM_MAX_SNAPSHOTS_PER_PATH,
  VACUUM_MIN_SNAPSHOTS_PER_PATH,
  VACUUM_LINEAGE_BYTES_PER_LINE,
  VACUUM_RETIRED_PIN_MS,
} from "./vacuum.js";

interface SnapshotRef {
  snapshot_id: number;
  line_count: number;
}

export interface SnapshotStmts {
  findSnapshot: (path: string, snapshotHash: string) => SnapshotRef | undefined;
  lineageAnchors: (snapshotId: number) => { anchor: string }[];
  latestSnapshot: (path: string) => { snapshot_id: number } | undefined;
  lineageIdentities: (
    snapshotId: number,
  ) => { line_number: number; line_id: number; canon_hash: string }[];
  allPaths: () => { path: string }[];
  countSnapshots: (path: string) => number;
  countLeases: (path: string) => number;
  deleteCounter: (path: string) => void;
  deleteSnapshot: (snapshotId: number) => void;
  deleteByPath: (path: string) => void;
  allocateLineIds: (path: string, count: number) => number;
  insertSnapshot: (
    path: string,
    snapshotHash: string,
    lineCount: number,
    createdAt: number,
  ) => number | undefined;
  insertLineage: (
    snapshotId: number,
    lineNumber: number,
    lineId: number,
    canonHash: string,
    anchor: string,
  ) => void;
}

const stmtsCache = new WeakMap<DatabaseSync, SnapshotStmts>();

export function snapshotStmts(db: DatabaseSync): SnapshotStmts {
  return getCached(db, stmtsCache, buildStmts);
}

function buildStmts(db: DatabaseSync): SnapshotStmts {
  const findStmt = db.prepare(
    "SELECT snapshot_id, line_count FROM file_snapshots " +
      "WHERE path = ? AND snapshot_hash = ? AND committed = 1",
  );
  const lineageStmt = db.prepare(
    "SELECT anchor FROM line_lineage WHERE snapshot_id = ? ORDER BY line_number ASC",
  );
  const latestSnapshotStmt = db.prepare(
    "SELECT snapshot_id FROM file_snapshots WHERE path = ? AND committed = 1 " +
      "ORDER BY created_at DESC, snapshot_id DESC LIMIT 1",
  );
  const lineageIdentitiesStmt = db.prepare(
    "SELECT line_number, line_id, canon_hash FROM line_lineage " +
      "WHERE snapshot_id = ? ORDER BY line_number ASC",
  );
  const allPathsStmt = db.prepare(
    "SELECT path FROM file_snapshots UNION SELECT path FROM file_undo UNION SELECT path FROM served " +
      "UNION SELECT file_path FROM served_leases UNION SELECT file_path FROM served_session_meta " +
      // WHY: a path whose snapshots were all evicted by the vacuum leaves only its counter row behind
      // WHY: (spec §3.6.3); enumerating `line_id_counters` is what lets `pruneMissing` reclaim that
      // WHY: orphan instead of leaking an id block for a file that no longer exists.
      "UNION SELECT path FROM line_id_counters",
  );
  const deleteSnapshotStmt = db.prepare("DELETE FROM file_snapshots WHERE snapshot_id = ?");
  const deleteByPathStmt = db.prepare("DELETE FROM file_snapshots WHERE path = ?");
  // WHY: `line_lineage` is purged explicitly rather than leaning on `ON DELETE CASCADE`, so a store
  // WHY: opened without `PRAGMA foreign_keys = ON` still leaves no orphan lineage behind (spec §3.6.3).
  const deleteLineageByPathStmt = db.prepare(
    "DELETE FROM line_lineage WHERE snapshot_id IN " +
      "(SELECT snapshot_id FROM file_snapshots WHERE path = ?)",
  );
  const countSnapshotsStmt = db.prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?");
  const countLeasesStmt = db.prepare("SELECT COUNT(*) AS n FROM served_leases WHERE file_path = ?");
  const deleteCounterStmt = db.prepare("DELETE FROM line_id_counters WHERE path = ?");
  const allocateStmt = db.prepare(
    "INSERT INTO line_id_counters (path, next_id) VALUES (?, ? + 1) " +
      "ON CONFLICT(path) DO UPDATE SET next_id = line_id_counters.next_id + ? " +
      "RETURNING (next_id - ?) AS start_id",
  );
  // WHY: the miss path must never take the `ON CONFLICT (path, snapshot_hash)` UPDATE branch
  // WHY: (spec §3.2.4 step 3): a DO UPDATE would silently rewrite an existing canonical row under
  // WHY: a local allocation. `DO NOTHING` + no returned row is the conflict signal the caller
  // WHY: rolls back on, so the concurrent writer's canonical snapshot is adopted instead.
  const insertSnapshotStmt = db.prepare(
    "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) " +
      "VALUES (?, ?, ?, ?, 1) " +
      "ON CONFLICT(path, snapshot_hash) DO NOTHING " +
      "RETURNING snapshot_id",
  );
  const insertLineageStmt = db.prepare(
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) " +
      "VALUES (?, ?, ?, ?, ?)",
  );
  return {
    findSnapshot: (...params) => findStmt.get(...params) as SnapshotRef | undefined,
    lineageAnchors: (...params) => lineageStmt.all(...params) as unknown as { anchor: string }[],
    latestSnapshot: (...params) =>
      latestSnapshotStmt.get(...params) as { snapshot_id: number } | undefined,
    lineageIdentities: (...params) =>
      lineageIdentitiesStmt.all(...params) as unknown as {
        line_number: number;
        line_id: number;
        canon_hash: string;
      }[],
    allPaths: () => allPathsStmt.all() as unknown as { path: string }[],
    deleteSnapshot: (snapshotId) => deleteSnapshotStmt.run(snapshotId),
    deleteByPath: (path) => {
      deleteLineageByPathStmt.run(path);
      deleteByPathStmt.run(path);
    },
    countSnapshots: (path) => (countSnapshotsStmt.get(path) as { n: number }).n,
    countLeases: (path) => (countLeasesStmt.get(path) as { n: number }).n,
    deleteCounter: (path) => deleteCounterStmt.run(path),
    allocateLineIds: (path, count) => {
      const row = allocateStmt.get(path, count, count, count) as { start_id: number };
      return row.start_id;
    },
    insertSnapshot: (path, snapshotHash, lineCount, createdAt) => {
      const row = insertSnapshotStmt.get(path, snapshotHash, lineCount, createdAt) as
        | { snapshot_id: number }
        | undefined;
      return row?.snapshot_id;
    },
    insertLineage: (snapshotId, lineNumber, lineId, canonHash, anchor) => {
      insertLineageStmt.run(snapshotId, lineNumber, lineId, canonHash, anchor);
    },
  };
}

export function ensureSnapshotSchema(db: DatabaseSync): void {
  ensureSnapshotTables(db);
}

onStoreOpen((db) => {
  ensureSnapshotSchema(db);
});

/**
 * The committed `file_snapshots.snapshot_hash` for this content — the materialization cache key
 * (spec §3.1.4). Callers that serve content name it so lease granting binds to the served
 * snapshot rather than whichever snapshot was created most recently.
 */
export function snapshotHashFor(content: string): string {
  return cacheKey(contentChecksum(content));
}

/**
 * `line_id` -> current line coordinate for the content being edited (spec §3.1.1 steps 2-4).
 *
 * Prefers the committed `line_lineage(C)` when C has been materialized (the canonical pairing of
 * record, and what the read/edit load path writes before the edit runs); otherwise pairs S_latest
 * against the in-memory content so preview/no-persist and working-buffer edits still resolve leased
 * identities without writing a snapshot or touching `served_leases`.
 */
export function positionsByIdentity(
  store: HashStore,
  path: string,
  content: string,
): Map<number, number> {
  const stmts = snapshotStmts(store.db);
  const row = stmts.findSnapshot(path, cacheKey(contentChecksum(content)));
  if (row) {
    const map = new Map<number, number>();
    for (const entry of stmts.lineageIdentities(row.snapshot_id)) {
      map.set(entry.line_id, entry.line_number);
    }
    return map;
  }
  const latest = stmts.latestSnapshot(path);
  if (!latest) return new Map();
  const previous = stmts.lineageIdentities(latest.snapshot_id);
  if (previous.length === 0) return new Map();
  const byCurrLine = pairAgainstLatest(store, path, splitLines(content)).inherited;
  const map = new Map<number, number>();
  for (const [currLine, lineId] of byCurrLine) {
    map.set(lineId, currLine);
  }
  return map;
}

function cacheKey(checksum: string): string {
  return `${CANON_VERSION}:${checksum}`;
}

function canonHashOf(line: string): string {
  return String(xxh32(canon(line)));
}

export function getSnapshot(
  store: HashStore,
  path: string,
  content: string,
  deleteCorrupt = true,
): string[] | undefined {
  const snapshotHash = cacheKey(contentChecksum(content));
  const row = snapshotStmts(store.db).findSnapshot(path, snapshotHash);
  if (!row) return undefined;
  const anchors = snapshotStmts(store.db)
    .lineageAnchors(row.snapshot_id)
    .map((entry) => entry.anchor);
  if (anchors.length !== row.line_count || !isValidHashList(anchors)) {
    if (deleteCorrupt) {
      withBusyRetry(() => {
        snapshotStmts(store.db).deleteSnapshot(row.snapshot_id);
      });
    }
    return undefined;
  }
  return anchors;
}

/**
 * The committed `line_lineage` anchors of `(path, snapshotHash)`. `undo_last_edit` serves these
 * verbatim when it adopts the pinned snapshot (spec §3.1.4 step 4: anchors are never re-derived),
 * so the restored rows are exactly the rows the adopted `line_id`s were leased for.
 */
export async function anchorsForSnapshotHash(
  path: string,
  snapshotHash: string,
): Promise<string[] | undefined> {
  const store = await loadHashStore();
  const row = snapshotStmts(store.db).findSnapshot(path, snapshotHash);
  if (!row) return undefined;
  const anchors = snapshotStmts(store.db)
    .lineageAnchors(row.snapshot_id)
    .map((entry) => entry.anchor);
  if (anchors.length !== row.line_count || !isValidHashList(anchors)) return undefined;
  return anchors;
}

/**
 * The cohesive bundle every snapshot materialization seam takes: the file a snapshot belongs to,
 * the committed cache key that addresses it, and the line count / hashes / content that define it.
 */
export interface SnapshotDescriptor {
  path: string;
  /** The `file_snapshots.snapshot_hash` cache key — `CANON_VERSION:xxh64(content)` (spec §3.1.4). */
  snapshotHash: string;
  lineCount: number;
  hashes: string[];
  content: string;
  /**
   * The caller's authoritative per-line identity (1-based line number -> `line_id`), one entry per
   * line of `content`, `null` for a line the caller created and has not allocated yet.
   *
   * WHY: the edit commit path already knows every surviving line's `line_id` from its in-memory
   * WHY: working buffer (spec §3.2.4 step 1: "Surviving unmodified lines preserve their exact
   * WHY: line_ids from the working buffer map (0% diffing, 100% exact)"). Passing the map here makes
   * WHY: the commit persist it verbatim; only `null` entries take fresh counter ids. When absent the
   * WHY: engine derives identities by pairing against `S_latest` — that is the READ-path
   * WHY: materialization mechanism (a read has no working buffer, only content to align).
   */
  lineIds?: readonly (number | null)[];
}

export function upsertSnapshot(
  store: HashStore,
  descriptor: SnapshotDescriptor,
  options?: HashSnapshotUpsertOptions,
): void {
  materializeSnapshot(store, descriptor, {
    retireLeases: options?.retireLeases === true,
    ...(options?.leases !== undefined ? { leases: options.leases } : {}),
  });
}

/**
 * The served rows a materialization leases inside its own `BEGIN IMMEDIATE` (spec §3.1.2 step 5):
 * the `serve` of the lines whose content this transaction commits — the read window on the read
 * path, the diff rows on the edit path, the restored rows on the undo path. Carried by
 * `SnapshotAdoptOptions` so the grant shares the transaction instead of running as a second one.
 */
export interface LeaseGrant {
  sessionKey: string;
  rows: ReadonlyArray<{ position: number; hash: string | null }>;
}

/**
 * Adoption options: `retireLeases` plus the served rows to lease in the same transaction.
 */
export type SnapshotAdoptOptions = HashSnapshotUpsertOptions;

/**
 * Adopts the committed snapshot named by `descriptor.snapshotHash` (or materializes it on a
 * retention miss) inside `BEGIN IMMEDIATE` / `withBusyRetry`. Callers that hold an explicit pin —
 * `undo_last_edit` reads `file_undo.snapshot_hash` (spec §3.1.2) — pass it so the restore binds to
 * the canonical snapshot instead of re-deriving the hash, and so a cache hit provably issues zero
 * `line_id_counters` allocations.
 *
 * `options.leases` makes the adoption the WHOLE restore transaction: the authoritative
 * retirement update and the served-line lease upsert commit or roll back together with it.
 */
export async function adoptPinnedSnapshotFor(
  descriptor: SnapshotDescriptor,
  options?: SnapshotAdoptOptions,
): Promise<void> {
  const store = await loadHashStore();
  materializeSnapshot(store, descriptor, {
    retireLeases: options?.retireLeases === true,
    ...(options?.leases !== undefined ? { leases: options.leases } : {}),
  });
}

interface InheritedIdentities {
  /** current line number -> `line_id` inherited from S_latest (spec §3.1.3.2). */
  inherited: Map<number, number>;
}

/**
 * Indexes the caller's working-buffer identity array for the commit: entry `i` is line `i + 1`,
 * `null` meaning "created by this batch, allocate a fresh id". Absent entries (a caller whose map and
 * content lengths disagree) are treated as created lines, so identity is never guessed.
 */
function workingBufferIdentities(
  lineIds: readonly (number | null)[],
  lineCount: number,
): Map<number, number> {
  const inherited = new Map<number, number>();
  for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
    const lineId = lineIds[lineNumber - 1];
    if (typeof lineId === "number") inherited.set(lineNumber, lineId);
  }
  return inherited;
}

/**
 * Pairs S_final's lines against S_latest (spec §3.1.3.2 / §3.2.4 step 1): every line the patience
 * engine pairs keeps its exact previous `line_id`; unpaired lines are the batch's inserted lines and
 * take a fresh counter block. With no prior snapshot for the path, every line is unpaired.
 */
function pairAgainstLatest(store: HashStore, path: string, lines: string[]): InheritedIdentities {
  const inherited = new Map<number, number>();
  const stmts = snapshotStmts(store.db);
  const latest = stmts.latestSnapshot(path);
  if (!latest) return { inherited };
  const previous = stmts.lineageIdentities(latest.snapshot_id);
  if (previous.length === 0) return { inherited };
  const prevLines: LineDescriptor[] = previous.map((row) => ({
    lineNumber: row.line_number,
    canonHash: row.canon_hash,
  }));
  const currLines: LineDescriptor[] = lines.map((line, index) => ({
    lineNumber: index + 1,
    canonHash: canonHashOf(line),
  }));
  const byLineNumber = new Map(previous.map((row) => [row.line_number, row.line_id]));
  for (const [prevLine, currLine] of pairSnapshots(prevLines, currLines)) {
    const lineId = byLineNumber.get(prevLine);
    if (lineId !== undefined) inherited.set(currLine, lineId);
  }
  return { inherited };
}

/** The one transaction's own options: retirement is authoritative-only, `leases` adds the grant. */
interface MaterializePlan {
  retireLeases: boolean;
  leases?: LeaseGrant;
}

/**
 * The lease-grant step of the materialization transaction (spec §3.1.2 step 5): leases the served
 * rows bound to the snapshot the transaction just committed. Runs on the caller's open
 * `BEGIN IMMEDIATE` and lets a failure propagate, so snapshot, lineage, retirement and leases
 * commit or roll back as one unit.
 */
function grantMaterializedLeases(
  db: DatabaseSync,
  leases: LeaseGrant | undefined,
  path: string,
  snapshotHash: string,
): void {
  if (!leases) return;
  grantLeasesInTransaction(db, leases.sessionKey, path, leases.rows, snapshotHash);
}

// WHY: soft-overflow throttle (spec §3.6.1, ADR-0017): the vacuum runs after every
// WHY: authoritative materialization, so an unthrottled warning would fire on every read and edit
// WHY: while the store stays over the soft cap. The chosen rule is transition-in per store
// WHY: instance: warn only on the false -> true transition of `overSoftOverflow` for a given
// WHY: `DatabaseSync`, stay silent while the overflow persists, and re-arm when a pass reports
// WHY: no overflow so the next episode warns again. Keyed by `DatabaseSync` (the store instance),
// WHY: so a reopened store warns afresh. Observability only: never throws, never evicts, never
// WHY: alters the caller result.
const softOverflowWarnedByDb = new WeakMap<DatabaseSync, boolean>();

/**
 * Emit the one operator-visible soft-overflow warning for a vacuum pass (spec §3.6.1).
 * Warns only when `result.overSoftOverflow` holds and only on the transition into that state
 * for the given store instance; silent otherwise. Never throws: a diagnostic failure must not
 * fail the read or edit that already committed.
 */
export function reportVacuumSoftOverflow(db: DatabaseSync, result: VacuumResult): void {
  try {
    if (!result.overSoftOverflow) {
      softOverflowWarnedByDb.set(db, false);
      return;
    }
    if (softOverflowWarnedByDb.get(db) === true) return;
    softOverflowWarnedByDb.set(db, true);
    console.warn(
      `[snapshot-store] vacuum soft overflow: totalBytes=${result.totalBytes} ` +
        `pinnedBytes=${result.pinnedBytes} deferredBytes=${result.deferredBytes} ` +
        `over the 50 MB budget; pinned snapshots are never evicted and this state ` +
        `is expected to lapse as leases expire.`,
    );
  } catch {
    // SAFETY: observability only — a broken diagnostic sink must never fail the caller.
  }
}

/**
 * Commits (or adopts) the canonical snapshot for `(path, snapshotHash)` and returns its id so the
 * caller-owned vacuum can protect the in-flight row. `undefined` is unreachable at the outermost
 * call: a conflict re-enters with `isConflictRetry` and throws if it cannot adopt a canonical row.
 */
function materializeSnapshot(
  store: HashStore,
  descriptor: SnapshotDescriptor,
  plan: MaterializePlan,
  isConflictRetry = false,
): number | undefined {
  const { path, snapshotHash, lineCount, hashes, content } = descriptor;
  const { retireLeases, leases } = plan;
  const lines = splitLines(content);
  // WHY: retirement is conditional on an authoritative materialization (spec §3.1.3.3 / §3.2.4 step
  // WHY: 4): the default is `false` so in-memory working-buffer snapshots — and any content that has
  // WHY: not reached disk yet — can never retire the leases a session still validly holds.
  const snapshotId = withBusyRetry(() => {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const stmts = snapshotStmts(store.db);
      // WHY: the pre-allocation snapshot cache guard (spec §3.2.4 step 2): a committed row for
      // WHY: `(path, snapshot_hash)` already pins canonical `line_id`s. Adopting it here means a
      // WHY: cyclical edit (`bar` -> `foo` -> `bar`) or an undo revert allocates ZERO counter ids and
      // WHY: never reaches the UNIQUE (path, snapshot_hash) insert, so it cannot rewrite canonical
      // WHY: lineage or waste surrogate ids. Retirement still runs: the adopted snapshot may predate
      // WHY: leases the current content no longer covers.
      const existing = stmts.findSnapshot(path, snapshotHash);
      if (existing) {
        if (retireLeases) {
          retireAbsentLeases(store.db, path, existing.snapshot_id, Date.now());
        }
        grantMaterializedLeases(store.db, leases, path, snapshotHash);
        store.db.exec("COMMIT");
        return existing.snapshot_id;
      }
      // WHY: survivors keep their exact `line_id`s (spec §3.2.4 step 1). The edit commit path hands
      // WHY: in the working buffer's map, so its identities are taken verbatim (0% diffing); the
      // WHY: read path has no working buffer, so there the engine pairs against S_latest. Either way
      // WHY: only the lines left unidentified (the batch's inserted lines) take fresh ids.
      const inherited = descriptor.lineIds
        ? workingBufferIdentities(descriptor.lineIds, lines.length)
        : pairAgainstLatest(store, path, lines).inherited;
      let freshIds = 0;
      for (let lineNumber = 1; lineNumber <= hashes.length; lineNumber++) {
        if (!inherited.has(lineNumber)) freshIds++;
      }
      const startId = freshIds > 0 ? stmts.allocateLineIds(path, freshIds) : 0;
      const insertedId = stmts.insertSnapshot(path, snapshotHash, lineCount, Date.now());
      if (insertedId === undefined) {
        // WHY: a concurrent writer committed `(path, snapshot_hash)` first (spec §3.2.4 step 3): the
        // WHY: whole transaction — counter block included — is discarded and the canonical snapshot
        // WHY: adopted, so no locally allocated id survives and no unique index is violated.
        store.db.exec("ROLLBACK");
        if (isConflictRetry) {
          throw new Error(
            `Unresolvable snapshot conflict for ${path} (${snapshotHash}): canonical row missing after conflict.`,
          );
        }
        return materializeSnapshot(store, descriptor, plan, true);
      }
      let nextFreshId = startId;
      for (let i = 0; i < hashes.length; i++) {
        const lineNumber = i + 1;
        const lineId = inherited.get(lineNumber) ?? nextFreshId++;
        stmts.insertLineage(
          insertedId,
          lineNumber,
          lineId,
          canonHashOf(lines[i] ?? ""),
          hashes[i]!,
        );
      }
      // WHY: `retireLeases` is `true` only for an authoritative materialization (spec §3.1.3): leases
      // WHY: whose line_id is absent from the snapshot just committed are retired here, inside the same
      // WHY: transaction, so the edit/resolve path stays strictly read-only.
      if (retireLeases) {
        retireAbsentLeases(store.db, path, insertedId, Date.now());
      }
      // WHY: the lease grant is step 5 of the materialization transaction (spec §3.1.2): the
      // WHY: served leases commit with the snapshot and lineage, so a failure here rolls the
      // WHY: lineage back instead of leaving committed identity without leases for content
      // WHY: already served (read window, edit diff) or already on disk (undo restore).
      grantMaterializedLeases(store.db, leases, path, snapshotHash);
      store.db.exec("COMMIT");
      return insertedId;
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch (rollbackError: unknown) {
        // SAFETY: best-effort rollback — the original failure is authoritative; a failed rollback of an already-aborted transaction must not mask it.
        console.error("[snapshot-store] failed to rollback transaction:", rollbackError);
      }
      throw error;
    }
  });
  // WHY: a fresh commit is exactly when a path's retention window can overflow, so the vacuum runs
  // WHY: after the transaction (never inside it — it owns `BEGIN IMMEDIATE`). The retry recursion
  // WHY: above skips this so one materialization vacuums once, and a vacuum failure can never fail
  // WHY: the read/edit that already committed. The just-materialized row is protected: its leases
  // WHY: committed inside the transaction, and an unpinned in-flight row would otherwise be the
  // WHY: sweep's first candidate in an over-budget store.
  if (!isConflictRetry) {
    try {
      const vacuumResult = vacuumSnapshots(
        store.db,
        snapshotId === undefined ? {} : { protectSnapshotIds: [snapshotId] },
      );
      reportVacuumSoftOverflow(store.db, vacuumResult);
    } catch (error) {
      // SAFETY: best-effort retention — the snapshot is committed and the tool result is valid; a
      // SAFETY: missed pass only defers eviction to the next materialization or store open.
      console.error("[snapshot-store] vacuum failed:", error);
    }
  }
  return snapshotId;
}

export function snapshotIOFor(store: HashStore): HashSnapshotIO {
  return {
    async get(path, content, deleteCorrupt) {
      return getSnapshot(store, path, content, deleteCorrupt);
    },
    async upsert(path, checksum, lineCount, hashes, content, options) {
      upsertSnapshot(
        store,
        { path, snapshotHash: cacheKey(checksum), lineCount, hashes, content },
        options,
      );
    },
  };
}

setDefaultHashSnapshotIO({
  async get(path, content, deleteCorrupt) {
    const store = await loadHashStore();
    return getSnapshot(store, path, content, deleteCorrupt);
  },
  async upsert(path, checksum, lineCount, hashes, content, options) {
    const store = await loadHashStore();
    upsertSnapshot(
      store,
      { path, snapshotHash: cacheKey(checksum), lineCount, hashes, content },
      options,
    );
  },
});

onStoreOpen(() => {
  setDefaultHashSnapshotIO({
    async get(path, content, deleteCorrupt) {
      const store = await loadHashStore();
      return getSnapshot(store, path, content, deleteCorrupt);
    },
    async upsert(path, checksum, lineCount, hashes, content, options) {
      const store = await loadHashStore();
      upsertSnapshot(
        store,
        { path, snapshotHash: cacheKey(checksum), lineCount, hashes, content },
        options,
      );
    },
  });
});

export async function pruneMissingAll(): Promise<void> {
  const store = await loadHashStore();
  await pruneMissing(store);
}

export async function upsertSnapshotFor(
  descriptor: SnapshotDescriptor,
  options?: HashSnapshotUpsertOptions,
): Promise<void> {
  const store = await loadHashStore();
  upsertSnapshot(store, descriptor, options);
}

const STAT_BATCH = 64;

async function statMissing(rows: { path: string }[]): Promise<string[]> {
  const missing: string[] = [];
  for (let i = 0; i < rows.length; i += STAT_BATCH) {
    const batch = rows.slice(i, i + STAT_BATCH);
    const results = await Promise.all(
      batch.map(async (row) => {
        try {
          await stat(row.path);
          return undefined;
        } catch {
          return row.path;
        }
      }),
    );
    for (const path of results) {
      if (path !== undefined) missing.push(path);
    }
  }
  return missing;
}

export async function pruneMissing(store: HashStore): Promise<void> {
  const rows = snapshotStmts(store.db).allPaths();
  const missing = await statMissing(rows);
  if (missing.length === 0) return;
  withStore(() => {
    const stmts = snapshotStmts(store.db);
    for (const path of missing) {
      // WHY: the counter guard is evaluated BEFORE the purge deletes anything (spec §3.6.3): the
      // WHY: counter is the never-rewinding id authority, so a path that still held a snapshot or a
      // WHY: lease when pruning began keeps its id block. Counted after the deletes, both counts
      // WHY: always read 0 and the counter was wiped for every missing path, letting a re-created
      // WHY: file restart an id block that a surviving anchor still claims.
      const heldIdentity = stmts.countSnapshots(path) > 0 || stmts.countLeases(path) > 0;
      stmts.deleteByPath(path);
      deleteUndo(store, path);
      deleteServedByPath(store, path);
      // WHY: dropped only for a path that was already without snapshot and lease and is absent from
      // WHY: disk — the only state in which no surviving anchor can still claim one of its ids.
      if (!heldIdentity) {
        stmts.deleteCounter(path);
      }
    }
  });
}

onStoreOpen(async (db, { existed }) => {
  if (existed) return;
  await migrateLegacyStore(db);
});
