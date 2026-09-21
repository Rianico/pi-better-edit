/**
 * SAFETY: ServedHashEcho — one evidence predicate for the served hash echo condition.
 *
 * CONTEXT.md served hash echo, ADR-0009 revision 2026-09-15: a candidate line
 * triggers only with evidence — it begins (after one optional leading `+`,
 * `-`, or space diff marker) with an anchor served for this session and path
 * at any position, AND the remainder reproduces the served content for that
 * anchor (`canonDigest(remainder) === served_leases.canon_hash`). One
 * such row suffices. No canon data means no evidence, so the candidate stays
 * silent — the tool never gates on the shape of a line.
 */

import { HASH_SEP, canonDigest } from "./hash-identity.js";
import { DomainError, formatWarning } from "../domain-errors.js";

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
  /** SAFETY: `served_leases.canon_hash` for this anchor — the served line's canon digest. */
  canonDigest: string;
}

interface ServedAnchorHit {
  /** SAFETY: 0-based candidate index within the submitted lines. */
  index: number;
  /** SAFETY: the served anchor that opens the candidate. */
  anchor: string;
  /** SAFETY: every served position that carried the anchor, in served order. */
  entries: ServedAnchorEntry[];
  /** SAFETY: `canonDigest` of the candidate's remainder, ready to compare against the entries. */
  candidateDigest: string;
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
  canonDigests: readonly (string | null)[],
): ServedAnchorHit[] {
  const byAnchor = new Map<string, ServedAnchorEntry[]>();
  for (let pos = 0; pos < served.length; pos++) {
    const anchor = served[pos];
    if (anchor === null || anchor === undefined) continue;
    const digest = pos < canonDigests.length ? (canonDigests[pos] ?? null) : null;
    if (digest === null) continue;
    const list = byAnchor.get(anchor);
    const entry = { servedLine: pos + 1, canonDigest: digest };
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
    hits.push({ index, anchor: parsed.anchor, entries, candidateDigest: canonDigest(parsed.tail) });
  }
  return hits;
}

/**
 * SAFETY: The single served hash echo predicate for the edit apply path and
 * the write hook. Position-agnostic and content-matched: `start` only shifts
 * the reported `line` (`line = start + k - 1`) and never narrows matching.
 * Empty or all-null `canonDigests` means no evidence, so the result stays silent. The digests are
 * the session's lease-derived canon hashes (#151): no canon text is stored anywhere.
 */
export function findServedHashEcho(
  lines: readonly string[],
  served: readonly (string | null)[],
  canonDigests: readonly (string | null)[],
  start = 1,
): ServedHashEchoMatch | undefined {
  for (const hit of collectServedAnchorHits(lines, served, canonDigests)) {
    for (const entry of hit.entries) {
      if (entry.canonDigest === hit.candidateDigest) {
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
 * and file, yet its remainder canon digest matches none of the digests the
 * leases recorded for that anchor's served line. Position-agnostic like the
 * gate: `start` only shifts the reported `line` and never narrows matching.
 * Empty or all-null `canonDigests` means no
 * served content to compare against, so the result stays empty — never a
 * shape-only report. Exact reproductions are excluded (the gate owns them),
 * so callers scan for this tier only after the gate stays silent.
 * Pure with no retained state: fires per occurrence, never suppressed.
 */
export function findServedPrefixMismatches(
  lines: readonly string[],
  served: readonly (string | null)[],
  canonDigests: readonly (string | null)[],
  start = 1,
): ServedPrefixMismatch[] {
  const out: ServedPrefixMismatch[] = [];
  for (const hit of collectServedAnchorHits(lines, served, canonDigests)) {
    let exact = false;
    for (const entry of hit.entries) {
      if (entry.canonDigest === hit.candidateDigest) {
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
 * SAFETY: the canonical remedy shared verbatim by both applied-hint builders
 * (this builder and `buildNeverServedEditHint`): the bytes were applied, so a
 * retry is knowably safe, and the remedy names the exact failing shape. Pinned
 * byte-identical by test so the two builders cannot drift.
 */
export const ANCHOR_PREFIX_REMEDY =
  "If the hash anchor prefix was unintended, `undo_last_edit`, then retry " +
  "with the same `anchor_from`/`anchor_to` and drop the anchor prefix from `replace_with`.";

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
  return `${formatWarning("W_SERVED_PREFIX_MISMATCH", {
    k: args.k,
    anchor: args.anchor,
    servedLine: args.servedLine,
  })} ${ANCHOR_PREFIX_REMEDY}`;
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
  return `${formatWarning("W_SERVED_PREFIX_MISMATCH", {
    k: args.line,
    anchor: args.anchor,
    servedLine: args.servedLine,
  })} If the prefix was unintended, re-issue the write with the anchor prefix omitted from the written lines.`;
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
 * never served for this session and file. The trailing conditional clause is deliberate:
 * gated on `if ... unintended`, it names the affordance that exists in that case
 * (`undo_last_edit`, then retry without the prefix) — a conditional reference, not an
 * order, carrying no run prefix. Both applied-hint builders (this one and
 * `buildServedEditPrefixNote`) carry the clause byte-identically, pinned by
 * test/core/served-prefix-note.test.ts.
 * Surfaced through the warnings seam (rendered by warnBlock) on the model-visible channel.
 */
export function buildNeverServedEditHint(args: { count: number }): string {
  return `${formatWarning("W_NEVER_SERVED_SHAPE", { count: args.count })} ${ANCHOR_PREFIX_REMEDY}`;
}

type RefusalEntry = {
  payload: string;
  count: number;
};

/**
 * SAFETY: the refusal tally beside the served hash echo gate — one flat composite-key
 * cache (`${sessionKey}\0${absolutePath}`). Serves are session-keyed (ADR-0002), so one
 * session's count must never leak into another session refusing the same path. The flat
 * key keeps lookup, size, and eviction O(1) with no per-session scan. The `\0` separator
 * is enforced, never assumed (`refusalKey` rejects a part carrying one), so two scopes
 * cannot fuse into one key. A session-less caller is not tallied at all — a constant
 * fallback bucket would recreate exactly the sharing this keying removes.
 */
const servedRefusalTracker = new Map<string, RefusalEntry>();

/**
 * SAFETY: the single bound on a long-running process. An entry is otherwise kept
 * until a committed write clears its path, and no session-end seam exists to release
 * it (`src/lifecycle-hooks/index.ts`, `src/served-session/session.ts`, and
 * `src/index.ts` observe no session teardown), while session count is unbounded — so
 * the cap must sit on the total, never per session. 256 covers any realistic working
 * set: refusals are rare events and a session holds at most one entry per refused
 * path. Eviction is true LRU over `Map` insertion order — a resubmission re-inserts
 * its key and moves it to the tail, so the least recently refused key is at the head
 * and no session is drained before another (no clock, no sweeper).
 */
export const SERVED_REFUSAL_MAX_ENTRIES = 256;

// WHY: `sessionKey` and `absolutePath` travel as two primitives through `refusalKey`,
// WHY: `clearServedRefusals`, and both `trackServed*` seams, mirroring the established
// WHY: `(sessionKey, path)` convention (`createSessionHandle`, `loadServed`,
// WHY: `clearNoopLoop`): a refusal scope is a pair of already-typed values, so a
// WHY: `RefusalScope` wrapper would add an allocation per refusal without narrowing the
// WHY: interface or preventing an argument-order slip.
/**
 * SAFETY: the one encoding of a refusal scope. The `\0` separator is enforced, never
 * assumed: a part carrying one is rejected outright, because two scopes that fused into a
 * single key would silently share a count — the exact defect #132 removed.
 */
function refusalKey(sessionKey: string, absolutePath: string): string {
  if (sessionKey.includes("\0") || absolutePath.includes("\0")) {
    throw new TypeError(
      `Invalid refusal scope: NUL in session key or path (${JSON.stringify(sessionKey)} / ${JSON.stringify(absolutePath)})`,
    );
  }
  return `${sessionKey}\0${absolutePath}`;
}

function trackRefusal(sessionKey: string, absolutePath: string, payload: string): number {
  const key = refusalKey(sessionKey, absolutePath);
  const existing = servedRefusalTracker.get(key);
  const count = existing && existing.payload === payload ? existing.count + 1 : 1;
  // WHY: `Map.set` on an existing key keeps its original position, so the delete is what
  // WHY: refreshes recency — a resubmitted refusal moves to the tail and survives eviction.
  servedRefusalTracker.delete(key);
  servedRefusalTracker.set(key, { payload, count });
  // WHY: a `while`, not an `if`: the cap must hold for whatever a future caller inserts in
  // WHY: one refusal, and evicting after the insert keeps the head invariant obvious — the
  // WHY: head is always the least recently refused key.
  while (servedRefusalTracker.size > SERVED_REFUSAL_MAX_ENTRIES) {
    for (const oldest of servedRefusalTracker.keys()) {
      servedRefusalTracker.delete(oldest);
      break;
    }
  }
  return count;
}

/**
 * SAFETY: the clear side of the tally, separated from verification:
 * `trackServed*Refusal` records while the edit is still uncommitted, and only a committed
 * write clears — the two sites (`mutation-engine/pipeline.ts` post-commit,
 * `lifecycle-hooks` post-write), so a refusal that wrote nothing keeps its count for the
 * resubmission. Clearing is per session: another session's tally describes what that
 * session submitted, so this session's write must not erase it. The composite key drops
 * exactly that session's path.
 */
export function clearServedRefusals(sessionKey: string, absolutePath: string): void {
  servedRefusalTracker.delete(refusalKey(sessionKey, absolutePath));
}

/** SAFETY: test seam only — the policy path never reads it. Lets the unit check confirm the total-entry cap holds. */
export function _servedRefusalSize(): number {
  return servedRefusalTracker.size;
}

/** SAFETY: test seam only — the policy path never calls it. Empties the module cache so each unit check starts from a known tracker size. */
export function clearAllServedRefusalsForTest(): void {
  servedRefusalTracker.clear();
}

export function trackServedEditRefusal(
  sessionKey: string,
  absolutePath: string,
  anchorFrom: string,
  anchorTo: string,
  offendingLine: string,
): number {
  return trackRefusal(
    sessionKey,
    absolutePath,
    JSON.stringify([anchorFrom, anchorTo, offendingLine]),
  );
}

export function trackServedWriteRefusal(
  sessionKey: string,
  absolutePath: string,
  offendingLine: string,
): number {
  return trackRefusal(sessionKey, absolutePath, JSON.stringify([offendingLine]));
}

/** SAFETY: dimmed human line for a literal declaration; never a model retry instruction. */
export const LITERAL_BYPASS_NOTICE = formatWarning("W_LITERAL_BYPASS", {});

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
