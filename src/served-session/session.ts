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
import { globalCanonStore } from "../hashline/hash.js";
import { SERVED_TTL_MS } from "../constants.js";
import {
  loadHashStore,
  onStoreOpen,
  withStore,
  withBusyRetry,
  getCached,
  type HashStore,
} from "../hash-store.js";
import type { ServedRow } from "../hashline/served.js";
import type { ServeRecordPolicy, ServedEntry } from "./types.js";

// WHY: --- sessionKey authority (kept here; served-state re-exports for compat) ---
let fallbackSessionKey: string | undefined;

export function sessionKeyFor(ctx?: {
  sessionManager?: { getSessionId(): string };
}): string {
  const fromSession = ctx?.sessionManager?.getSessionId();
  if (fromSession) return fromSession;
  fallbackSessionKey ??= randomUUID();
  return fallbackSessionKey;
}

// WHY: --- SQLite stmts (private to deep module) ---
interface ServedStmts {
  servedGet: (
    sessionKey: string,
    path: string,
  ) => Record<string, unknown> | undefined;
  servedUpsert: (
    sessionKey: string,
    path: string,
    hashes: string,
    updatedAt: number,
  ) => void;
  servedReportedUpsert: (
    sessionKey: string,
    path: string,
    reported: string,
    updatedAt: number,
  ) => void;
  servedReportedClear: (
    sessionKey: string,
    updatedAt: number,
    path: string,
  ) => void;
  servedRetiredUpsert: (
    sessionKey: string,
    path: string,
    retired: string,
    updatedAt: number,
  ) => void;
  servedRetiredClear: (
    sessionKey: string,
    updatedAt: number,
    path: string,
  ) => void;
  servedCanonsUpsert: (
    sessionKey: string,
    path: string,
    canons: string,
    updatedAt: number,
  ) => void;
  servedCanonsClear: (
    sessionKey: string,
    updatedAt: number,
    path: string,
  ) => void;
  servedSnapshotUpsert: (
    sessionKey: string,
    path: string,
    snapshotId: string,
    updatedAt: number,
  ) => void;
  servedSnapshotClear: (
    sessionKey: string,
    updatedAt: number,
    path: string,
  ) => void;
  servedDelete: (sessionKey: string, path: string) => void;
  servedDeletePath: (path: string) => void;
  servedWipe: (sessionKey: string) => void;
  servedPruneOlderThan: (updatedBefore: number) => void;
}

const stmtsCache = new WeakMap<DatabaseSync, ServedStmts>();

function servedStmts(db: DatabaseSync): ServedStmts {
  return getCached(db, stmtsCache, buildStmts);
}

function buildStmts(db: DatabaseSync): ServedStmts {
  const servedGetStmt = db.prepare(
    "SELECT hashes, reported, retired, canons, snapshotId FROM served WHERE session_id = ? AND path = ?",
  );
  const servedUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET hashes = excluded.hashes, updated_at = excluded.updated_at",
  );
  const servedReportedUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, reported, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET reported = excluded.reported, updated_at = excluded.updated_at",
  );
  const servedReportedClearStmt = db.prepare(
    "UPDATE served SET reported = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
  );
  const servedRetiredUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, retired, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET retired = excluded.retired, updated_at = excluded.updated_at",
  );
  const servedRetiredClearStmt = db.prepare(
    "UPDATE served SET retired = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
  );
  const servedCanonsUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, canons, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET canons = excluded.canons, updated_at = excluded.updated_at",
  );
  const servedCanonsClearStmt = db.prepare(
    "UPDATE served SET canons = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
  );
  const servedSnapshotUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, snapshotId, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET snapshotId = excluded.snapshotId, updated_at = excluded.updated_at",
  );
  const servedSnapshotClearStmt = db.prepare(
    "UPDATE served SET snapshotId = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
  );
  const servedDeleteStmt = db.prepare(
    "DELETE FROM served WHERE session_id = ? AND path = ?",
  );
  const servedDeletePathStmt = db.prepare("DELETE FROM served WHERE path = ?");
  const servedWipeStmt = db.prepare("DELETE FROM served WHERE session_id = ?");
  const servedPruneOlderThanStmt = db.prepare(
    "DELETE FROM served WHERE updated_at < ?",
  );
  return {
    servedGet: (...params) =>
      servedGetStmt.get(...params) as Record<string, unknown> | undefined,
    servedUpsert: (sessionKey, path, hashes, updatedAt) => {
      withBusyRetry(() => {
        servedUpsertStmt.run(sessionKey, path, hashes, updatedAt);
      });
    },
    servedReportedUpsert: (sessionKey, path, reported, updatedAt) => {
      withBusyRetry(() => {
        servedReportedUpsertStmt.run(sessionKey, path, reported, updatedAt);
      });
    },
    servedReportedClear: (sessionKey, updatedAt, path) => {
      withBusyRetry(() => {
        servedReportedClearStmt.run(updatedAt, sessionKey, path);
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
    servedCanonsUpsert: (sessionKey, path, canons, updatedAt) => {
      withBusyRetry(() => {
        servedCanonsUpsertStmt.run(sessionKey, path, canons, updatedAt);
      });
    },
    servedCanonsClear: (sessionKey, updatedAt, path) => {
      withBusyRetry(() => {
        servedCanonsClearStmt.run(updatedAt, sessionKey, path);
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
  };
}

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
      try {
        db.exec("DELETE FROM snapshots");
      } catch {}
      try {
        db.exec("DELETE FROM undo");
      } catch {}
    }
    const cols2 = db.prepare("PRAGMA table_info(served)").all() as {
      name: string;
    }[];
    if (!cols2.some((c) => c.name === "canons")) {
      db.exec("ALTER TABLE served ADD COLUMN canons TEXT");
    }
    const cols3 = db.prepare("PRAGMA table_info(served)").all() as {
      name: string;
    }[];
    if (!cols3.some((c) => c.name === "snapshotId")) {
      db.exec("ALTER TABLE served ADD COLUMN snapshotId TEXT");
    }
  } catch {}
}

onStoreOpen((db) => {
  ensureServedSchema(db);
  servedStmts(db).servedPruneOlderThan(Date.now() - SERVED_TTL_MS);
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

function isValidCanonsList(value: unknown): value is (string | null)[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (entry === null) continue;
    if (typeof entry !== "string") return false;
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

function validateServedEntry(entry: {
  position: number;
  hash: string | null;
}): void {
  if (!Number.isInteger(entry.position) || entry.position < 0)
    throw new TypeError(`Invalid served position: ${entry.position}`);
  if (
    entry.hash !== null &&
    (typeof entry.hash !== "string" || !HASH_RE.test(entry.hash))
  )
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
function getServedInner(
  store: HashStore,
  sessionKey: string,
  path: string,
): (string | null)[] {
  const row = servedStmts(store.db).servedGet(sessionKey, path);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.hashes as string);
    if (isValidServedList(parsed)) return parsed;
    servedStmts(store.db).servedDelete(sessionKey, path);
    return [];
  } catch {
    servedStmts(store.db).servedDelete(sessionKey, path);
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
    servedStmts(store.db).servedUpsert(
      sessionKey,
      path,
      JSON.stringify(updated),
      Date.now(),
    );
  });
}

function recordServesInner(
  store: HashStore,
  sessionKey: string,
  path: string,
  rows: Array<{ position: number; hash: string | null }>,
): void {
  if (rows.length === 0) return;
  try {
    withStore(() => {
      const before = getServedInner(store, sessionKey, path);
      const updated = [...before];
      patchServed(updated, rows);
      const isNoOp =
        before.length === updated.length &&
        before.every((v, i) => v === updated[i]);
      if (!isNoOp) {
        servedStmts(store.db).servedUpsert(
          sessionKey,
          path,
          JSON.stringify(updated),
          Date.now(),
        );
      } else {
        // WHY: still need to handle tombstone if displaced due to hash move? No-op means no displaced.
        return;
      }
      const disp = displacedHashes(before, updated);
      if (disp.size > 0) addRetiredAnchors(store, sessionKey, path, disp);
      // WHY: Keep canons in sync with hashes for edited rows — needed for canon verification (ADR-0005).
      try {
        const currentCanons = getCanonsInner(store, sessionKey, path);
        const updatedCanons = currentCanons.slice();
        for (const row of rows) {
          while (updatedCanons.length <= row.position) updatedCanons.push(null);
          const cv = row.hash ? (globalCanonStore.get(row.hash) ?? null) : null;
          updatedCanons[row.position] = cv;
        }
        while (
          updatedCanons.length > 0 &&
          updatedCanons[updatedCanons.length - 1] === null
        )
          updatedCanons.pop();
        servedStmts(store.db).servedCanonsUpsert(
          sessionKey,
          path,
          JSON.stringify(updatedCanons),
          Date.now(),
        );
      } catch {}
    });
  } catch (error) {
    console.error("Failed to record served rows:", error);
    throw error;
  }
}

function recordServesTruncatedInner(
  store: HashStore,
  sessionKey: string,
  path: string,
  rows: Array<{ position: number; hash: string | null }>,
  lineCount: number,
  clearFrom?: number,
): void {
  if (rows.length === 0) return;
  try {
    withStore(() => {
      const before = getServedInner(store, sessionKey, path);
      const updated = [...before];
      if (updated.length > lineCount) updated.length = lineCount;
      if (clearFrom !== undefined)
        for (let i = clearFrom; i < updated.length; i++) updated[i] = null;
      patchServed(updated, rows);
      const isNoOp =
        before.length === updated.length &&
        before.every((v, i) => v === updated[i]);
      if (!isNoOp) {
        servedStmts(store.db).servedUpsert(
          sessionKey,
          path,
          JSON.stringify(updated),
          Date.now(),
        );
      }
      const disp = displacedHashes(before, updated);
      if (disp.size > 0) addRetiredAnchors(store, sessionKey, path, disp);
      // WHY: Keep canons in sync (truncated) — mirrors hash update
      try {
        const currentCanons = getCanonsInner(store, sessionKey, path);
        const updatedCanons = currentCanons.slice();
        if (updatedCanons.length > lineCount) updatedCanons.length = lineCount;
        if (clearFrom !== undefined)
          for (let i = clearFrom; i < updatedCanons.length; i++)
            updatedCanons[i] = null;
        for (const row of rows) {
          while (updatedCanons.length <= row.position) updatedCanons.push(null);
          const cv = row.hash ? (globalCanonStore.get(row.hash) ?? null) : null;
          updatedCanons[row.position] = cv;
        }
        while (
          updatedCanons.length > 0 &&
          updatedCanons[updatedCanons.length - 1] === null
        )
          updatedCanons.pop();
        servedStmts(store.db).servedCanonsUpsert(
          sessionKey,
          path,
          JSON.stringify(updatedCanons),
          Date.now(),
        );
      } catch {}
    });
  } catch (error) {
    console.error("Failed to record truncated served rows:", error);
    throw error;
  }
}

function getReportedInner(
  store: HashStore,
  sessionKey: string,
  path: string,
): Set<string> {
  const row = servedStmts(store.db).servedGet(sessionKey, path);
  if (!row) return new Set();
  const raw = row.reported;
  if (typeof raw !== "string" || raw.length === 0) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter(
        (h): h is string => typeof h === "string" && HASH_RE.test(h),
      ),
    );
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
    servedStmts(store.db).servedReportedUpsert(
      sessionKey,
      path,
      JSON.stringify([...current]),
      Date.now(),
    );
  });
}

function clearReportedInner(
  store: HashStore,
  sessionKey: string,
  path: string,
): void {
  withStore(() => {
    servedStmts(store.db).servedReportedClear(sessionKey, Date.now(), path);
  });
}

function getCanonsInner(
  store: HashStore,
  sessionKey: string,
  path: string,
): (string | null)[] {
  const row = servedStmts(store.db).servedGet(sessionKey, path);
  if (!row || row.canons === null || row.canons === undefined) return [];
  try {
    const parsed = JSON.parse(row.canons as string) as unknown;
    if (!isValidCanonsList(parsed)) throw new TypeError("invalid canons");
    return parsed;
  } catch {
    servedStmts(store.db).servedDelete(sessionKey, path);
    return [];
  }
}

function getTombstoneInner(
  store: HashStore,
  sessionKey: string,
  path: string,
): Set<string> {
  const row = servedStmts(store.db).servedGet(sessionKey, path);
  if (!row || row.retired === null || row.retired === undefined)
    return new Set();
  try {
    const parsed = JSON.parse(row.retired as string) as unknown;
    if (!isValidHashList(parsed)) throw new TypeError("invalid retired");
    return new Set(parsed);
  } catch {
    servedStmts(store.db).servedDelete(sessionKey, path);
    return new Set();
  }
}

function getEpochIdInner(
  store: HashStore,
  sessionKey: string,
  path: string,
): string | undefined {
  const row = servedStmts(store.db).servedGet(sessionKey, path);
  if (!row || row.snapshotId === null || row.snapshotId === undefined)
    return undefined;
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
    if (!HASH_RE.test(hash))
      throw new TypeError(`Invalid retired hash: ${hash}`);
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
  return new Set(
    current.filter((h): h is string => h !== null && !remaining.has(h)),
  );
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
}):
  | { mode: "plain" }
  | { mode: "truncated"; lineCount: number; clearFrom: number } {
  if (typeof input.resultLineCount !== "number") return { mode: "plain" };
  return {
    mode: "truncated",
    lineCount: input.resultLineCount,
    clearFrom:
      input.firstChangedLine !== undefined ? input.firstChangedLine - 1 : 0,
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
    async loadCanons(): Promise<(string | null)[]> {
      const store = await resolveStore();
      return getCanonsInner(store, sessionKey, path);
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
    ): Promise<void> {
      if (rows.length === 0) return;
      const store = await resolveStore();
      recordServesTruncatedInner(
        store,
        sessionKey,
        path,
        rows,
        lineCount,
        clearFrom,
      );
    },
    async recordDiff(
      servedRows: ServedRow[],
      opts?: { resultLineCount?: number; firstChangedLine?: number },
    ): Promise<void> {
      if (servedRows.length === 0) return;
      const store = await resolveStore();
      const plan = planServeRecording(opts ?? {});
      if (plan.mode === "plain") {
        recordServesInner(store, sessionKey, path, servedRows);
        return;
      }
      recordServesTruncatedInner(
        store,
        sessionKey,
        path,
        servedRows,
        plan.lineCount,
        plan.clearFrom,
      );
    },
    async recordEcho(
      rows: ServedRow[],
      policy: ServeRecordPolicy,
      lineCount?: number,
    ): Promise<void> {
      if (policy !== "live") return;
      if (lineCount === undefined) {
        const store = await resolveStore();
        recordServesInner(store, sessionKey, path, rows);
        return;
      }
      const store = await resolveStore();
      recordServesTruncatedInner(
        store,
        sessionKey,
        path,
        rows,
        lineCount,
        undefined,
      );
    },
    async recordEpoch(input: {
      rows: ServedEntry[];
      lineCount?: number;
      fullReadHashes?: readonly string[];
      fullReadCanons?: readonly (string | null)[];
      snapshotId?: string;
      isFullRead?: boolean;
    }): Promise<void> {
      if (input.rows.length === 0 && !input.fullReadHashes) return;
      const store = await resolveStore();
      const isFullRead =
        input.isFullRead ??
        (input.fullReadHashes !== undefined &&
          input.rows.length === input.fullReadHashes.length &&
          input.rows.every(
            (row, index) =>
              row.position === index &&
              row.hash === input.fullReadHashes![index],
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
          if (updated.length > input.lineCount)
            updated.length = input.lineCount;
        }
        const changed =
          current.length !== updated.length ||
          current.some((v, i) => v !== updated[i]);
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
          servedStmts(store.db).servedRetiredClear(
            sessionKey,
            Date.now(),
            path,
          );
          if (input.fullReadCanons)
            servedStmts(store.db).servedCanonsUpsert(
              sessionKey,
              path,
              JSON.stringify(input.fullReadCanons),
              Date.now(),
            );
          if (input.snapshotId)
            servedStmts(store.db).servedSnapshotUpsert(
              sessionKey,
              path,
              input.snapshotId,
              Date.now(),
            );
        } else {
          if (input.fullReadCanons && input.fullReadHashes) {
            const canonByHash = new Map<string, string | null>();
            for (let i = 0; i < input.fullReadHashes.length; i++) {
              const h = input.fullReadHashes[i]!;
              const c = input.fullReadCanons[i] ?? null;
              if (h) canonByHash.set(h, c);
            }
            const currentCanons = getCanonsInner(store, sessionKey, path);
            const updatedCanons = currentCanons.slice();
            while (updatedCanons.length < (input.lineCount ?? 0))
              updatedCanons.push(null);
            for (const row of input.rows) {
              while (updatedCanons.length <= row.position)
                updatedCanons.push(null);
              const cv = row.hash ? (canonByHash.get(row.hash) ?? null) : null;
              updatedCanons[row.position] = cv;
            }
            while (
              updatedCanons.length > 0 &&
              updatedCanons[updatedCanons.length - 1] === null
            )
              updatedCanons.pop();
            servedStmts(store.db).servedCanonsUpsert(
              sessionKey,
              path,
              JSON.stringify(updatedCanons),
              Date.now(),
            );
          }
          if (input.snapshotId)
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
  servedStmts(store.db).servedWipe(sessionKey);
}

export async function loadTombstone(
  sessionKey: string,
  path: string,
): Promise<Set<string>> {
  const store = await loadHashStore();
  return getTombstoneInner(store, sessionKey, path);
}

export async function loadCanons(
  sessionKey: string,
  path: string,
): Promise<(string | null)[]> {
  const store = await loadHashStore();
  return getCanonsInner(store, sessionKey, path);
}

export async function loadEpochId(
  sessionKey: string,
  path: string,
): Promise<string | undefined> {
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
  servedStmts(store.db).servedDeletePath(path);
}

export function deleteServedByPath(store: HashStore, path: string): void {
  servedStmts(store.db).servedDeletePath(path);
}

// WHY: --- Legacy low-level exports for facade compat (keep import surface stable) ---
export function getServed(
  store: HashStore,
  sessionKey: string,
  path: string,
): (string | null)[] {
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

export function getReported(
  store: HashStore,
  sessionKey: string,
  path: string,
): Set<string> {
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

export function clearReported(
  store: HashStore,
  sessionKey: string,
  path: string,
): void {
  clearReportedInner(store, sessionKey, path);
}

export function deleteServed(
  store: HashStore,
  sessionKey: string,
  path: string,
): void {
  servedStmts(store.db).servedDelete(sessionKey, path);
}

export function wipeServed(store: HashStore, sessionKey: string): void {
  servedStmts(store.db).servedWipe(sessionKey);
}

export function recordServes(
  store: HashStore,
  sessionKey: string,
  path: string,
  rows: Array<{ position: number; hash: string | null }>,
): void {
  recordServesInner(store, sessionKey, path, rows);
}

export function recordServesTruncated(
  store: HashStore,
  sessionKey: string,
  path: string,
  rows: Array<{ position: number; hash: string | null }>,
  lineCount: number,
  clearFrom?: number,
): void {
  recordServesTruncatedInner(
    store,
    sessionKey,
    path,
    rows,
    lineCount,
    clearFrom,
  );
}
