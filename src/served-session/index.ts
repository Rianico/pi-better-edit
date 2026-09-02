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
  loadTombstone,
  loadCanons,
  loadEpochId,
  retireAnchors,
} from "./session.js";

export { servedPositionsOf } from "../hashline/served.js";
export { currentPositionOfDrifted } from "./drift-helpers.js";

import { createSessionHandle, wipeSession } from "./session.js";

// WHY: Compatibility wrappers (sessionKey-based, store lifecycle hidden)
export async function recordServedTruncated(sessionKey: string, path: string, rows: import("./types.js").ServedEntry[], lineCount: number, clearFrom?: number): Promise<void> {
  await createSessionHandle(sessionKey, path).recordTruncated(rows, lineCount, clearFrom);
}

// WHY: Store lifecycle stays inside handle; these wrappers do not leak withStore.
export async function loadServed(sessionKey: string, path: string): Promise<(string | null)[]> {
  return createSessionHandle(sessionKey, path).load();
}
export async function recordServed(sessionKey: string, path: string, rows: import("./types.js").ServedEntry[]): Promise<void> {
  await createSessionHandle(sessionKey, path).record(rows);
}
export async function recordEchoServes(sessionKey: string, path: string, rows: import("../hashline/served.js").ServedRow[], policy: import("./types.js").ServeRecordPolicy, lineCount?: number): Promise<void> {
  await createSessionHandle(sessionKey, path).recordEcho(rows, policy, lineCount);
}
export async function recordDiffServes(input: { sessionKey: string; path: string; servedRows: import("../hashline/served.js").ServedRow[]; resultLineCount?: number; firstChangedLine?: number }): Promise<void> {
  await createSessionHandle(input.sessionKey, input.path).recordDiff(input.servedRows, { resultLineCount: input.resultLineCount, firstChangedLine: input.firstChangedLine });
}
export function planServeRecording(input: { resultLineCount?: number; firstChangedLine?: number }): import("./types.js").ServeRecordingPlan {
  if (typeof input.resultLineCount !== "number") return { mode: "plain" };
  return { mode: "truncated", lineCount: input.resultLineCount, clearFrom: input.firstChangedLine !== undefined ? input.firstChangedLine - 1 : 0 };
}
export async function driftReported(sessionKey: string, path: string): Promise<Set<string>> {
  return createSessionHandle(sessionKey, path).driftReported();
}
export async function markDriftReported(sessionKey: string, path: string, hashes: string[]): Promise<void> {
  await createSessionHandle(sessionKey, path).markDriftReported(hashes);
}
export async function clearDriftReported(sessionKey: string, path: string): Promise<void> {
  await createSessionHandle(sessionKey, path).clearDrift();
}
export async function wipeServedState(sessionKey: string): Promise<void> {
  await wipeSession(sessionKey);
}
