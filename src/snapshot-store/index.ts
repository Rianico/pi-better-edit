import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { contentChecksum } from "../hashline/hasher.js";
import {
  isValidHashList,
  CANON_VERSION,
  ANCHOR_GENERATION,
  canonDigest,
  setDefaultHashSnapshotIO,
  type HashSnapshotIO,
  type HashSnapshotUpsertOptions,
} from "../hashline/hash.js";
import { DomainError } from "../domain-errors.js";
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
  recordServedMirrorInTransaction,
  retireAbsentLeases,
} from "../served-session/session.js";
import { pairSnapshots, type LineDescriptor } from "../hashline/patience-pairing.js";
import { vacuumSnapshots } from "./vacuum.js";
import type { VacuumResult } from "./vacuum.js";
import { migrateLegacyStore } from "./migrate.js";

export { vacuumSnapshots };
export type { VacuumResult };
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
import { reportDiagnostic, reportWarning } from "../diagnostics.js";

interface SnapshotRef {
  snapshot_id: number;
  line_count: number;
  // WHY: provenance is recorded, not inferred from the key prefix — a 0/foreign
  // WHY: anchor generation is a miss even under a current-generation key (poisoned store).
  anchor_generation: number;
}

/** The row a stat-identity adoption names: the committed snapshot for one file version (ADR-0043). */
interface StatSnapshotRef extends SnapshotRef {
  snapshot_hash: string;
}

interface SnapshotStmts {
  findSnapshot: (path: string, snapshotHash: string) => SnapshotRef | undefined;
  findSnapshotByStat: (path: string, statKey: string) => StatSnapshotRef | undefined;
  lineageAnchors: (snapshotId: number) => { anchor: string }[];
  /** The lineage rows of a half-open 1-based line-number range, in line order (ADR-0043 page read). */
  lineageRange: (
    snapshotId: number,
    fromLine: number,
    toLine: number,
  ) => { line_number: number; anchor: string; canon_hash: string }[];
  setSnapshotStatKey: (snapshotId: number, statKey: string) => void;
  latestSnapshot: (path: string) => { snapshot_id: number } | undefined;
  lineageIdentities: (
    snapshotId: number,
  ) => { line_number: number; line_id: number; canon_hash: string }[];
  allPaths: () => { path: string }[];
  countSnapshots: (path: string) => number;
  countLeases: (path: string) => number;
  deleteCounter: (path: string) => void;
  deleteSnapshot: (snapshotId: number) => void;
  deleteLineage: (snapshotId: number) => void;
  deleteByPath: (path: string) => void;
  allocateLineIds: (path: string, count: number) => number;
  insertSnapshot: (
    path: string,
    snapshotHash: string,
    lineCount: number,
    createdAt: number,
    statKey: string | undefined,
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

function snapshotStmts(db: DatabaseSync): SnapshotStmts {
  return getCached(db, stmtsCache, buildStmts);
}

function buildStmts(db: DatabaseSync): SnapshotStmts {
  const findStmt = db.prepare(
    "SELECT snapshot_id, line_count, anchor_generation FROM file_snapshots " +
      "WHERE path = ? AND snapshot_hash = ? AND committed = 1",
  );
  // WHY: (ADR-0043) the adoption lookup names the FILE VERSION, not the content: a matching stat
  // WHY: identity is what lets the read path resolve one page of lineage instead of materializing
  // WHY: every anchor. Newest first so a re-stamped row (a fallback adoption) wins over a stale one.
  const findStatStmt = db.prepare(
    "SELECT snapshot_id, snapshot_hash, line_count, anchor_generation FROM file_snapshots " +
      "WHERE path = ? AND stat_key = ? AND committed = 1 " +
      "ORDER BY created_at DESC, snapshot_id DESC LIMIT 1",
  );
  const lineageRangeStmt = db.prepare(
    "SELECT line_number, anchor, canon_hash FROM line_lineage " +
      "WHERE snapshot_id = ? AND line_number >= ? AND line_number <= ? ORDER BY line_number ASC",
  );
  const setStatKeyStmt = db.prepare("UPDATE file_snapshots SET stat_key = ? WHERE snapshot_id = ?");
  const lineageStmt = db.prepare(
    "SELECT anchor FROM line_lineage WHERE snapshot_id = ? ORDER BY line_number ASC",
  );
  const latestSnapshotStmt = db.prepare(
    "SELECT snapshot_id FROM file_snapshots WHERE path = ? AND committed = 1 AND anchor_generation = ? " +
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
  // WHY: generation-mismatch deletes purge lineage explicitly (same no-CASCADE rule
  // WHY: as the by-path purge above).
  const deleteLineageBySnapshotStmt = db.prepare("DELETE FROM line_lineage WHERE snapshot_id = ?");
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
    "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation, stat_key) " +
      "VALUES (?, ?, ?, ?, 1, ?, ?) " +
      "ON CONFLICT(path, snapshot_hash) DO NOTHING " +
      "RETURNING snapshot_id",
  );
  const insertLineageStmt = db.prepare(
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) " +
      "VALUES (?, ?, ?, ?, ?)",
  );
  return {
    findSnapshot: (...params) => findStmt.get(...params) as SnapshotRef | undefined,
    // SAFETY: `node:sqlite` returns untyped rows; the SELECT above lists exactly `anchor`.
    lineageAnchors: (...params) => lineageStmt.all(...params) as unknown as { anchor: string }[],
    latestSnapshot: (path: string) =>
      latestSnapshotStmt.get(path, ANCHOR_GENERATION) as { snapshot_id: number } | undefined,
    // SAFETY: `node:sqlite` returns untyped rows; the SELECT above lists exactly these columns.
    findSnapshotByStat: (...params) => findStatStmt.get(...params) as StatSnapshotRef | undefined,
    lineageRange: (...params) =>
      lineageRangeStmt.all(...params) as unknown as {
        line_number: number;
        anchor: string;
        canon_hash: string;
      }[],
    setSnapshotStatKey: (snapshotId, statKey) => setStatKeyStmt.run(statKey, snapshotId),
    lineageIdentities: (...params) =>
      lineageIdentitiesStmt.all(...params) as unknown as {
        line_number: number;
        line_id: number;
        canon_hash: string;
      }[],
    // SAFETY: `node:sqlite` returns untyped rows; the SELECT above lists exactly `path`.
    allPaths: () => allPathsStmt.all() as unknown as { path: string }[],
    deleteSnapshot: (snapshotId) => deleteSnapshotStmt.run(snapshotId),
    deleteLineage: (snapshotId) => deleteLineageBySnapshotStmt.run(snapshotId),
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
    insertSnapshot: (path, snapshotHash, lineCount, createdAt, statKey) => {
      const row = insertSnapshotStmt.get(
        path,
        snapshotHash,
        lineCount,
        createdAt,
        ANCHOR_GENERATION,
        statKey ?? null,
      ) as { snapshot_id: number } | undefined;
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
  // WHY: single-owner anchor-generation gate — findSnapshot returns the row regardless of
  // WHY: provenance, so this reader applies the same anchor_generation miss as getSnapshot:
  // WHY: a poisoned current-key row is never a pairing source. The miss falls through
  // WHY: to the generation-gated latestSnapshot below.
  if (row && row.anchor_generation === ANCHOR_GENERATION) {
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
  return `${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}`;
}

export function getSnapshot(
  store: HashStore,
  path: string,
  content: string,
  corruptPolicy: "delete" | "keep" = "delete",
): string[] | undefined {
  const snapshotHash = cacheKey(contentChecksum(content));
  const row = snapshotStmts(store.db).findSnapshot(path, snapshotHash);
  if (!row) return undefined;
  // WHY: provenance over key prefix — a current-generation key can still name a
  // WHY: poisoned row (written before the column existed). Unknown/foreign
  // WHY: anchor generation is a miss that deletes, like any corrupt row.
  if (row.anchor_generation !== ANCHOR_GENERATION) {
    if (corruptPolicy === "delete") {
      withBusyRetry(() => {
        snapshotStmts(store.db).deleteSnapshot(row.snapshot_id);
        snapshotStmts(store.db).deleteLineage(row.snapshot_id);
      });
    }
    return undefined;
  }
  const anchors = snapshotStmts(store.db)
    .lineageAnchors(row.snapshot_id)
    .map((entry) => entry.anchor);
  if (anchors.length !== row.line_count || !isValidHashList(anchors)) {
    if (corruptPolicy === "delete") {
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
/** Whether a snapshot cache key belongs to the current anchor generation. Single owner: the middle component. */
export function isCurrentAnchorGeneration(snapshotHash: string): boolean {
  // WHY: named destructure — the middle component is the anchor axis; the canon leads, the checksum trails.
  const [, generation] = snapshotHash.split(":");
  return generation === String(ANCHOR_GENERATION);
}
export async function anchorsForSnapshotHash(
  path: string,
  snapshotHash: string,
): Promise<string[] | undefined> {
  // WHY: a foreign-generation descriptor is never resolved — its anchors were
  // WHY: derived under another anchor generation and must not be leased or edited.
  if (!isCurrentAnchorGeneration(snapshotHash)) return undefined;
  const store = await loadHashStore();
  const row = snapshotStmts(store.db).findSnapshot(path, snapshotHash);
  if (!row || row.anchor_generation !== ANCHOR_GENERATION) return undefined;
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
  /** The `file_snapshots.snapshot_hash` cache key — `CANON_VERSION:ANCHOR_GENERATION:xxh64(content)` (spec §3.1.4). */
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

function planFor(options?: HashSnapshotUpsertOptions): MaterializePlan {
  return {
    retireLeases: options?.retireLeases === true,
    ...(options?.leases !== undefined ? { leases: options.leases } : {}),
    ...(options?.servedMirror !== undefined ? { servedMirror: options.servedMirror } : {}),
    ...(options?.statKey !== undefined ? { statKey: options.statKey } : {}),
  };
}

export function upsertSnapshot(
  store: HashStore,
  descriptor: SnapshotDescriptor,
  options?: HashSnapshotUpsertOptions,
): void {
  materializeSnapshot(store, descriptor, planFor(options));
}

/**
 * The served rows a materialization leases inside its own `BEGIN IMMEDIATE` (spec §3.1.2 step 5):
 * the `serve` of the lines whose content this transaction commits — the read window on the read
 * path, the diff rows on the edit path, the restored rows on the undo path. Carried by
 * `SnapshotAdoptOptions` so the grant shares the transaction instead of running as a second one.
 */
interface LeaseGrant {
  sessionKey: string;
  rows: ReadonlyArray<{ position: number; hash: string | null }>;
}

/**
 * Adoption options: `retireLeases`, the served rows to lease in the same transaction, and the
 * served mirror write (`servedMirror`) that belongs with them — CAND-3 makes the whole post-write
 * commit (snapshot + lineage + retirement + lease grant + mirror) one `BEGIN IMMEDIATE` unit.
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
 * `options.servedMirror` folds the served mirror write (and undo's displaced-anchor retirement)
 * into that same transaction, so no torn lease/mirror state can survive a mid-commit failure.
 */
export async function adoptPinnedSnapshotFor(
  descriptor: SnapshotDescriptor,
  options?: SnapshotAdoptOptions,
): Promise<void> {
  // WHY: a foreign-generation descriptor must never write lineage — its anchors
  // WHY: were derived under another anchor generation. Fail closed (programmer error),
  // WHY: never adopt verbatim.
  if (!isCurrentAnchorGeneration(descriptor.snapshotHash)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Refusing to adopt snapshot from another anchor generation: ${JSON.stringify(descriptor.snapshotHash)}.`,
    });
  }
  const store = await loadHashStore();
  materializeSnapshot(store, descriptor, planFor(options));
}

/**
 * One lineage row a stat-matched page read resolves (ADR-0043): the anchor to serve and the canon
 * digest the snapshot committed that line under, which the caller re-verifies against the bytes it
 * is about to show. A page that cannot be proven falls back to content-hash materialization — never
 * a stale anchor.
 */
interface StatLineageRow {
  lineNumber: number;
  anchor: string;
  canonHash: string;
}

/**
 * A committed snapshot selected by file version (ADR-0043). `anchorsInRange` is page-priced: one PK
 * range scan over `line_lineage`, never a materialization of the whole file's identity. Throws when
 * the range is not fully present — provenance it cannot prove is provenance it will not serve.
 */
export interface StatMatchedSnapshot {
  snapshotHash: string;
  /** The content checksum carried by `snapshotHash` — the epoch suffix a read reports. */
  checksum: string;
  lineCount: number;
  anchorsInRange: (start: number, end: number) => StatLineageRow[];
}

function checksumOf(snapshotHash: string): string | undefined {
  const generationSeparator = snapshotHash.indexOf(":");
  const checksumSeparator =
    generationSeparator < 0 ? -1 : snapshotHash.indexOf(":", generationSeparator + 1);
  return checksumSeparator < 0 ? undefined : snapshotHash.slice(checksumSeparator + 1);
}

/**
 * Finds the committed snapshot whose stamped stat identity names this file version (ADR-0043).
 *
 * Best-effort by design: a missing row, a foreign anchor generation, or an unreadable store is a
 * MISS, never an error — the caller falls back to content-hash materialization, which is the only
 * path that can prove an absent snapshot wrong or right.
 */
export async function findStatSnapshotFor(
  path: string,
  statKey: string,
): Promise<StatMatchedSnapshot | undefined> {
  let store: Awaited<ReturnType<typeof loadHashStore>>;
  try {
    store = await loadHashStore();
  } catch (error) {
    console.error("pi-better-edit: stat-identity lookup skipped:", error);
    return undefined;
  }
  try {
    const stmts = snapshotStmts(store.db);
    const row = stmts.findSnapshotByStat(path, statKey);
    if (
      row === undefined ||
      row.anchor_generation !== ANCHOR_GENERATION ||
      !isCurrentAnchorGeneration(row.snapshot_hash)
    ) {
      return undefined;
    }
    const checksum = checksumOf(row.snapshot_hash);
    if (checksum === undefined) {
      return undefined;
    }
    return {
      snapshotHash: row.snapshot_hash,
      checksum,
      lineCount: row.line_count,
      anchorsInRange: (start, end) => {
        const rows = stmts.lineageRange(row.snapshot_id, start + 1, end);
        if (rows.length !== end - start) {
          throw new Error(
            `stat-identity snapshot ${row.snapshot_id} has ${rows.length} lineage rows for lines ` +
              `${start + 1}-${end}; expected ${end - start}.`,
          );
        }
        return rows.map((line) => ({
          lineNumber: line.line_number,
          anchor: line.anchor,
          canonHash: line.canon_hash,
        }));
      },
    };
  } catch (error) {
    console.error("pi-better-edit: stat-identity lookup skipped:", error);
    return undefined;
  }
}

/** The file version an adoption restates: the path, its `stat(2)` identity, and the content it names. */
export interface StatSnapshotAdoption {
  path: string;
  statKey: string;
  snapshotHash: string;
}

/**
 * Adopts an already-committed snapshot on stat identity alone (ADR-0043): no content is hashed, no
 * lineage is written, only the leases and mirror a materialization owns are recorded.
 *
 * Returns `false` when the snapshot is no longer the row this file version names (a concurrent vacuum
 * or a re-stamp won the race). The caller must then take the content-hash path: it is the only writer
 * allowed to decide what this content's identity is. Retirement stays authoritative — a cache-hit read
 * still retires the leases its snapshot no longer covers (ADR-0042 §3.1.3).
 */
export async function adoptStatSnapshotFor(
  adoption: StatSnapshotAdoption,
  options?: SnapshotAdoptOptions,
): Promise<boolean> {
  if (!isCurrentAnchorGeneration(adoption.snapshotHash)) {
    return false;
  }
  const store = await loadHashStore();
  const plan = planFor(options);
  return withBusyRetry(() => {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const row = snapshotStmts(store.db).findSnapshotByStat(adoption.path, adoption.statKey);
      if (
        row === undefined ||
        row.snapshot_hash !== adoption.snapshotHash ||
        row.anchor_generation !== ANCHOR_GENERATION
      ) {
        store.db.exec("ROLLBACK");
        return false;
      }
      const now = Date.now();
      // WHY: adoption cannot grow the store, so ADR-0042's retention trigger (fresh commits only)
      // WHY: stays exactly where it was — a cache-hit read never sweeps.
      if (plan.retireLeases) {
        retireAbsentLeases(store.db, adoption.path, row.snapshot_id, now);
      }
      grantMaterializedLeases(store.db, plan.leases, adoption.path, adoption.snapshotHash);
      recordMaterializedMirror(store.db, plan.servedMirror, adoption.path);
      store.db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch (rollbackError: unknown) {
        // SAFETY: best-effort rollback — the original failure is authoritative.
        console.error("[snapshot-store] failed to rollback stat adoption:", rollbackError);
      }
      throw error;
    }
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
    canonHash: canonDigest(line),
  }));
  const byLineNumber = new Map(previous.map((row) => [row.line_number, row.line_id]));
  for (const [prevLine, currLine] of pairSnapshots(prevLines, currLines)) {
    const lineId = byLineNumber.get(prevLine);
    if (lineId !== undefined) inherited.set(currLine, lineId);
  }
  return { inherited };
}

/** The one transaction's own options: retirement is authoritative-only, `leases` adds the grant, `servedMirror` the mirror write, `statKey` the observed file version (ADR-0043). */
interface MaterializePlan {
  retireLeases: boolean;
  leases?: LeaseGrant;
  servedMirror?: HashSnapshotUpsertOptions["servedMirror"];
  statKey?: string;
}

/**
 * The served-mirror step of the materialization transaction (CAND-3): writes the served mirror —
 * and the displaced-anchor retirement the record owns — on the caller's open `BEGIN IMMEDIATE`,
 * so the `served_leases` grant above and the mirror rows commit or roll back as one unit.
 */
function recordMaterializedMirror(
  db: DatabaseSync,
  mirror: HashSnapshotUpsertOptions["servedMirror"],
  path: string,
): void {
  if (!mirror) return;
  recordServedMirrorInTransaction(db, mirror.sessionKey, path, mirror.rows, {
    ...(mirror.shape !== undefined ? { shape: mirror.shape } : {}),
    ...(mirror.retireAnchors !== undefined ? { retireAnchors: mirror.retireAnchors } : {}),
  });
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
    reportWarning(
      "snapshot-store",
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
 * What the materialization body did: the canonical row plus whether THIS transaction inserted it.
 * Retention is only owed by the transaction that inserted a fresh row — adoption cannot grow the
 * store, and charging a global sweep to every read is what made the read path seconds-slow.
 */
interface MaterializedSnapshot {
  snapshotId: number;
  inserted: boolean;
}

/**
 * The materialization body: commits (or adopts) the canonical snapshot for `(path, snapshotHash)` on
 * the caller's OPEN `BEGIN IMMEDIATE`; returns `{snapshotId, inserted}`, or `undefined` when a
 * concurrent writer committed the same `(path, snapshot_hash)` first — the caller owns the rollback
 * and the retry.
 */
function materializeSnapshotInTxn(
  store: HashStore,
  descriptor: SnapshotDescriptor,
  plan: MaterializePlan,
): MaterializedSnapshot | undefined {
  const { path, snapshotHash, lineCount, hashes, content } = descriptor;
  const { retireLeases, leases, servedMirror, statKey } = plan;
  const lines = splitLines(content);
  // WHY: retirement is conditional on an authoritative materialization (spec §3.1.3.3 / §3.2.4 step
  // WHY: 4): the default is `false` so in-memory working-buffer snapshots — and any content that has
  // WHY: not reached disk yet — can never retire the leases a session still validly holds.
  const stmts = snapshotStmts(store.db);
  // WHY: the pre-allocation snapshot cache guard (spec §3.2.4 step 2): a committed row for
  // WHY: `(path, snapshot_hash)` already pins canonical `line_id`s. Adopting it here means a
  // WHY: cyclical edit (`bar` -> `foo` -> `bar`) or an undo revert allocates ZERO counter ids and
  // WHY: never reaches the UNIQUE (path, snapshot_hash) insert, so it cannot rewrite canonical
  // WHY: lineage or waste surrogate ids. Retirement still runs: the adopted snapshot may predate
  // WHY: leases the current content no longer covers.
  let existing = stmts.findSnapshot(path, snapshotHash);
  // WHY: provenance over key prefix — a poisoned row under a current-generation
  // WHY: key is deleted, not adopted; the fresh insert below re-derives
  // WHY: file-scoped anchors. Without this, every read would re-adopt and
  // WHY: re-stamp the poison forever.
  if (existing && existing.anchor_generation !== ANCHOR_GENERATION) {
    stmts.deleteLineage(existing.snapshot_id);
    stmts.deleteSnapshot(existing.snapshot_id);
    existing = undefined;
  }
  if (existing) {
    if (retireLeases) {
      retireAbsentLeases(store.db, path, existing.snapshot_id, Date.now());
    }
    grantMaterializedLeases(store.db, leases, path, snapshotHash);
    recordMaterializedMirror(store.db, servedMirror, path);
    // WHY: (ADR-0043) a content-verified adoption still records the version it was observed at, so
    // WHY: the next read of this unchanged file takes the stat path instead of the content-hash one.
    if (statKey !== undefined) stmts.setSnapshotStatKey(existing.snapshot_id, statKey);
    return { snapshotId: existing.snapshot_id, inserted: false };
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
  const insertedId = stmts.insertSnapshot(path, snapshotHash, lineCount, Date.now(), statKey);
  if (insertedId === undefined) {
    // WHY: a concurrent writer committed `(path, snapshot_hash)` first (spec §3.2.4 step 3): the
    // WHY: whole transaction — counter block included — is discarded and the canonical snapshot
    // WHY: adopted, so no locally allocated id survives and no unique index is violated.
    return undefined;
  }
  let nextFreshId = startId;
  for (const [index, hash] of hashes.entries()) {
    const lineNumber = index + 1;
    const lineId = inherited.get(lineNumber) ?? nextFreshId++;
    stmts.insertLineage(insertedId, lineNumber, lineId, canonDigest(lines[index] ?? ""), hash);
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
  // WHY: CAND-3: the served mirror is step 6 of the same transaction — the lease grant above
  // WHY: and the mirror rows commit or roll back as one unit, so a torn store state
  // WHY: (lease-without-mirror, mirror-without-lease) is structurally unreachable.
  recordMaterializedMirror(store.db, servedMirror, path);
  return { snapshotId: insertedId, inserted: true };
}
/**
 * Commits (or adopts) the canonical snapshot for `(path, snapshotHash)` in its own
 * `BEGIN IMMEDIATE`; returns `{snapshotId, inserted}` for the caller's retention decision.
 * A conflict re-enters with `isConflictRetry` and throws if it cannot adopt a canonical row.
 */
function materializeSnapshot(
  store: HashStore,
  descriptor: SnapshotDescriptor,
  plan: MaterializePlan,
): MaterializedSnapshot {
  for (let attempt = 0; ; attempt++) {
    const materialized = withBusyRetry(() => {
      store.db.exec("BEGIN IMMEDIATE");
      try {
        const committed = materializeSnapshotInTxn(store, descriptor, plan);
        if (committed === undefined) {
          store.db.exec("ROLLBACK");
          return undefined;
        }
        store.db.exec("COMMIT");
        return committed;
      } catch (error) {
        try {
          store.db.exec("ROLLBACK");
        } catch (rollbackError: unknown) {
          // SAFETY: best-effort rollback — the original failure is authoritative; a failed rollback of an already-aborted transaction must not mask it.
          reportDiagnostic(
            "snapshot-store",
            "[snapshot-store] failed to rollback transaction:",
            rollbackError,
          );
        }
        throw error;
      }
    });
    if (materialized === undefined) {
      // WHY: a concurrent writer committed the canonical row between our ROLLBACK and now (spec
      // WHY: §3.2.4 step 3) — one retry adopts it; a second miss is a store invariant violation.
      if (attempt > 0) {
        throw new Error(
          `Unresolvable snapshot conflict for ${descriptor.path} (${descriptor.snapshotHash}): canonical row missing after conflict.`,
        );
      }
      continue;
    }
    // WHY: retention is paid only by the call that inserted a fresh snapshot — a fresh commit is
    // WHY: exactly when a path's retention window can overflow. Adoption (the read-path cache hit) adds
    // WHY: no row and cannot overflow the budget; making it sweep the whole store was what turned each
    // WHY: read into seconds of pin-query CPU on a large lease table. The sweep runs after the
    // WHY: transaction (never inside it — it owns `BEGIN IMMEDIATE`), and a vacuum failure can never
    // WHY: fail the read/edit that already committed. The just-materialized row is protected: its
    // WHY: leases committed inside the transaction, and an unpinned in-flight row would otherwise be
    // WHY: the sweep's first candidate in an over-budget store.
    if (materialized.inserted) {
      try {
        const vacuumResult = vacuumSnapshots(store.db, {
          protectSnapshotIds: [materialized.snapshotId],
        });
        reportVacuumSoftOverflow(store.db, vacuumResult);
      } catch (error) {
        // SAFETY: best-effort retention — the snapshot is committed and the tool result is valid; a
        // SAFETY: missed pass only defers eviction to the next fresh commit or store open.
        console.error("[snapshot-store] vacuum failed:", error);
      }
    }
    return materialized;
  }
}

/**
 * One file's materialization ask in a multi-file batch: the descriptor to commit and the options that
 * grant its served leases inside the same transaction.
 */
export interface SnapshotEnrollment {
  descriptor: SnapshotDescriptor;
  options?: HashSnapshotUpsertOptions;
}

/**
 * Enrolls several files' materializations in ONE `BEGIN IMMEDIATE`: every descriptor's snapshot +
 * lineage + retirement + lease grant commits or rolls back as a unit, so a multi-file read can never
 * lease anchors for one file while losing another file's snapshot.
 *
 * A conflict on any descriptor rolls the whole batch back and re-enters once, which then adopts the
 * canonical rows the concurrent writer committed (see `materializeSnapshotInTxn`).
 */
function materializeBatch(
  store: HashStore,
  descriptors: readonly SnapshotDescriptor[],
  plans: readonly MaterializePlan[],
): number[] {
  for (let attempt = 0; ; attempt++) {
    const materialized = withBusyRetry(() => {
      store.db.exec("BEGIN IMMEDIATE");
      try {
        const committed: MaterializedSnapshot[] = [];
        for (const [index, descriptor] of descriptors.entries()) {
          const plan = plans[index];
          if (plan === undefined) {
            throw new Error(`Missing materialize plan at index ${index} for ${descriptor.path}`);
          }
          const outcome = materializeSnapshotInTxn(store, descriptor, plan);
          if (outcome === undefined) {
            store.db.exec("ROLLBACK");
            return undefined;
          }
          committed.push(outcome);
        }
        store.db.exec("COMMIT");
        return committed;
      } catch (error) {
        try {
          store.db.exec("ROLLBACK");
        } catch (rollbackError: unknown) {
          // SAFETY: best-effort rollback — the original failure is authoritative.
          reportDiagnostic(
            "snapshot-store",
            "[snapshot-store] failed to rollback batch transaction:",
            rollbackError,
          );
        }
        throw error;
      }
    });
    if (materialized === undefined) {
      if (attempt > 0) {
        throw new Error(
          `Unresolvable snapshot conflict for ${descriptors.map((entry) => entry.path).join(", ")}: canonical row missing after conflict.`,
        );
      }
      continue;
    }
    const snapshotIds = materialized.map((entry) => entry.snapshotId);
    // WHY: a batch where every descriptor adopted an existing row cannot grow the store, so it owes no
    // WHY: retention. This is the read path on unchanged content (`upsertSnapshotsFor`): skipping the
    // WHY: global pin scan here is what keeps a large store's reads off the vacuum query. A batch with at
    // WHY: least one fresh commit still sweeps once, after the transaction, with every in-flight row
    // WHY: protected.
    if (materialized.some((entry) => entry.inserted)) {
      try {
        const vacuumResult = vacuumSnapshots(store.db, { protectSnapshotIds: snapshotIds });
        reportVacuumSoftOverflow(store.db, vacuumResult);
      } catch (error) {
        // SAFETY: best-effort retention — the batch is committed and the tool result is valid; a missed
        // SAFETY: pass only defers eviction to the next fresh commit or store open.
        console.error("[snapshot-store] vacuum failed:", error);
      }
    }
    return snapshotIds;
  }
}

function upsertSnapshots(store: HashStore, entries: readonly SnapshotEnrollment[]): void {
  materializeBatch(
    store,
    entries.map((entry) => entry.descriptor),
    entries.map((entry) => planFor(entry.options)),
  );
}

/** Enrolls every entry's snapshot, lineage, retirement and lease grant in ONE transaction. */
export async function upsertSnapshotsFor(entries: readonly SnapshotEnrollment[]): Promise<void> {
  if (entries.length === 0) return;
  const store = await loadHashStore();
  upsertSnapshots(store, entries);
}

export function snapshotIOFor(store: HashStore): HashSnapshotIO {
  return {
    async get(path, content, deleteCorrupt) {
      return getSnapshot(store, path, content, deleteCorrupt ? "delete" : "keep");
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
    return getSnapshot(store, path, content, deleteCorrupt ? "delete" : "keep");
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
      return getSnapshot(store, path, content, deleteCorrupt ? "delete" : "keep");
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
