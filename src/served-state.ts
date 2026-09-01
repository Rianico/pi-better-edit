/**
 * Served-state facade — thin graded surface over ServedSession deep module.
 *
 * Implementation lives in `src/served-session/session.ts` (deep module hiding
 * HashStore, sessionKey, patchServed healing, truncation, reported-set, TTL).
 * This facade re-exports the handle seam plus legacy exports for import
 * stability. New code should import from `src/served-session/index.js`
 * and use `createSessionHandle(sessionKey, path)` — no sessionKey threading
 * outside the handle. Delete this facade once all callers migrate.
 */

export type { ServedEntry } from "./served-session/types.js";

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
} from "./served-session/session.js";

export { createSessionHandle as createServedSession } from "./served-session/session.js";

export { servedPositionsOf } from "./hashline/served.js";
export { currentPositionOfDrifted } from "./served-session/drift-helpers.js";

export type { ServeRecordPolicy, ServeRecordingPlan } from "./served-session/types.js";

import { loadHashStore } from "./hash-store.js";
import { createSessionHandle } from "./served-session/session.js";
import type { ServedRow } from "./hashline/served.js";
import type { ServedEntry } from "./served-session/types.js";
import type { ServeRecordPolicy } from "./served-session/types.js";

// Re-export plan helper (pure, no store)
export function planServeRecording(input: { resultLineCount?: number; firstChangedLine?: number }): import("./served-session/types.js").ServeRecordingPlan {
  if (typeof input.resultLineCount !== "number") return { mode: "plain" };
  return { mode: "truncated", lineCount: input.resultLineCount, clearFrom: input.firstChangedLine !== undefined ? input.firstChangedLine - 1 : 0 };
}

export async function loadServed(sessionKey: string, path: string): Promise<(string | null)[]> {
  const store = await loadHashStore();
  const handle = createSessionHandle(sessionKey, path, store);
  return handle.load();
}

export async function recordServed(sessionKey: string, path: string, rows: ServedEntry[]): Promise<void> {
  const store = await loadHashStore();
  const handle = createSessionHandle(sessionKey, path, store);
  await handle.record(rows);
}

export async function recordServedTruncated(
  sessionKey: string,
  path: string,
  rows: ServedEntry[],
  lineCount: number,
  clearFrom?: number,
): Promise<void> {
  const store = await loadHashStore();
  const handle = createSessionHandle(sessionKey, path, store);
  await handle.recordTruncated(rows, lineCount, clearFrom);
}

export async function driftReported(sessionKey: string, path: string): Promise<Set<string>> {
  const store = await loadHashStore();
  const handle = createSessionHandle(sessionKey, path, store);
  return handle.driftReported();
}

export async function markDriftReported(sessionKey: string, path: string, hashes: string[]): Promise<void> {
  const store = await loadHashStore();
  const handle = createSessionHandle(sessionKey, path, store);
  await handle.markDriftReported(hashes);
}

export async function clearDriftReported(sessionKey: string, path: string): Promise<void> {
  const store = await loadHashStore();
  const handle = createSessionHandle(sessionKey, path, store);
  await handle.clearDrift();
}

export async function wipeServedState(sessionKey: string): Promise<void> {
  const { wipeSession } = await import("./served-session/session.js");
  await wipeSession(sessionKey);
}

export async function recordEchoServes(
  sessionKey: string,
  path: string,
  rows: ServedRow[],
  policy: ServeRecordPolicy,
  lineCount?: number,
): Promise<void> {
  const store = await loadHashStore();
  const handle = createSessionHandle(sessionKey, path, store);
  await handle.recordEcho(rows, policy, lineCount);
}

export async function recordDiffServes(input: {
  sessionKey: string;
  path: string;
  servedRows: ServedRow[];
  resultLineCount?: number;
  firstChangedLine?: number;
}): Promise<void> {
  const store = await loadHashStore();
  const handle = createSessionHandle(input.sessionKey, input.path, store);
  await handle.recordDiff(input.servedRows, {
    resultLineCount: input.resultLineCount,
    firstChangedLine: input.firstChangedLine,
  });
}

