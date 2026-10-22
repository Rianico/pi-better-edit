/**
 * SAFETY: ServedSession — deep module, small interface over session-scoped served state.
 *
 * External seam: SessionHandle bound to (sessionKey, path). All storage
 * (HashStore, SQLite, patchServed healing, truncation, reported-set, TTL)
 * lives inside session.ts — callers never thread sessionKey or touch SQL.
 * Two adapters justify the seam: SQLiteSnapshotStore (prod) vs MemoryStore (tests).
 */

export {
  createSessionHandle,
  sessionFromContext,
  sessionKeyFor,
  ensureServedSchema,
  wipeSession,
  getServed,
  upsertServed,
  getReported,
  addReported,
  clearReported,
  deleteServed,
  wipeServed,
  recordServes,
  recordServesTruncated,
  planServeRecording,
  loadBlockedHashes,
  loadCanonDigests,
  loadEpochId,
  loadLeases,
} from "./session.js";

export { servedPositionsOf } from "./serve-render.js";
export { currentPositionOfDrifted } from "./drift-helpers.js";
