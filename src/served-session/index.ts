/**
 * SAFETY: ServedSession — deep module, small interface over session-scoped served state.
 *
 * External seam: SessionHandle bound to (sessionKey, path). All storage
 * (HashStore, SQLite, patchServed healing, truncation, reported-set, TTL)
 * lives inside session.ts — callers never thread sessionKey or touch SQL.
 * Two adapters justify the seam: SQLiteSnapshotStore (prod) vs MemoryStore (tests).
 */

export type { SessionHandle, ServedEntry, ServeRecordPolicy, ServeRecordingPlan } from "./types.js";

export {
  createSessionHandle,
  sessionFromContext,
  sessionKeyFor,
  ensureServedSchema,
  wipeSession,
  deleteServedByPath,
  deleteServedByPathAsync,
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
  retireAnchors,
  loadLease,
  loadLeases,
  retireAbsentLeases,
  type ServedLease,
} from "./session.js";

export { servedPositionsOf } from "../hashline/served.js";
export { currentPositionOfDrifted } from "./drift-helpers.js";
