import { NOOP_LOOP_THRESHOLD } from "./constants.js";
import { DomainError, formatWarning } from "./domain-errors.js";
import {
  buildRangeServeRows,
  fmtServedRows,
  type ResolvedRange,
} from "./served-session/serve-render.js";

type NoopLoopEntry = {
  payload: string;
  count: number;
};

// Ref: docs/.archive_adrs/0002-session-keyed-served-state.md
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

export function _noopLoopHasSession(sessionKey: string): boolean {
  return noopLoopTracker.has(sessionKey);
}

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
  /**
   * Present once an earlier item of a live batch has changed the working buffer: maps a buffer line
   * to its pre-batch line. When present the noop-loop rejection's rows come from an uncommitted
   * buffer and are shown and recorded only when absent.
   */
  baselineLineOf?: (bufferLine: number) => number | undefined;
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
    const baselineLineOf = input.baselineLineOf;
    if (baselineLineOf !== undefined) {
      const currentLines = [input.range.startLine, input.range.endLine]
        .map((line) => baselineLineOf(line))
        .filter((line): line is number => line !== undefined);
      const read =
        currentLines.length > 0
          ? `An anchored read of current-file lines ${Math.min(...currentLines)}-${Math.max(...currentLines)} would serve that range.`
          : "None of these rows exist in the current file.";
      const note =
        "An earlier item of this call had already changed the temporary batch buffer, so this " +
        `rejection shows no rows and none were recorded as served. ${read}`;
      const error = new DomainError("E_NOOP_LOOP", {
        ref: input.ref,
        removeFrom: input.removeFrom,
        removeTo: input.removeTo,
        count,
        batch: input.batch,
        servedRows: [],
        servedBlock: "",
        note,
      });
      return { action: "reject", count, error };
    }
    const servedRows = buildRangeServeRows(
      input.range.startLine,
      input.range.endLine,
      input.hashes,
    );
    const rendered = fmtServedRows(servedRows, input.lines);
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
