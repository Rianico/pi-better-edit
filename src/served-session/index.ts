/**
 * ServedSession — deep module, small interface over session-scoped served state.
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
} from "./session.js";

// reconsume utilities that were previously on served-state but belong to
// the session's view of drift — keep them co-located, re-export for
// drift.ts and tests without leaking the store seam.
export { servedPositionsOf } from "../hashline/served.js";
export { currentPositionOfDrifted } from "./drift-helpers.js";
