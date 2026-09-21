/**
 * SAFETY: ServedSession handle — deep implementation hiding HashStore, sessionKey, and healing.
 *
 * Keeps fact authority (what this session saw) inside the module. Callers get a
 * handle bound to (sessionKey, path); all storage details (sessionKey threading,
 * withStore batching, patchServed orphan healing, truncation, reported-set, TTL)
 * stay private — not part of the handle's interface. Adapter seam: HashStore
 * is injected (SQLite in prod, MemoryStore in tests) — local-substitutable.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HASH_RE } from "../hashline/alphabet.js";
import { SERVED_TTL_MS } from "../constants.js";
import {
  loadHashStore,
  onStoreOpen,
  withStore,
  withBusyRetry,
  getCached,
  type HashStore,
} from "../hash-store.js";
// WHY: snapshot retention is owned by the CAS store that owns `file_snapshots` (spec §3.6.1); the
// WHY: session module only asks for a pass at its deterministic boundary — the store open.
import { vacuumSnapshots } from "../snapshot-store";
import type { ServedRow } from "../hashline/served.js";
import type { ServeRecordPolicy, ServedEntry } from "./types.js";

// WHY: --- sessionKey authority (kept here; served-state re-exports for compat) ---
let fallbackSessionKey: string | undefined;

export function sessionKeyFor(ctx?: { sessionManager?: { getSessionId(): string } }): string {
  const fromSession = ctx?.sessionManager?.getSessionId();
  if (fromSession) return fromSession;
  fallbackSessionKey ??= randomUUID();
  return fallbackSessionKey;
}

// WHY: --- SQLite stmts (private to deep module) ---
interface ServedStmts {
  servedGet: (sessionKey: string, path: string) => Record<string, unknown> | undefined;
  servedUpsert: (sessionKey: string, path: string, hashes: string, updatedAt: number) => void;
  servedRetiredUpsert: (
    sessionKey: string,
    path: string,
    retired: string,
    updatedAt: number,
  ) => void;
  servedRetiredClear: (sessionKey: string, updatedAt: number, path: string) => void;
  servedSnapshotUpsert: (
    sessionKey: string,
    path: string,
    snapshotId: string,
    updatedAt: number,
  ) => void;
  servedSnapshotClear: (sessionKey: string, updatedAt: number, path: string) => void;
  servedDelete: (sessionKey: string, path: string) => void;
  servedDeletePath: (path: string) => void;
  servedWipe: (sessionKey: string) => void;
  servedPruneOlderThan: (updatedBefore: number) => void;
  snapshotByHash: (path: string, snapshotHash: string) => LeaseSnapshot | undefined;
  lineageAnchorsOf: (snapshotId: number) => LeaseLineageRow[];
  leaseUpsertMany: (
    sessionKey: string,
    path: string,
    snapshotHash: string,
    updatedAt: number,
    grants: LeaseGrant[],
  ) => void;
  leaseGet: (sessionKey: string, path: string, anchor: string) => ServedLease | undefined;
  leaseList: (sessionKey: string, path: string) => ServedLease[];
  /** `(anchor, canon_hash)` for every lease on the path — the canon-evidence lookup (#151). */
  leaseCanonHashes: (
    sessionKey: string,
    path: string,
  ) => Array<{ anchor: string; canon_hash: string }>;
  leaseHomes: (sessionKey: string, anchor: string) => string[];
  leaseRetireAbsent: (now: number, path: string, snapshotId: number) => void;
  leaseDelete: (sessionKey: string, path: string) => void;
  leaseDeletePath: (path: string) => void;
  leaseWipe: (sessionKey: string) => void;
  metaGetReported: (sessionKey: string, path: string) => { reported: string | null } | undefined;
  metaUpsertReported: (
    sessionKey: string,
    path: string,
    reported: string,
    updatedAt: number,
  ) => void;
  metaClearReported: (sessionKey: string, path: string) => void;
  metaDelete: (sessionKey: string, path: string) => void;
  metaDeletePath: (path: string) => void;
  metaWipe: (sessionKey: string) => void;
}

/** A served anchor's immutable line identity for one session and path (spec §3.1). */
export interface ServedLease {
  session_id: string;
  file_path: string;
  anchor: string;
  line_id: number;
  canon_hash: string;
  served_snapshot_hash: string;
  served_line_number: number;
  updated_at: number;
  retired_at: number | null;
}

interface LeaseGrant {
  anchor: string;
  lineId: number;
  canonHash: string;
  lineNumber: number;
}

interface LeaseSnapshot {
  snapshot_id: number;
  snapshot_hash: string;
}

interface LeaseLineageRow {
  anchor: string;
  line_id: number;
  canon_hash: string;
}

// WHY: a dense post-edit serve covers every line of the file, so leases are written in one
// WHY: multi-row upsert per chunk instead of one statement per line (Probe L: 30k lines).
const LEASE_UPSERT_CHUNK = 400;
const leaseUpsertStmts = new WeakMap<
  DatabaseSync,
  Map<number, ReturnType<DatabaseSync["prepare"]>>
>();

function leaseUpsertStatement(
  db: DatabaseSync,
  rowCount: number,
): ReturnType<DatabaseSync["prepare"]> {
  let perSize = leaseUpsertStmts.get(db);
  if (!perSize) {
    perSize = new Map();
    leaseUpsertStmts.set(db, perSize);
  }
  let stmt = perSize.get(rowCount);
  if (!stmt) {
    const values = Array.from({ length: rowCount }, () => "(?, ?, ?, ?, ?, ?, ?, ?, NULL)").join(
      ", ",
    );
    stmt = db.prepare(
      "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, " +
        "served_snapshot_hash, served_line_number, updated_at, retired_at) " +
        `VALUES ${values} ` +
        "ON CONFLICT (session_id, file_path, anchor) DO UPDATE SET " +
        "line_id = excluded.line_id, " +
        "canon_hash = excluded.canon_hash, " +
        "served_snapshot_hash = excluded.served_snapshot_hash, " +
        "served_line_number = excluded.served_line_number, " +
        "updated_at = excluded.updated_at, " +
        "retired_at = NULL",
    );
    perSize.set(rowCount, stmt);
  }
  return stmt;
}

const stmtsCache = new WeakMap<DatabaseSync, ServedStmts>();

function servedStmts(db: DatabaseSync): ServedStmts {
  return getCached(db, stmtsCache, buildStmts);
}

function buildStmts(db: DatabaseSync): ServedStmts {
  const servedGetStmt = db.prepare(
    "SELECT hashes, reported, retired, snapshotId FROM served WHERE session_id = ? AND path = ?",
  );
  const servedUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET hashes = excluded.hashes, updated_at = excluded.updated_at",
  );
  const servedRetiredUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, retired, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET retired = excluded.retired, updated_at = excluded.updated_at",
  );
  const servedRetiredClearStmt = db.prepare(
    "UPDATE served SET retired = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
  );
  const servedSnapshotUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, snapshotId, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET snapshotId = excluded.snapshotId, updated_at = excluded.updated_at",
  );
  const servedSnapshotClearStmt = db.prepare(
    "UPDATE served SET snapshotId = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
  );
  const servedDeleteStmt = db.prepare("DELETE FROM served WHERE session_id = ? AND path = ?");
  const servedDeletePathStmt = db.prepare("DELETE FROM served WHERE path = ?");
  const servedWipeStmt = db.prepare("DELETE FROM served WHERE session_id = ?");
  const servedPruneOlderThanStmt = db.prepare("DELETE FROM served WHERE updated_at < ?");
  // WHY: served_leases is the v7 identity authority (spec §3.1). The upsert is the atomic
  // WHY: re-serve contract: a re-served anchor adopts the fresh line_id and clears retired_at.
  const lineageAnchorsStmt = db.prepare(
    "SELECT anchor, line_id, canon_hash FROM line_lineage WHERE snapshot_id = ?",
  );
  // WHY: canon evidence is derived here and nowhere else (#151): the lease for the anchor a served
  // WHY: mirror row names carries the digest the served line's canon produced, so no canon text is
  // WHY: stored and no process-wide hash->canon map exists (issue #149).
  const leaseListCanonStmt = db.prepare(
    "SELECT anchor, canon_hash FROM served_leases WHERE session_id = ? AND file_path = ?",
  );
  const snapshotByHashStmt = db.prepare(
    "SELECT snapshot_id, snapshot_hash FROM file_snapshots " +
      "WHERE path = ? AND snapshot_hash = ? AND committed = 1",
  );
  const leaseGetStmt = db.prepare(
    "SELECT session_id, file_path, anchor, line_id, canon_hash, served_snapshot_hash, " +
      "served_line_number, updated_at, retired_at FROM served_leases " +
      "WHERE session_id = ? AND file_path = ? AND anchor = ?",
  );
  const leaseListStmt = db.prepare(
    "SELECT session_id, file_path, anchor, line_id, canon_hash, served_snapshot_hash, " +
      "served_line_number, updated_at, retired_at FROM served_leases " +
      "WHERE session_id = ? AND file_path = ? ORDER BY served_line_number ASC, anchor ASC",
  );
  const leaseHomesStmt = db.prepare(
    "SELECT DISTINCT file_path AS file_path FROM served_leases " +
      "WHERE session_id = ? AND anchor = ? ORDER BY file_path ASC",
  );
  const leaseRetireAbsentStmt = db.prepare(
    "UPDATE served_leases SET retired_at = ? " +
      "WHERE file_path = ? AND retired_at IS NULL " +
      "AND line_id NOT IN (SELECT line_id FROM line_lineage WHERE snapshot_id = ?)",
  );
  const leaseDeleteStmt = db.prepare(
    "DELETE FROM served_leases WHERE session_id = ? AND file_path = ?",
  );
  const leaseDeletePathStmt = db.prepare("DELETE FROM served_leases WHERE file_path = ?");
  const leaseWipeStmt = db.prepare("DELETE FROM served_leases WHERE session_id = ?");
  // WHY: drift-notice dedup lives in served_session_meta (spec §5.1 table 5), decoupled from
  // WHY: the legacy served mirror that v6 shells keep alive.
  const metaGetReportedStmt = db.prepare(
    "SELECT reported FROM served_session_meta WHERE session_id = ? AND file_path = ?",
  );
  const metaUpsertReportedStmt = db.prepare(
    "INSERT INTO served_session_meta (session_id, file_path, reported, updated_at) " +
      "VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(session_id, file_path) DO UPDATE SET " +
      "reported = excluded.reported, updated_at = excluded.updated_at",
  );
  const metaClearReportedStmt = db.prepare(
    "DELETE FROM served_session_meta WHERE session_id = ? AND file_path = ?",
  );
  const metaDeletePathStmt = db.prepare("DELETE FROM served_session_meta WHERE file_path = ?");
  const metaWipeStmt = db.prepare("DELETE FROM served_session_meta WHERE session_id = ?");
  return {
    servedGet: (...params) => servedGetStmt.get(...params) as Record<string, unknown> | undefined,
    servedUpsert: (sessionKey, path, hashes, updatedAt) => {
      withBusyRetry(() => {
        servedUpsertStmt.run(sessionKey, path, hashes, updatedAt);
      });
    },
    servedRetiredUpsert: (sessionKey, path, retired, updatedAt) => {
      withBusyRetry(() => {
        servedRetiredUpsertStmt.run(sessionKey, path, retired, updatedAt);
      });
    },
    servedRetiredClear: (sessionKey, updatedAt, path) => {
      withBusyRetry(() => {
        servedRetiredClearStmt.run(updatedAt, sessionKey, path);
      });
    },
    servedSnapshotUpsert: (sessionKey, path, snapshotId, updatedAt) => {
      withBusyRetry(() => {
        servedSnapshotUpsertStmt.run(sessionKey, path, snapshotId, updatedAt);
      });
    },
    servedSnapshotClear: (sessionKey, updatedAt, path) => {
      withBusyRetry(() => {
        servedSnapshotClearStmt.run(updatedAt, sessionKey, path);
      });
    },
    servedDelete: (sessionKey, path) => {
      withBusyRetry(() => {
        servedDeleteStmt.run(sessionKey, path);
      });
    },
    servedDeletePath: (path) => {
      withBusyRetry(() => {
        servedDeletePathStmt.run(path);
      });
    },
    servedWipe: (sessionKey) => {
      withBusyRetry(() => {
        servedWipeStmt.run(sessionKey);
      });
    },
    servedPruneOlderThan: (updatedBefore) => {
      withBusyRetry(() => {
        servedPruneOlderThanStmt.run(updatedBefore);
      });
    },
    snapshotByHash: (...params) => snapshotByHashStmt.get(...params) as LeaseSnapshot | undefined,
    lineageAnchorsOf: (...params) =>
      lineageAnchorsStmt.all(...params) as unknown as LeaseLineageRow[],
    leaseUpsertMany: (sessionKey, path, snapshotHash, updatedAt, grants) => {
      if (grants.length === 0) return;
      withBusyRetry(() => {
        for (let i = 0; i < grants.length; i += LEASE_UPSERT_CHUNK) {
          const chunk = grants.slice(i, i + LEASE_UPSERT_CHUNK);
          const params: (string | number)[] = [];
          for (const grant of chunk) {
            params.push(
              sessionKey,
              path,
              grant.anchor,
              grant.lineId,
              grant.canonHash,
              snapshotHash,
              grant.lineNumber,
              updatedAt,
            );
          }
          leaseUpsertStatement(db, chunk.length).run(...params);
        }
      });
    },
    leaseGet: (...params) => leaseGetStmt.get(...params) as ServedLease | undefined,
    leaseList: (...params) => leaseListStmt.all(...params) as unknown as ServedLease[],
    leaseCanonHashes: (...params) =>
      leaseListCanonStmt.all(...params) as unknown as Array<{ anchor: string; canon_hash: string }>,
    leaseHomes: (sessionKey, anchor) =>
      (leaseHomesStmt.all(sessionKey, anchor) as unknown as Array<{ file_path: string }>).map(
        (row) => row.file_path,
      ),
    leaseRetireAbsent: (now, path, snapshotId) => {
      leaseRetireAbsentStmt.run(now, path, snapshotId);
    },
    leaseDelete: (sessionKey, path) => {
      withBusyRetry(() => {
        leaseDeleteStmt.run(sessionKey, path);
      });
    },
    leaseDeletePath: (path) => {
      withBusyRetry(() => {
        leaseDeletePathStmt.run(path);
      });
    },
    leaseWipe: (sessionKey) => {
      withBusyRetry(() => {
        leaseWipeStmt.run(sessionKey);
      });
    },
    metaGetReported: (...params) =>
      metaGetReportedStmt.get(...params) as { reported: string | null } | undefined,
    metaUpsertReported: (sessionKey, path, reported, updatedAt) => {
      withBusyRetry(() => {
        metaUpsertReportedStmt.run(sessionKey, path, reported, updatedAt);
      });
    },
    metaClearReported: (sessionKey, path) => {
      withBusyRetry(() => {
        metaClearReportedStmt.run(sessionKey, path);
      });
    },
    metaDelete: (sessionKey, path) => {
      withBusyRetry(() => {
        // WHY: dropping the whole meta row is exactly what clearing the reported set means.
        metaClearReportedStmt.run(sessionKey, path);
      });
    },
    metaDeletePath: (path) => {
      withBusyRetry(() => {
        metaDeletePathStmt.run(path);
      });
    },
    metaWipe: (sessionKey) => {
      withBusyRetry(() => {
        metaWipeStmt.run(sessionKey);
      });
    },
  };
}

// WHY: the legacy v6 shell keeps its `canons` column: an un-restarted v6 process prepares a
// WHY: statement naming it at store open, so dropping it would break that process's whole mirror.
// WHY: Nothing in v7 reads or writes it — canon evidence is derived from `served_leases.canon_hash`
// WHY: (issue #151).
export function ensureServedSchema(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS served (" +
      "session_id TEXT NOT NULL, " +
      "path TEXT NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "reported TEXT, " +
      "retired TEXT, " +
      "canons TEXT, " +
      "snapshotId TEXT, " +
      "updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY (session_id, path)" +
      ")",
  );
  // WHY: Migration for existing DBs that were created before retired/canons/snapshotId
  try {
    const cols = db.prepare("PRAGMA table_info(served)").all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === "retired")) {
      db.exec("ALTER TABLE served ADD COLUMN retired TEXT");
    }
    const cols2 = db.prepare("PRAGMA table_info(served)").all() as {
      name: string;
    }[];
    // WHY: `canons` is deliberately still added here for the same v6-shell reason; nothing in v7
    // WHY: reads or writes it — canon evidence is derived from `served_leases.canon_hash` (#151).
    if (!cols2.some((c) => c.name === "canons")) {
      db.exec("ALTER TABLE served ADD COLUMN canons TEXT");
    }
    const cols3 = db.prepare("PRAGMA table_info(served)").all() as {
      name: string;
    }[];
    if (!cols3.some((c) => c.name === "snapshotId")) {
      db.exec("ALTER TABLE served ADD COLUMN snapshotId TEXT");
    }
  } catch (error) {
    // SAFETY: best-effort v6 migration — a failed ALTER leaves the legacy mirror unmigrated;
    // SAFETY: the store open still succeeds and later reads re-attempt the additive migration.
    console.error("Failed to migrate served schema:", error);
  }
}

onStoreOpen((db) => {
  ensureServedSchema(db);
  // WHY: retention of v7 leases and session meta belongs to the vacuum engine (#86) — opening the
  // WHY: store stays strictly additive and idempotent (spec §5.1 item 8), so a version flap in a
  // WHY: mixed-version environment can never drop v7 identity state.
  servedStmts(db).servedPruneOlderThan(Date.now() - SERVED_TTL_MS);
  // WHY: the store open is the vacuum's deterministic boundary — retention is enforced across all
  // WHY: paths before a new session accumulates snapshots, including after a crash left an
  // WHY: over-budget store behind.
  vacuumSnapshots(db);
});

// WHY: --- internal helpers — private to deep module (not exported) ---
function isValidServedList(value: unknown): value is (string | null)[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (entry === null) continue;
    if (typeof entry !== "string" || !HASH_RE.test(entry)) return false;
  }
  return true;
}

function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const h of value) {
    if (typeof h !== "string" || !HASH_RE.test(h)) return false;
  }
  return true;
}

function buildServedHashIndex(updated: (string | null)[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < updated.length; i++) {
    const h = updated[i];
    if (h === null) continue;
    const prev = index.get(h);
    if (prev !== undefined) updated[prev] = null;
    index.set(h, i);
  }
  return index;
}

function validateServedEntry(entry: { position: number; hash: string | null }): void {
  if (!Number.isInteger(entry.position) || entry.position < 0)
    throw new TypeError(`Invalid served position: ${entry.position}`);
  if (entry.hash !== null && (typeof entry.hash !== "string" || !HASH_RE.test(entry.hash)))
    throw new TypeError(`Invalid served hash: ${String(entry.hash)}`);
}

function applySingleServedEntry(
  updated: (string | null)[],
  entry: { position: number; hash: string | null },
  index: Map<string, number>,
): void {
  while (updated.length <= entry.position) updated.push(null);
  if (entry.hash !== null) {
    const existing = index.get(entry.hash);
    if (existing !== undefined && existing !== entry.position) {
      updated[existing] = null;
      index.delete(entry.hash);
    }
    const oldAtPos = updated[entry.position];
    if (oldAtPos !== null && oldAtPos !== entry.hash) index.delete(oldAtPos);
    index.set(entry.hash, entry.position);
  } else {
    const oldAtPos = updated[entry.position];
    if (oldAtPos !== null) index.delete(oldAtPos);
  }
  updated[entry.position] = entry.hash;
}

function patchServed(
  updated: (string | null)[],
  entries: Array<{ position: number; hash: string | null }>,
): void {
  const index = buildServedHashIndex(updated);
  for (const entry of entries) {
    validateServedEntry(entry);
    applySingleServedEntry(updated, entry, index);
  }
  while (updated.length > 0 && updated.at(-1) === null) updated.pop();
}

// WHY: sync store-level ops (require open store — caller ensures via loadHashStore/withStore)
/**
 * Drop every served fact for one (session, path): the legacy mirror, its identity leases and its
 * drift-notice dedup set. They are one fact split across three tables, so they are dropped
 * together — a surviving lease would let an anchor the session no longer validly holds resolve
 * instead of failing E_STALE_ANCHOR (spec §3.1 fail-closed).
 *
 * WHY: corrupt-reset callers already run inside a `withStore` transaction and `BEGIN IMMEDIATE`
 * cannot nest, so the drop only opens its own transaction when the caller is outside one.
 */
function dropServedState(store: HashStore, sessionKey: string, path: string): void {
  const drop = () => {
    const stmts = servedStmts(store.db);
    stmts.servedDelete(sessionKey, path);
    stmts.leaseDelete(sessionKey, path);
    stmts.metaDelete(sessionKey, path);
  };
  const inTransaction = (store.db as unknown as { isTransaction?: boolean }).isTransaction === true;
  if (inTransaction) drop();
  else withStore(drop);
}

function getServedInner(store: HashStore, sessionKey: string, path: string): (string | null)[] {
  const row = servedStmts(store.db).servedGet(sessionKey, path);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.hashes as string);
    if (isValidServedList(parsed)) return parsed;
    dropServedState(store, sessionKey, path);
    return [];
  } catch {
    dropServedState(store, sessionKey, path);
    return [];
  }
}

function upsertServedInner(
  store: HashStore,
  sessionKey: string,
  path: string,
  entries: Array<{ position: number; hash: string | null }>,
): void {
  if (entries.length === 0) return;
  withStore(() => {
    const updated = [...getServedInner(store, sessionKey, path)];
    patchServed(updated, entries);
    servedStmts(store.db).servedUpsert(sessionKey, path, JSON.stringify(updated), Date.now());
  });
  grantLeasesForRows(store, sessionKey, path, entries);
}

/** WHY: a truncated serve delivers a suffix of the file, so its mirror is clamped and cleared. */
interface TruncatedServeShape {
  lineCount: number;
  clearFrom?: number;
}

/** Clamp (`lineCount`) and clear (`clearFrom`) a served mirror, leaving the caller's copy intact. */
function shapeMirror(
  mirror: readonly (string | null)[],
  shape: TruncatedServeShape,
): (string | null)[] {
  const shaped = [...mirror];
  if (shaped.length > shape.lineCount) shaped.length = shape.lineCount;
  if (shape.clearFrom !== undefined)
    for (let i = shape.clearFrom; i < shaped.length; i++) shaped[i] = null;
  return shaped;
}

/**
 * WHY: the single writer for a serve observation: the served mirror and the lease grant
 * WHY: (spec §3.1.2). `shape` is the only difference between the truncated serve (a suffix was
 * WHY: shown, so the mirror is clamped/cleared) and the plain one. Canon evidence needs no write at
 * WHY: all: it is derived from the leases this writer grants (#151).
 */
function writeServeRecord(
  store: HashStore,
  sessionKey: string,
  path: string,
  rows: ServedEntry[],
  contentHash: string | undefined,
  shape?: TruncatedServeShape,
): void {
  try {
    withStore(() => {
      const before = getServedInner(store, sessionKey, path);
      const updated = shape ? shapeMirror(before, shape) : [...before];
      patchServed(updated, rows);
      const isNoOp = before.length === updated.length && before.every((v, i) => v === updated[i]);
      if (!isNoOp) {
        servedStmts(store.db).servedUpsert(sessionKey, path, JSON.stringify(updated), Date.now());
      } else if (!shape) {
        // WHY: a no-op mirror displaces nothing and leaves no lease to re-grant here.
        return;
      }
      const disp = displacedHashes(before, updated);
      if (disp.size > 0) addRetiredAnchors(store, sessionKey, path, disp);
    });
  } catch (error) {
    console.error(`Failed to record ${shape ? "truncated " : ""}served rows:`, error);
    throw error;
  }
  // WHY: identity is granted independently of the legacy mirror: a no-op mirror re-serve still
  // WHY: has to re-grant a lease that a materialization retired (spec §3.1.2 re-serve upsert).
  grantLeasesForRows(store, sessionKey, path, rows, contentHash);
}

function recordServesInner(
  store: HashStore,
  sessionKey: string,
  path: string,
  rows: ServedEntry[],
  contentHash?: string,
): void {
  if (rows.length === 0) return;
  writeServeRecord(store, sessionKey, path, rows, contentHash);
}

function recordServesTruncatedInner(
  store: HashStore,
  sessionKey: string,
  path: string,
  rows: ServedEntry[],
  lineCount: number,
  clearFrom?: number,
  contentHash?: string,
): void {
  if (rows.length === 0) return;
  writeServeRecord(store, sessionKey, path, rows, contentHash, { lineCount, clearFrom });
}

/**
 * Best-effort wrapper for callers that grant leases outside a transaction of their own: a missed
 * lease degrades to the fail-closed path the next edit would take anyway.
 */
function grantLeasesForRows(
  store: HashStore,
  sessionKey: string,
  path: string,
  rows: ServedEntry[],
  contentHash?: string,
): void {
  if (!contentHash) return;
  try {
    grantLeasesInTransaction(store.db, sessionKey, path, rows, contentHash);
  } catch (error) {
    // SAFETY: best-effort lease grant — serves are already recorded and the tool result is valid;
    // SAFETY: a missed lease degrades to the fail-closed path the next edit would take anyway.
    console.error("Failed to grant served leases:", error);
  }
}

/**
 * Atomically upserts a lease per served anchor (spec §3.1.2). The leased `line_id` is never
 * invented here: it is read from the committed snapshot whose content was actually served, so the
 * edit path can resolve the anchor's identity later. Anchors without committed lineage (e.g. a
 * preview that persisted nothing, or content whose snapshot write failed) grant no lease and stay
 * fail-closed.
 *
 * `contentHash` names that served snapshot and MUST be supplied by every caller that knows the
 * served content (`recordEpoch` full reads, `recordDiff`, `recordServeFeedback`, `recordTruncated`,
 * `recordLeases`). There is deliberately NO fallback to the newest materialization: after content
 * reverts to an earlier committed snapshot a re-serve of the reverted content would bind anchors
 * that both snapshots share to the OTHER version's `line_id` — the silent-miswrite class §3.1.2
 * exists to prevent. An unknown hash therefore grants nothing and the next edit fails closed.
 *
 * This is the in-transaction half: it runs on the caller's already-open `BEGIN IMMEDIATE` and
 * deliberately propagates instead of swallowing, so a failed re-serve rolls back the adoption and
 * retirement it shares a transaction with (the undo restore is one transaction, not three).
 */
export function grantLeasesInTransaction(
  db: DatabaseSync,
  sessionKey: string,
  path: string,
  rows: ReadonlyArray<{ position: number; hash: string | null }>,
  contentHash: string,
): void {
  const live = rows.filter((row) => row.hash !== null);
  if (live.length === 0) return;
  const stmts = servedStmts(db);
  // WHY: the caller names the snapshot it actually served, so a file reverted to content from
  // WHY: an older committed snapshot leases against that snapshot, not `S_latest`.
  const snapshot = stmts.snapshotByHash(path, contentHash);
  if (!snapshot) return;
  const byAnchor = new Map(
    stmts.lineageAnchorsOf(snapshot.snapshot_id).map((entry) => [entry.anchor, entry]),
  );
  // WHY: a lease is keyed by anchor, so a batch that repeats an anchor keeps only its last serve.
  const grants = new Map<string, LeaseGrant>();
  for (const row of live) {
    const lineage = byAnchor.get(row.hash!);
    if (!lineage) continue;
    grants.set(row.hash!, {
      anchor: row.hash!,
      lineId: lineage.line_id,
      canonHash: lineage.canon_hash,
      lineNumber: row.position + 1,
    });
  }
  stmts.leaseUpsertMany(sessionKey, path, snapshot.snapshot_hash, Date.now(), [...grants.values()]);
}

/**
 * Authoritative writer for `retired_at` (spec §3.1.3). Called with the snapshot id that was just
 * materialized: any active lease on the path whose `line_id` is absent from that lineage is
 * retired. Runs inside the caller's `BEGIN IMMEDIATE` transaction.
 */
export function retireAbsentLeases(
  db: DatabaseSync,
  filePath: string,
  snapshotId: number,
  now: number = Date.now(),
): void {
  servedStmts(db).leaseRetireAbsent(now, filePath, snapshotId);
}

function getReportedInner(store: HashStore, sessionKey: string, path: string): Set<string> {
  const row = servedStmts(store.db).metaGetReported(sessionKey, path);
  if (!row) return new Set();
  const raw = row.reported;
  if (typeof raw !== "string" || raw.length === 0) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((h): h is string => typeof h === "string" && HASH_RE.test(h)));
  } catch {
    return new Set();
  }
}

function addReportedInner(
  store: HashStore,
  sessionKey: string,
  path: string,
  hashes: string[],
): void {
  const valid = hashes.filter((hash) => HASH_RE.test(hash));
  if (valid.length === 0) return;
  withStore(() => {
    const current = getReportedInner(store, sessionKey, path);
    for (const hash of valid) current.add(hash);
    servedStmts(store.db).metaUpsertReported(
      sessionKey,
      path,
      JSON.stringify([...current]),
      Date.now(),
    );
  });
}

function clearReportedInner(store: HashStore, sessionKey: string, path: string): void {
  withStore(() => {
    servedStmts(store.db).metaClearReported(sessionKey, path);
  });
}

/**
 * Canon digests parallel to the served mirror (#151): each position takes the `canon_hash` of the
 * lease held for the anchor it names. A position with no anchor or no lease reads `null` — absence of
 * evidence, never a shape refusal. This is the only canon-evidence source; nothing is persisted.
 */
function getCanonDigestsInner(
  store: HashStore,
  sessionKey: string,
  path: string,
): (string | null)[] {
  const served = getServedInner(store, sessionKey, path);
  if (served.length === 0) return [];
  const byAnchor = new Map<string, string>();
  for (const lease of servedStmts(store.db).leaseCanonHashes(sessionKey, path)) {
    byAnchor.set(lease.anchor, lease.canon_hash);
  }
  if (byAnchor.size === 0) return [];
  return served.map((anchor) => (anchor === null ? null : (byAnchor.get(anchor) ?? null)));
}

function getTombstoneInner(store: HashStore, sessionKey: string, path: string): Set<string> {
  const row = servedStmts(store.db).servedGet(sessionKey, path);
  if (!row || row.retired === null || row.retired === undefined) return new Set();
  try {
    const parsed = JSON.parse(row.retired as string) as unknown;
    if (!isValidHashList(parsed)) throw new TypeError("invalid retired");
    return new Set(parsed);
  } catch {
    dropServedState(store, sessionKey, path);
    return new Set();
  }
}

function getEpochIdInner(store: HashStore, sessionKey: string, path: string): string | undefined {
  const row = servedStmts(store.db).servedGet(sessionKey, path);
  if (!row || row.snapshotId === null || row.snapshotId === undefined) return undefined;
  return row.snapshotId as string;
}

function addRetiredAnchors(
  store: HashStore,
  sessionKey: string,
  path: string,
  hashes: Iterable<string>,
): void {
  const additions = [...hashes];
  if (additions.length === 0) return;
  const retired = getTombstoneInner(store, sessionKey, path);
  for (const hash of additions) {
    if (!HASH_RE.test(hash)) throw new TypeError(`Invalid retired hash: ${hash}`);
    retired.add(hash);
  }
  servedStmts(store.db).servedRetiredUpsert(
    sessionKey,
    path,
    JSON.stringify([...retired]),
    Date.now(),
  );
}

function displacedHashes(
  current: readonly (string | null)[],
  updated: readonly (string | null)[],
): Set<string> {
  const remaining = new Set(updated.filter((h): h is string => h !== null));
  return new Set(current.filter((h): h is string => h !== null && !remaining.has(h)));
}

async function retireAnchorsInner(
  store: HashStore,
  sessionKey: string,
  path: string,
  hashes: Iterable<string>,
): Promise<void> {
  const additions = [...hashes];
  if (additions.length === 0) return;
  withStore(() => {
    addRetiredAnchors(store, sessionKey, path, additions);
  });
}

// WHY: helpers for handle
function planServeRecording(input: {
  resultLineCount?: number;
  firstChangedLine?: number;
}): { mode: "plain" } | { mode: "truncated"; lineCount: number; clearFrom: number } {
  if (typeof input.resultLineCount !== "number") return { mode: "plain" };
  return {
    mode: "truncated",
    lineCount: input.resultLineCount,
    clearFrom: input.firstChangedLine !== undefined ? input.firstChangedLine - 1 : 0,
  };
}

// WHY: --- SessionHandle factory ---
export function createSessionHandle(
  sessionKey: string,
  path: string,
  storeOverride?: HashStore,
): import("./types.js").SessionHandle {
  // WHY: storeOverride allows injecting MemoryStore in tests via custom HashStore wrapping Memory DB
  // WHY: For prod, we load the shared SQLite store lazily.
  async function resolveStore(): Promise<HashStore> {
    if (storeOverride) return storeOverride;
    return loadHashStore();
  }

  return {
    path,
    sessionKey,
    async load(): Promise<(string | null)[]> {
      const store = await resolveStore();
      return getServedInner(store, sessionKey, path);
    },
    async loadCanonDigests(): Promise<(string | null)[]> {
      const store = await resolveStore();
      return getCanonDigestsInner(store, sessionKey, path);
    },
    async loadEpochId(): Promise<string | undefined> {
      const store = await resolveStore();
      return getEpochIdInner(store, sessionKey, path);
    },
    async loadTombstone(): Promise<Set<string>> {
      const store = await resolveStore();
      return getTombstoneInner(store, sessionKey, path);
    },
    async retire(hashes: Iterable<string>): Promise<void> {
      const store = await resolveStore();
      await retireAnchorsInner(store, sessionKey, path, hashes);
    },
    async record(rows: ServedEntry[]): Promise<void> {
      if (rows.length === 0) return;
      const store = await resolveStore();
      recordServesInner(store, sessionKey, path, rows);
    },
    async recordTruncated(
      rows: ServedEntry[],
      lineCount: number,
      clearFrom?: number,
      contentHash?: string,
    ): Promise<void> {
      if (rows.length === 0) return;
      const store = await resolveStore();
      recordServesTruncatedInner(store, sessionKey, path, rows, lineCount, clearFrom, contentHash);
    },
    async recordDiff(
      servedRows: ServedRow[],
      opts: { contentHash?: string; resultLineCount?: number; firstChangedLine?: number },
    ): Promise<void> {
      if (servedRows.length === 0) return;
      const store = await resolveStore();
      // WHY: `contentHash` is absent when the leases were already granted inside the
      // WHY: materialization transaction (spec §3.1.2 step 5) — the record is then mirror-only and
      // WHY: grants nothing, so no third transaction remains on the read/edit path.
      const plan = planServeRecording(opts);
      if (plan.mode === "plain") {
        recordServesInner(store, sessionKey, path, servedRows, opts.contentHash);
        return;
      }
      recordServesTruncatedInner(
        store,
        sessionKey,
        path,
        servedRows,
        plan.lineCount,
        plan.clearFrom,
        opts.contentHash,
      );
    },
    async recordServeFeedback(
      rows: ServedRow[],
      policy: ServeRecordPolicy,
      lineCount?: number,
      contentHash?: string,
    ): Promise<void> {
      if (policy !== "live") return;
      const store = await resolveStore();
      if (lineCount === undefined) {
        recordServesInner(store, sessionKey, path, rows, contentHash);
        return;
      }
      recordServesTruncatedInner(store, sessionKey, path, rows, lineCount, undefined, contentHash);
    },
    async recordEpoch(input: {
      rows: ServedEntry[];
      lineCount?: number;
      fullReadHashes?: readonly string[];
      snapshotId?: string;
      contentHash?: string;
      isFullRead?: boolean;
    }): Promise<void> {
      if (input.rows.length === 0 && !input.fullReadHashes) return;
      const store = await resolveStore();
      const isFullRead =
        input.isFullRead ??
        (input.fullReadHashes !== undefined &&
          input.rows.length === input.fullReadHashes.length &&
          input.rows.every(
            (row, index) => row.position === index && row.hash === input.fullReadHashes![index],
          ));
      withStore(() => {
        const current = getServedInner(store, sessionKey, path);
        const updated = [...current];
        // WHY: merge rows via patchServed
        if (input.rows.length > 0) {
          if (input.lineCount !== undefined && updated.length > input.lineCount)
            updated.length = input.lineCount;
          patchServed(updated, input.rows);
        } else if (input.lineCount !== undefined) {
          if (updated.length > input.lineCount) updated.length = input.lineCount;
        }
        const changed =
          current.length !== updated.length || current.some((v, i) => v !== updated[i]);
        if (changed || input.rows.length > 0) {
          if (updated.length === 0 && input.rows.length === 0) {
            // WHY: no-op
          } else {
            servedStmts(store.db).servedUpsert(
              sessionKey,
              path,
              JSON.stringify(updated),
              Date.now(),
            );
          }
        }
        if (isFullRead) {
          servedStmts(store.db).servedRetiredClear(sessionKey, Date.now(), path);
          if (isFullRead && input.snapshotId)
            servedStmts(store.db).servedSnapshotUpsert(
              sessionKey,
              path,
              input.snapshotId,
              Date.now(),
            );
        } else {
          if (isFullRead && input.snapshotId)
            servedStmts(store.db).servedSnapshotUpsert(
              sessionKey,
              path,
              input.snapshotId,
              Date.now(),
            );
          const disp = displacedHashes(current, updated);
          if (disp.size > 0) addRetiredAnchors(store, sessionKey, path, disp);
        }
      });
      if (input.rows.length > 0)
        grantLeasesForRows(store, sessionKey, path, input.rows, input.contentHash);
    },
    async recordLeases(rows: ServedEntry[], contentHash: string): Promise<void> {
      if (rows.length === 0) return;
      const store = await resolveStore();
      grantLeasesForRows(store, sessionKey, path, rows, contentHash);
    },
    async clearDrift(): Promise<void> {
      const store = await resolveStore();
      clearReportedInner(store, sessionKey, path);
    },
    async driftReported(): Promise<Set<string>> {
      const store = await resolveStore();
      return getReportedInner(store, sessionKey, path);
    },
    async markDriftReported(hashes: string[]): Promise<void> {
      const store = await resolveStore();
      addReportedInner(store, sessionKey, path, hashes);
    },
  };
}

// WHY: convenience: create from ctx directly
export function sessionFromContext(
  ctx: { sessionManager?: { getSessionId(): string } },
  path: string,
): import("./types.js").SessionHandle {
  return createSessionHandle(sessionKeyFor(ctx), path);
}

// WHY: re-export TTL-aware wipe helpers for extension lifecycle (still via handle path, but keep as util)
export async function wipeSession(sessionKey: string): Promise<void> {
  const store = await loadHashStore();
  wipeServed(store, sessionKey);
}

export async function loadTombstone(sessionKey: string, path: string): Promise<Set<string>> {
  const store = await loadHashStore();
  return getTombstoneInner(store, sessionKey, path);
}

export async function loadCanonDigests(
  sessionKey: string,
  path: string,
): Promise<(string | null)[]> {
  const store = await loadHashStore();
  return getCanonDigestsInner(store, sessionKey, path);
}

export async function loadEpochId(sessionKey: string, path: string): Promise<string | undefined> {
  const store = await loadHashStore();
  return getEpochIdInner(store, sessionKey, path);
}

export async function retireAnchors(
  sessionKey: string,
  path: string,
  hashes: Iterable<string>,
): Promise<void> {
  const store = await loadHashStore();
  await retireAnchorsInner(store, sessionKey, path, hashes);
}

export async function deleteServedByPathAsync(path: string): Promise<void> {
  const store = await loadHashStore();
  deleteServedByPath(store, path);
}

export function deleteServedByPath(store: HashStore, path: string): void {
  const stmts = servedStmts(store.db);
  stmts.servedDeletePath(path);
  stmts.leaseDeletePath(path);
  stmts.metaDeletePath(path);
}

/** Leases for one (session, path), ordered by served line. */
export function loadLeases(store: HashStore, sessionKey: string, path: string): ServedLease[] {
  return servedStmts(store.db).leaseList(sessionKey, path);
}

/** `(anchor, canon_hash)` for every lease on the path — the canon-evidence lookup (#151). */
export function loadLeaseCanonHashes(
  store: HashStore,
  sessionKey: string,
  path: string,
): Array<{ anchor: string; canon_hash: string }> {
  return servedStmts(store.db).leaseCanonHashes(sessionKey, path);
}

/** The lease for one served anchor, if this session holds one. */
export function loadLease(
  store: HashStore,
  sessionKey: string,
  path: string,
  anchor: string,
): ServedLease | undefined {
  return servedStmts(store.db).leaseGet(sessionKey, path, anchor);
}

/** Every file this session served one anchor for, ordered for stable output. */
export function loadAnchorHomes(store: HashStore, sessionKey: string, anchor: string): string[] {
  return servedStmts(store.db).leaseHomes(sessionKey, anchor);
}

// WHY: --- Legacy low-level exports for facade compat (keep import surface stable) ---
export function getServed(store: HashStore, sessionKey: string, path: string): (string | null)[] {
  return getServedInner(store, sessionKey, path);
}

export function upsertServed(
  store: HashStore,
  sessionKey: string,
  path: string,
  entries: Array<{ position: number; hash: string | null }>,
): void {
  upsertServedInner(store, sessionKey, path, entries);
}

export function getReported(store: HashStore, sessionKey: string, path: string): Set<string> {
  return getReportedInner(store, sessionKey, path);
}

export function addReported(
  store: HashStore,
  sessionKey: string,
  path: string,
  hashes: string[],
): void {
  addReportedInner(store, sessionKey, path, hashes);
}

export function clearReported(store: HashStore, sessionKey: string, path: string): void {
  clearReportedInner(store, sessionKey, path);
}

export function deleteServed(store: HashStore, sessionKey: string, path: string): void {
  dropServedState(store, sessionKey, path);
}

export function wipeServed(store: HashStore, sessionKey: string): void {
  const stmts = servedStmts(store.db);
  stmts.servedWipe(sessionKey);
  stmts.leaseWipe(sessionKey);
  stmts.metaWipe(sessionKey);
}

export function recordServes(
  store: HashStore,
  sessionKey: string,
  path: string,
  rows: ServedEntry[],
): void {
  recordServesInner(store, sessionKey, path, rows);
}

export function recordServesTruncated(
  store: HashStore,
  sessionKey: string,
  path: string,
  rows: ServedEntry[],
  lineCount: number,
  clearFrom?: number,
  contentHash?: string,
): void {
  recordServesTruncatedInner(store, sessionKey, path, rows, lineCount, clearFrom, contentHash);
}
