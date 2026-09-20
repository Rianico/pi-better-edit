import { NOOP_LOOP_THRESHOLD } from "./constants.js";
import { DomainError, formatWarning } from "./domain-errors.js";
import { buildRangeServeRows, fmtServedRows, type ResolvedRange } from "./hashline/served.js";
import { createSessionHandle } from "./served-session/session.js";

type NoopLoopEntry = {
  payload: string;
  count: number;
};

// WHY: one slot per sibling item (`path -> ref -> entry`): siblings in one call
// WHY: carry distinct payloads, so a shared path key would let each item reset
// WHY: the other's count and the loop would never trip. A nested map keeps the
// WHY: slots structurally separate (no separator to collide) and lets
// WHY: `clearNoopLoop(path)` drop every slot with one delete. A single-item
// WHY: call carries only `edit[0]`, so its behaviour is unchanged.
const noopLoopTracker = new Map<string, Map<string, NoopLoopEntry>>();

function noopPayloadKey(
  absolutePath: string,
  removeFrom: string,
  removeTo: string,
  replacementText: string,
): string {
  return JSON.stringify([absolutePath, removeFrom, removeTo, replacementText]);
}

function trackNoopPayload(absolutePath: string, ref: string, payload: string): number {
  let perPath = noopLoopTracker.get(absolutePath);
  if (perPath === undefined) {
    perPath = new Map<string, NoopLoopEntry>();
    noopLoopTracker.set(absolutePath, perPath);
  }
  const existing = perPath.get(ref);
  const count = existing && existing.payload === payload ? existing.count + 1 : 1;
  perPath.set(ref, { payload, count });
  return count;
}

export function clearNoopLoop(absolutePath: string): void {
  noopLoopTracker.delete(absolutePath);
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
  const count = trackNoopPayload(input.absolutePath, input.ref, payload);

  if (count >= NOOP_LOOP_THRESHOLD) {
    const servedRows = buildRangeServeRows(
      input.range.startLine,
      input.range.endLine,
      input.hashes,
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
