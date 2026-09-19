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
import { DomainError } from "../domain-errors.js";

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

interface ServedAnchorEntry {
  /** SAFETY: 1-based served position that carried the anchor. */
  servedLine: number;
  canonText: string;
}

interface ServedAnchorHit {
  /** SAFETY: 0-based candidate index within the submitted lines. */
  index: number;
  /** SAFETY: the served anchor that opens the candidate. */
  anchor: string;
  /** SAFETY: every served position that carried the anchor, in served order. */
  entries: ServedAnchorEntry[];
  candidateCanon: string;
}

/** Single owner of the anchor-shape parse: optional diff-marker strip, length, separator, class. */
const ANCHOR_SHAPE_RE = /^[A-Za-z0-9]{3}$/;

function anchorShapeFromLine(line: string): { anchor: string; tail: string } | undefined {
  let text = line;
  if (text.length > 0 && (text[0] === "+" || text[0] === "-" || text[0] === " ")) {
    text = text.slice(1);
  }
  if (text.length < 4) return undefined;
  if (text[3] !== HASH_SEP) return undefined;
  const anchor = text.slice(0, 3);
  if (!ANCHOR_SHAPE_RE.test(anchor)) return undefined;
  return { anchor, tail: text.slice(4) };
}

/**
 * SAFETY: Shared anchor index plus candidate scan for the served hash echo
 * gate and the served prefix mismatch tier. Builds the anchor-to-served
 * map once, then parses each candidate (one optional leading diff marker,
 * anchor, separator) in submitted order. Callers only differ in how they
 * judge the parsed hits, so reported ordering never diverges.
 */
function collectServedAnchorHits(
  lines: readonly string[],
  served: readonly (string | null)[],
  canons: readonly (string | null)[],
): ServedAnchorHit[] {
  const byAnchor = new Map<string, ServedAnchorEntry[]>();
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
  if (byAnchor.size === 0) return [];
  const hits: ServedAnchorHit[] = [];
  for (let index = 0; index < lines.length; index++) {
    const parsed = anchorShapeFromLine(lines[index]!);
    if (!parsed) continue;
    const entries = byAnchor.get(parsed.anchor);
    if (!entries) continue;
    hits.push({ index, anchor: parsed.anchor, entries, candidateCanon: canon(parsed.tail) });
  }
  return hits;
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
  for (const hit of collectServedAnchorHits(lines, served, canons)) {
    for (const entry of hit.entries) {
      if (entry.canonText === hit.candidateCanon) {
        return {
          k: hit.index + 1,
          line: start + hit.index,
          hash: hit.anchor,
          anchor: hit.anchor,
          servedLine: entry.servedLine,
        };
      }
    }
  }
  return undefined;
}

// WHY: the ad-hoc `ServedHashEchoError` subclass is retired (spec D1): the edit
// WHY: and write seams throw `DomainError` with `E_SUSPICIOUS_TEXT` instead, so
// WHY: `servedRows`, `servedBlock`, `cause`, and `details` keep their shape.
export { DomainError as ServedHashEchoError };

export interface ServedPrefixMismatch {
  /** SAFETY: 1-based candidate index within the submitted lines. */
  k: number;
  /** SAFETY: absolute candidate line (`start + k - 1`); equals `k` when `start` is 1. */
  line: number;
  /** SAFETY: the anchor served for this session and file that opens the candidate. */
  anchor: string;
  /** SAFETY: 1-based served position the anchor was served for. */
  servedLine: number;
}

/**
 * SAFETY: Served prefix mismatch — the middle tier beside the served hash echo gate.
 *
 * A candidate reports here when it opens with an anchor served for this session
 * and file, yet its remainder canon matches none of the canons served for that
 * anchor. Position-agnostic like the gate: `start` only shifts the reported
 * `line` and never narrows matching. Empty or all-null `canons` means no
 * served content to compare against, so the result stays empty — never a
 * shape-only report. Exact reproductions are excluded (the gate owns them),
 * so callers scan for this tier only after the gate stays silent.
 * Pure with no retained state: fires per occurrence, never suppressed.
 */
export function findServedPrefixMismatches(
  lines: readonly string[],
  served: readonly (string | null)[],
  canons: readonly (string | null)[],
  start = 1,
): ServedPrefixMismatch[] {
  const out: ServedPrefixMismatch[] = [];
  for (const hit of collectServedAnchorHits(lines, served, canons)) {
    let exact = false;
    for (const entry of hit.entries) {
      if (entry.canonText === hit.candidateCanon) {
        exact = true;
        break;
      }
    }
    if (exact) continue;
    out.push({
      k: hit.index + 1,
      line: start + hit.index,
      anchor: hit.anchor,
      servedLine: hit.entries[0]!.servedLine,
    });
  }
  return out;
}

/**
 * SAFETY: Model note for an applied edit carrying a served prefix mismatch.
 * Applied-only, bytes untouched, never blocks: the post-edit diff already
 * carries the written line, this note only tells the model the prefix
 * reproduces a served anchor with differing content and names the remedy.
 */
export function buildServedEditPrefixNote(args: {
  k: number;
  anchor: string;
  servedLine: number;
}): string {
  return (
    `[MODEL] Edit applied with a served anchor prefix: replacement line ${args.k} begins with ` +
    `the exact ${args.anchor}${HASH_SEP} anchor served for this session and file for line ${args.servedLine}, ` +
    `but its content differs from what was served. ` +
    `The bytes were written as-is. ` +
    `If the prefix was unintended, run undo_last_edit and retry with the same anchors, omitting the anchor prefix from the replacement text.`
  );
}

/**
 * SAFETY: Model note for an applied write carrying a served prefix mismatch.
 * Same applied-only, bytes-untouched contract as the edit note, surfaced
 * through the `tool_result` handler that owns the write auto-read.
 */
export function buildServedWritePrefixNote(args: {
  line: number;
  anchor: string;
  servedLine: number;
}): string {
  return (
    `[MODEL] Write applied with a served anchor prefix: line ${args.line} begins with ` +
    `the exact ${args.anchor}${HASH_SEP} anchor served for this session and file for line ${args.servedLine}, ` +
    `but its content differs from what was served. ` +
    `The bytes were written as-is. ` +
    `If the prefix was unintended, re-issue the write with the anchor prefix omitted from the written lines.`
  );
}

export interface NeverServedAnchorShape {
  /** SAFETY: 1-based candidate index within the submitted lines. */
  k: number;
  /** SAFETY: absolute candidate line (`start + k - 1`); equals `k` when `start` is 1. */
  line: number;
  /** SAFETY: the anchor-shaped prefix never served for this session and file. */
  anchor: string;
}

/**
 * SAFETY: Never-served anchor-shaped lines — the soft-hint tier beside the
 * refusal gate and the served prefix mismatch tier.
 *
 * A candidate reports here when it opens with an anchor-shaped prefix
 * (3 alphanumerics plus the separator, after one optional leading diff marker)
 * whose anchor was never served for this session and file. Shape-only by design:
 * the hint never blocks and never rewrites, so evidence gating does not apply.
 * Served anchors are excluded (the gate and the mismatch tier own them).
 * Pure with no retained state: fires per occurrence, never suppressed.
 */
export function findNeverServedAnchorShapes(
  lines: readonly string[],
  served: readonly (string | null)[],
  start = 1,
): NeverServedAnchorShape[] {
  const servedSet = new Set<string>();
  for (const anchor of served) {
    if (anchor !== null && anchor !== undefined) servedSet.add(anchor);
  }
  const out: NeverServedAnchorShape[] = [];
  for (let index = 0; index < lines.length; index++) {
    const parsed = anchorShapeFromLine(lines[index]!);
    if (!parsed) continue;
    if (servedSet.has(parsed.anchor)) continue;
    out.push({ k: index + 1, line: start + index, anchor: parsed.anchor });
  }
  return out;
}

/**
 * SAFETY: Soft hint for an applied edit carrying never-served anchor-shaped lines.
 * Applied-only, bytes untouched, never blocks: the bytes were written as-is with
 * no rewrite. Once per `edit` call however many offending lines it holds — `count`
 * states how many replacement lines match the tool's own row shape with anchors
 * never served for this session and file. Observation only: no remedy, no imperative.
 * Surfaced through the warnings seam (rendered by warnBlock) on the model-visible channel.
 */
export function buildNeverServedEditHint(args: { count: number }): string {
  const lines =
    args.count === 1
      ? "1 anchor-shaped replacement line"
      : `${args.count} anchor-shaped replacement lines`;
  const anchors =
    args.count === 1
      ? "an anchor never served for this session and file"
      : "anchors never served for this session and file";
  return (
    `[MODEL] Edit applied with ${lines} matching the tool's own row shape ` +
    `(HASH${HASH_SEP}content): ${anchors}. ` +
    `No action is required. The bytes were written as-is with no rewrite.`
  );
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

export function buildServedEditMessage(args: {
  path: string;
  k: number;
  hash: string;
  servedLine: number;
  count: number;
}): string {
  return new DomainError("E_SUSPICIOUS_TEXT", {
    target: "edit",
    path: args.path,
    line: args.k,
    hash: args.hash,
    servedLine: args.servedLine,
    count: args.count,
  }).message;
}

export function buildServedWriteMessage(args: {
  path: string;
  line: number;
  hash: string;
  servedLine: number;
  count: number;
}): string {
  return new DomainError("E_SUSPICIOUS_TEXT", {
    target: "write",
    path: args.path,
    line: args.line,
    hash: args.hash,
    servedLine: args.servedLine,
    count: args.count,
  }).message;
}
