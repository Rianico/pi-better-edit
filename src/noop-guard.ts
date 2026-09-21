import { NOOP_LOOP_THRESHOLD } from "./constants.js";
import { DomainError, formatWarning } from "./domain-errors.js";
import { buildRangeServeRows, fmtServedRows, type ResolvedRange } from "./hashline/served.js";
import { createSessionHandle } from "./served-session/session.js";

type NoopLoopEntry = {
  payload: string;
  count: number;
};

// WHY: session-keyed slots (`session -> path -> ref -> entry`): serves are
// WHY: session-keyed (ADR-0002), so one session's counts must never leak into
// WHY: another session editing the same file. Siblings in one call carry
// WHY: distinct payloads per `ref`, so a shared key would let each item reset
// WHY: the other's count and the loop would never trip. Nested maps keep the
// WHY: slots structurally separate (no separator to collide). Clearing takes
// WHY: the session first because the session owns the authority: one delete
// WHY: drops the whole session tracker, and one nested delete drops a single
// WHY: file's slots. A single-item call carries only `edit[0]`, so its
// WHY: behaviour is unchanged.
const noopLoopTracker = new Map<string, Map<string, Map<string, NoopLoopEntry>>>();

function noopPayloadKey(
  absolutePath: string,
  removeFrom: string,
  removeTo: string,
  replacementText: string,
): string {
  return JSON.stringify([absolutePath, removeFrom, removeTo, replacementText]);
}

function trackNoopPayload(
  sessionKey: string,
  absolutePath: string,
  ref: string,
  payload: string,
): number {
  let perSession = noopLoopTracker.get(sessionKey);
  if (perSession === undefined) {
    perSession = new Map<string, Map<string, NoopLoopEntry>>();
    noopLoopTracker.set(sessionKey, perSession);
  }
  let perPath = perSession.get(absolutePath);
  if (perPath === undefined) {
    perPath = new Map<string, NoopLoopEntry>();
    perSession.set(absolutePath, perPath);
  }
  const existing = perPath.get(ref);
  const count = existing && existing.payload === payload ? existing.count + 1 : 1;
  perPath.set(ref, { payload, count });
  return count;
}

export function clearNoopLoop(sessionKey: string, absolutePath?: string): void {
  if (absolutePath === undefined) {
    noopLoopTracker.delete(sessionKey);
    return;
  }
  const perSession = noopLoopTracker.get(sessionKey);
  if (perSession === undefined) {
    return;
  }
  perSession.delete(absolutePath);
  if (perSession.size === 0) {
    noopLoopTracker.delete(sessionKey);
  }
}

// WHY: test seam only — lets the unit check confirm the per-path
// WHY: clear releases the session entry once its last path is gone,
// WHY: so a long-lived process keeps no empty maps. Never used
// WHY: outside tests; the policy path stays unchanged.
export function _noopLoopHasSession(sessionKey: string): boolean {
  return noopLoopTracker.has(sessionKey);
}

// WHY: NOOP_LOOP_THRESHOLD re-export removed

export interface NoopPolicyInput {
  absolutePath: string;
  removeFrom: string;
  removeTo: string;
  replacementText: string;
  ref: string;
  batch: boolean;
  range: ResolvedRange;
  hashes: string[];
  lines: string[];
  sessionKey: string;
  /** Committed `file_snapshots.snapshot_hash` of the served content; binds the served leases. */
  contentHash: string;
}

export type NoopPolicyOutcome =
  | { action: "proceed"; count: number }
  | { action: "warn"; count: number; notice: string }
  | { action: "reject"; count: number; error: DomainError<"E_NOOP_LOOP"> };

export async function runNoopPolicy(input: NoopPolicyInput): Promise<NoopPolicyOutcome> {
  const payload = noopPayloadKey(
    input.absolutePath,
    input.removeFrom,
    input.removeTo,
    input.replacementText,
  );
  const count = trackNoopPayload(input.sessionKey, input.absolutePath, input.ref, payload);

  if (count >= NOOP_LOOP_THRESHOLD) {
    const servedRows = buildRangeServeRows(
      input.range.startLine,
      input.range.endLine,
      input.hashes,
      input.lines,
    );
    const rendered = fmtServedRows(servedRows, input.lines);
    await createSessionHandle(input.sessionKey, input.absolutePath).recordServeFeedback(
      servedRows,
      "live",
      input.hashes.length,
      input.contentHash,
    );
    const error = new DomainError("E_NOOP_LOOP", {
      ref: input.ref,
      removeFrom: input.removeFrom,
      removeTo: input.removeTo,
      count,
      batch: input.batch,
      servedRows,
      servedBlock: rendered,
    });
    return { action: "reject", count, error };
  }

  if (count === 2) {
    const notice = formatWarning("W_NOOP", {
      ref: input.ref,
      removeFrom: input.removeFrom,
      removeTo: input.removeTo,
      batch: input.batch,
      count,
    });
    return { action: "warn", count, notice };
  }

  return { action: "proceed", count };
}
