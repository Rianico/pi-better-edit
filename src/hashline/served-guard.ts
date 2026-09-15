/**
 * SAFETY: ServedHashEcho — one evidence predicate for the served hash echo condition.
 *
 * CONTEXT.md served hash echo, ADR-0009 revision 2026-09-15: a candidate line
 * triggers only with evidence — it begins (after one optional leading `+`,
 * `-`, or space diff marker) with an anchor served for this session and path
 * at any position, AND the remainder reproduces the served content for that
 * anchor (`canon(remainder) === canon(content served for that anchor)`). One
 * such row suffices. No canon data means no evidence, so the candidate stays
 * silent — the tool never gates on the shape of a line.
 */

import { HASH_SEP, canon } from "./hash-identity.js";
import { AnchorMismatchError, type ServedRow } from "./served.js";

export interface ServedHashEchoMatch {
  /** SAFETY: 1-based candidate index within the submitted lines. */
  k: number;
  /** SAFETY: absolute candidate line (`start + k - 1`); equals `k` when `start` is 1. */
  line: number;
  /** SAFETY: the exact anchor served for this session, path, and served line. */
  hash: string;
  /** SAFETY: alias for `hash` — the served anchor the candidate reproduces. */
  anchor: string;
  /** SAFETY: 1-based served position whose content the candidate reproduces. */
  servedLine: number;
}

/**
 * SAFETY: The single served hash echo predicate for the edit apply path and
 * the write hook. Position-agnostic and content-matched: `start` only shifts
 * the reported `line` (`line = start + k - 1`) and never narrows matching.
 * Empty or all-null `canons` means no evidence, so the result stays silent.
 */
export function findServedHashEcho(
  lines: readonly string[],
  served: readonly (string | null)[],
  canons: readonly (string | null)[],
  start = 1,
): ServedHashEchoMatch | undefined {
  const byAnchor = new Map<string, Array<{ servedLine: number; canonText: string }>>();
  for (let pos = 0; pos < served.length; pos++) {
    const anchor = served[pos];
    if (anchor === null || anchor === undefined) continue;
    const canonText = pos < canons.length ? (canons[pos] ?? null) : null;
    if (canonText === null) continue;
    const list = byAnchor.get(anchor);
    const entry = { servedLine: pos + 1, canonText };
    if (list) list.push(entry);
    else byAnchor.set(anchor, [entry]);
  }
  if (byAnchor.size === 0) return undefined;
  for (let index = 0; index < lines.length; index++) {
    let text = lines[index]!;
    if (text.length > 0 && (text[0] === "+" || text[0] === "-" || text[0] === " ")) {
      text = text.slice(1);
    }
    if (text.length < 4) continue;
    if (text[3] !== HASH_SEP) continue;
    const anchor = text.slice(0, 3);
    if (!/^[A-Za-z0-9]{3}$/.test(anchor)) continue;
    const candidates = byAnchor.get(anchor);
    if (!candidates) continue;
    const remainder = text.slice(4);
    const candidateCanon = canon(remainder);
    for (const entry of candidates) {
      if (entry.canonText === candidateCanon) {
        return {
          k: index + 1,
          line: start + index,
          hash: anchor,
          anchor,
          servedLine: entry.servedLine,
        };
      }
    }
  }
  return undefined;
}

export class ServedHashEchoError extends AnchorMismatchError {
  constructor(message: string, servedRows: ServedRow[] = []) {
    super(message, servedRows);
    this.name = "ServedHashEchoError";
  }
}

type RefusalEntry = {
  payload: string;
  count: number;
};

const servedRefusalTracker = new Map<string, RefusalEntry>();

function trackRefusal(absolutePath: string, payload: string): number {
  const existing = servedRefusalTracker.get(absolutePath);
  const count = existing && existing.payload === payload ? existing.count + 1 : 1;
  servedRefusalTracker.set(absolutePath, { payload, count });
  return count;
}

export function clearServedRefusals(absolutePath: string): void {
  servedRefusalTracker.delete(absolutePath);
}

export function trackServedEditRefusal(
  absolutePath: string,
  anchorFrom: string,
  anchorTo: string,
  offendingLine: string,
): number {
  return trackRefusal(absolutePath, JSON.stringify([anchorFrom, anchorTo, offendingLine]));
}

export function trackServedWriteRefusal(absolutePath: string, offendingLine: string): number {
  return trackRefusal(absolutePath, JSON.stringify([offendingLine]));
}

/** SAFETY: dimmed human line for a literal declaration; never a model retry instruction. */
export const LITERAL_BYPASS_NOTICE = "[USER] served-echo check bypassed by literal declaration";

function sharpenedTail(count: number): string {
  if (count < 2) return "";
  return (
    ` Identical refusal submitted ${count}× — the bytes still reproduce a served row.` +
    ` Remove the copied anchors and retry, or declare intent with mode: "literal".`
  );
}

export function buildServedEditMessage(args: {
  path: string;
  k: number;
  hash: string;
  servedLine: number;
  count: number;
}): string {
  const base =
    `[MODEL] [E_SERVED_ECHO] Refused edit to ${args.path}: replacement line ${args.k} begins with ` +
    `the exact ${args.hash}${HASH_SEP} anchor served for this session, path, and line ${args.servedLine}. ` +
    `HASH${HASH_SEP} anchors are tool output, not file content. ` +
    `Remove the copied anchors and retry, or declare intent with mode: "literal". ` +
    `Re-read the file for fresh anchors if needed. nothing was written. (submission ${args.count}×)`;
  return base + sharpenedTail(args.count);
}

export function buildServedWriteMessage(args: {
  path: string;
  line: number;
  hash: string;
  servedLine: number;
  count: number;
}): string {
  const base =
    `[MODEL] [E_SERVED_ECHO] Refused write to ${args.path}: line ${args.line} begins with ` +
    `the exact ${args.hash}${HASH_SEP} anchor served for this session, path, and line ${args.servedLine}. ` +
    `HASH${HASH_SEP} anchors are tool output, not file content. ` +
    `Retry with file content only (remove the entire copied anchor chain), or declare intent with mode: "literal". ` +
    `Re-read the file for fresh anchors if needed. nothing was written. (submission ${args.count}×)`;
  return base + sharpenedTail(args.count);
}
