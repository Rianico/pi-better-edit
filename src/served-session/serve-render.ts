/**
 * SAFETY: serve-render — deep module owning the shared serve-row/rejection/verification surface.
 *
 * It is the serve→mirror→lease→retire machine's pure render adapter: it builds the rows a serve
 * shows (`buildRangeServeRows`/`denseServeRows`/`fmtServedRows`) and the rows a rejection shows
 * (`makeServedRejection`/`makeStaleAnchorRejection`/`makeTargetLostRejection`), and it verifies the
 * served rows themselves (the served hash echo and prefix-mismatch evidence gates, the never-served
 * shape scan, the rejection bookkeeping, and the lease seam's `verifyRebasedSpan`). It owns no
 * session state: every input arrives as an argument, and the session module is the only writer.
 *
 * This module absorbs the served-range verification sprawl previously in served.ts:
 *  - served span position lookup (servedPositionsOf)
 *  - rebased-span contiguity gate for the MVCC dynamic rebase path (spec §3.1.1 / Probe J)
 *  - serve-block building (buildRangeServeRows/fmtServedRows/paginationHint)
 *  - the dense serve-row projection (denseServeRows) — the single owner of the serve-record row shape
 *  - the reject-and-serve rejection builders (makeServedRejection / makeTargetLostRejection /
 *    makeStaleAnchorRejection)
 *
 * ADR-0008 heuristic canon healing is retired (spec §3.3): un-rebased coordinates reject
 * fail-closed with E_STALE_RANGE. Coordinate realignment is owned exclusively by MVCC
 * `pairSnapshots` + `line_lineage` upstream in the edit path.
 *
 * The lease seam owns verification for every edit it resolves (#151): `verifyRebasedSpan` checks the
 * whole served window by lease identity. The module's former mirror-vs-mirror decision table
 * (`ServedVerification`, `verifyServedRange`) served only the library-level seam — a caller with a
 * served mirror and no lease source — and had no live caller, so it is retired (#10).
 *
 * CONTEXT.md terms preserved: serve, served state, served span, served-range
 * staleness, never-served, reject-and-serve, drift, orphaned serve, orphaning
 * re-serve, relocated line keeps its hash.
 */
import { HASH_LEN, HASH_RE } from "../hashline/alphabet.js";
import { HASH_SEP } from "../hashline/hash-identity.js";
import { canonDigest } from "../hashline/hash-identity.js";
import { SERVED_ROWS_CAP } from "../constants.js";
import {
  DomainError,
  UNVERIFIED_HEADLINE,
  formatWarning,
  type RangeCause,
  type ServedRow,
} from "../domain-errors.js";
import type { LeaseIdentityView } from "../hashline/resolve.js";

// WHY: ---------------------------------------------------------------------------
// WHY: Public contracts — mirrors served.ts so it can re-export without identity split
// WHY: ---------------------------------------------------------------------------

export { UNVERIFIED_HEADLINE, type RangeCause, type ServedRow };

export interface FileSnapshotContext {
  fileHashes: string[];
  fileLines: string[];
  filePath?: string;
}

// WHY: ---------------------------------------------------------------------------
// WHY: Shared formatting helpers — owned by verification (reject-and-serve contract)
// WHY: ---------------------------------------------------------------------------

/**
 * WHY: rows carry position and hash only. Canon evidence is never stored: it is derived on demand
 * WHY: from the session's leases (`served_leases.canon_hash`), so a producer holding the file's lines
 * WHY: has nothing extra to stamp (issue #151).
 */
export function buildRangeServeRows(
  startLine: number,
  endLine: number,
  fileHashes: string[],
): ServedRow[] {
  const total = endLine - startLine + 1;
  const shown = Math.min(total, SERVED_ROWS_CAP);
  const rows: ServedRow[] = [];
  for (let ln = startLine; ln < startLine + shown; ln++) {
    const position = ln - 1;
    const hash = fileHashes[position]!;
    rows.push({ position, hash });
  }
  return rows;
}

// WHY: the serve-record shape has no owner; this is it — the dense projection of a file's whole
// WHY: hash array to serve rows: position is the 0-based array index, hash the anchor at that index.
export function denseServeRows(hashes: readonly string[]): ServedRow[] {
  return hashes.map((hash, position) => ({ position, hash }));
}

export function fmtServedRows(rows: ServedRow[], fileLines: string[]): string {
  return rows.map((row) => `${row.hash}${HASH_SEP}${fileLines[row.position] ?? ""}`).join("\n");
}

// WHY: the one continuation a rejected edit offers (read-chrome): the `windows` offset, not a bare
// WHY: `offset`, because `offset` alone no longer continues anything a page footer used to name.
function paginationHint(nextOffset: number, more: number): string {
  return `[... ${more} more — use windows: [{ offset: ${nextOffset} }]]`;
}

export function servedPositionsOf(served: (string | null)[], hash: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < served.length; i++) {
    if (served[i] === hash) out.push(i);
  }
  return out;
}

// WHY: ---------------------------------------------------------------------------
// WHY: Reject-and-serve builders + MVCC rebased-span contiguity gate (spec §3.1.1)
// WHY: ---------------------------------------------------------------------------

/** Builds the reject-and-serve served rows + rendered block for a current on-disk range. */
function buildRangeServeBlock(
  startLine: number,
  endLine: number,
  fileHashes: string[],
  fileLines: string[],
): { servedRows: ServedRow[]; rendered: string } {
  const len = fileHashes.length;
  const first = Math.max(1, Math.min(startLine, Math.max(len, 1)));
  const last = Math.max(first, Math.min(endLine, Math.max(len, first)));
  const servedRows = buildRangeServeRows(first, last, fileHashes);
  const totalLen = endLine - startLine + 1;
  const tail =
    first === startLine && servedRows.length < totalLen
      ? `\n${paginationHint(startLine + servedRows.length, totalLen - servedRows.length)}`
      : "";
  return { servedRows, rendered: fmtServedRows(servedRows, fileLines) + tail };
}

/**
 * One reject-and-serve assembly shared by the retry-code entry points: the block build lives
 * here so the served rows cannot drift between codes. The `[MODEL] [CODE]` prefix, the
 * `Current range (fresh read):` heading renders in the domain-errors registry formats, so this
 * helper returns rows and block only. Every code that routes here serves the rows as a fresh read
 * the model decides from — never a blind-retry mandate (issue #149).
 */
function assembleRejectAndServe(args: {
  startLine: number;
  endLine: number;
  snapshot: FileSnapshotContext;
}): { servedRows: ServedRow[]; servedBlock: string } {
  const { servedRows, rendered } = buildRangeServeBlock(
    args.startLine,
    args.endLine,
    args.snapshot.fileHashes,
    args.snapshot.fileLines,
  );
  return { servedRows, servedBlock: rendered };
}

/**
 * Builds an `[E_TARGET_LOST]` rejection for a retired leased identity whose range cannot be
 * identified (spec stale-identity-reject-and-serve D1/D6, ADR-0018 decisions 1-2). The payload
 * carries no rows, no `Current range` heading and no retry hint. §D6's row-shape phrasing is
 * superseded in part by ADR-0021 d4: the code alone selects the remedy and row presence is a
 * payload detail — target-side `[E_STALE_RANGE]`/`[E_UNVERIFIED_RANGE]` producers serve rows,
 * the foreign leased wrap renders those codes with none, and consumers dispatch on the code.
 */
export function makeTargetLostRejection(opts: {
  servedLine: number;
  path?: string;
  cause: RangeCause;
}): DomainError<"E_TARGET_LOST"> {
  return new DomainError("E_TARGET_LOST", {
    servedLine: opts.servedLine,
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    cause: opts.cause,
    // WHY: the retired line is the offending line — preserved so `verify()` and
    // WHY: downstream consumers keep the coordinate without a second lookup.
    firstOffendingLine: opts.servedLine,
  });
}

/**
 * Builds a `ServedRejectionError` whose rows are the current on-disk range. Both `E_STALE_RANGE`
 * and `E_UNVERIFIED_RANGE` serve under `Current range (fresh read):` with no retry hint and no
 * mandate — the model decides from those rows. `E_TARGET_LOST` never routes here (see
 * `makeTargetLostRejection`).
 */
export function makeServedRejection(opts: {
  code: "E_STALE_RANGE" | "E_UNVERIFIED_RANGE";
  headline: string;
  startLine: number;
  endLine: number;
  snapshot: FileSnapshotContext;
  firstOffendingLine?: number;
  cause: RangeCause;
}): DomainError<"E_STALE_RANGE" | "E_UNVERIFIED_RANGE"> {
  if (opts.code === "E_UNVERIFIED_RANGE") {
    // WHY: the unverified payload renders the general headline, never the
    // WHY: caller-supplied clause: the bound is unplaceable, so naming
    // WHY: per-anchor positions would narrate lines never targeted.
    const { servedRows, rendered } = buildRangeServeBlock(
      opts.startLine,
      opts.endLine,
      opts.snapshot.fileHashes,
      opts.snapshot.fileLines,
    );
    return new DomainError("E_UNVERIFIED_RANGE", {
      servedRows,
      servedBlock: rendered,
      cause: opts.cause,
      ...(opts.firstOffendingLine !== undefined
        ? { firstOffendingLine: opts.firstOffendingLine }
        : {}),
    });
  }
  const { servedRows, servedBlock } = assembleRejectAndServe({
    startLine: opts.startLine,
    endLine: opts.endLine,
    snapshot: opts.snapshot,
  });
  return new DomainError("E_STALE_RANGE", {
    headline: opts.headline,
    servedRows,
    servedBlock,
    cause: opts.cause,
    ...(opts.firstOffendingLine !== undefined
      ? { firstOffendingLine: opts.firstOffendingLine }
      : {}),
  });
}

/**
 * Builds the `[E_STALE_ANCHOR]` reject-and-serve rejection for a boundary anchor the session holds
 * no lease for. It serves the rows under `Current range:` with the retry hint (spec §5.3): the
 * served rows are themselves serves, so the retry needs no `read`. Distinct from the range-family
 * codes, which serve a fresh read with no mandate (issue #149).
 */
export function makeStaleAnchorRejection(opts: {
  headline: string;
  startLine: number;
  endLine: number;
  snapshot: FileSnapshotContext;
  cause: RangeCause;
}): DomainError<"E_STALE_ANCHOR"> {
  const { servedRows, servedBlock } = assembleRejectAndServe({
    startLine: opts.startLine,
    endLine: opts.endLine,
    snapshot: opts.snapshot,
  });
  return new DomainError("E_STALE_ANCHOR", {
    headline: opts.headline,
    servedRows,
    servedBlock,
    cause: opts.cause,
  });
}

/**
 * Contiguity + identity gate for every leased span (spec §3.1.1 / §3.5 / Probe J). The caller resolved
 * each end anchor's leased `line_id`; this verifies the whole served window remapped onto
 * `rebasedStart..rebasedEnd` — the dynamic rebase path's rigid remap, and the fast path's identity
 * remap (`rebasedStart === servedStart ∧ rebasedEnd === servedEnd`), which is why both paths reach
 * the same verdicts (#151):
 *
 *  - a different window length means an external insert/delete landed strictly inside the range
 *    (Probe J) -> `E_STALE_RANGE`;
 *  - a served line whose mirror row was truncated away, or an anchor holding no lease -> `E_STALE_RANGE`
 *    (the diagnosis separates the two: the served record cannot be reconciled, and no served identity);
 *  - an interior row the mirror never served (`null`) -> **accepted** (ADR-0024): it carries no identity
 *    to verify, and the span's extent is already pinned by the two boundary leases this gate verifies
 *    plus the window-length check above. Only rows `0` and `servedLen - 1` — the anchors the model
 *    named — stay fail-closed on a `null`, because with no served row there is nothing to verify them
 *    against;
 *  - a served line whose lease is retired -> `E_STALE_RANGE` with `details.cause: "retirement"`, and
 *    a live lease whose `line_id` no longer lives at its expected rebased coordinate -> the same code
 *    with `cause: "served-range staleness"` (Probes A/E/K: never apply at a coordinate whose
 *    immutable `line_id` is not the one leased).
 *
 * No canon data is consulted: identity comes from the mirror row's lease, so a same-anchor collision
 * between an old served line and unrelated current content cannot satisfy the gate (issue #151).
 * Identity — not anchor spelling — is authoritative: a surviving line may legitimately present a
 * different (content-derived) anchor in the new snapshot, so a string mismatch is not by itself a
 * failure. Throwing happens before any write, so a rejection leaves the file byte-identical.
 */
export function verifyRebasedSpan(args: {
  served: readonly (string | null)[];
  servedStart: number;
  servedEnd: number;
  rebasedStart: number;
  rebasedEnd: number;
  snapshot: FileSnapshotContext;
  leaseFor(anchor: string): LeaseIdentityView | undefined;
  rebasedLineOf(lineId: number): number | undefined;
}): void {
  const {
    served,
    servedStart,
    servedEnd,
    rebasedStart,
    rebasedEnd,
    snapshot,
    leaseFor,
    rebasedLineOf,
  } = args;
  const where = snapshot.filePath ? ` in ${snapshot.filePath}` : "";
  const servedLen = servedEnd - servedStart + 1;
  const rebasedLen = rebasedEnd - rebasedStart + 1;
  if (rebasedLen !== servedLen) {
    throw makeServedRejection({
      code: "E_STALE_RANGE",
      headline: `served span (${servedLen} lines) no longer matches the rebased range (${rebasedLen} lines)${where}.`,
      startLine: rebasedStart,
      endLine: rebasedEnd,
      snapshot,
      firstOffendingLine: rebasedStart,
      cause: "served-range staleness",
    });
  }
  for (let k = 0; k < servedLen; k++) {
    const servedAnchor = served[servedStart - 1 + k];
    const currentLine = rebasedStart + k;
    // WHY: the served window can come from the leases' own `served_line_number` because a truncated
    // WHY: serve dropped the mirror rows it no longer covers (spec §3.1.1): the lease outlives the
    // WHY: mirror. An absent slot is that missing record, never "this line was never served", so the
    // WHY: span fails closed on the truth (the served record cannot be reconciled) and the current
    // WHY: range is served for a fresh read.
    if (servedAnchor === undefined) {
      throw makeServedRejection({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} has no served mirror row left; the served window was truncated.`,
        startLine: rebasedStart,
        endLine: rebasedEnd,
        snapshot,
        firstOffendingLine: currentLine,
        cause: "served-range staleness",
      });
    }
    if (servedAnchor === null) {
      // WHY: ADR-0024 narrows informed destruction to the boundaries: an unread interior row has no
      // WHY: identity to check, and the two verified boundary leases already fix the span's extent, so
      // WHY: refusing it only taxed a correct edit. A `null` boundary is the named anchor itself —
      // WHY: unverifiable by construction — so it keeps the fail-closed diagnosis.
      if (k === 0 || k === servedLen - 1) {
        throw makeServedRejection({
          code: "E_STALE_RANGE",
          headline: `line ${currentLine}${where} was never served.`,
          startLine: rebasedStart,
          endLine: rebasedEnd,
          snapshot,
          firstOffendingLine: currentLine,
          cause: "never-served",
        });
      }
      continue;
    }
    const lease = leaseFor(servedAnchor);
    if (lease === undefined) {
      throw makeServedRejection({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} has no served line identity.`,
        startLine: rebasedStart,
        endLine: rebasedEnd,
        snapshot,
        firstOffendingLine: currentLine,
        cause: "never-served",
      });
    }
    // WHY: two distinct diagnoses, one per condition (spec §5.3): a terminal lease is a
    // WHY: `retirement` — the identity is gone and only a re-read revives it — while a live lease
    // WHY: whose `line_id` no longer sits at its expected coordinate is drift between the served
    // WHY: record and the rebased span.
    if (lease.retiredAt !== null) {
      throw makeServedRejection({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} no longer resolves to the line identity it was served with.`,
        startLine: rebasedStart,
        endLine: rebasedEnd,
        snapshot,
        firstOffendingLine: currentLine,
        cause: "retirement",
      });
    }
    if (rebasedLineOf(lease.lineId) !== currentLine) {
      throw makeServedRejection({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} no longer resolves to the line identity it was served with.`,
        startLine: rebasedStart,
        endLine: rebasedEnd,
        snapshot,
        firstOffendingLine: currentLine,
        cause: "served-range staleness",
      });
    }
  }
}

// WHY: ---------------------------------------------------------------------------
// WHY: Resolved-range contract (shared with apply/pipeline)
// WHY: ---------------------------------------------------------------------------

export interface ResolvedRange {
  startLine: number;
  endLine: number;
  startHash: string;
  endHash: string;
  delta: number;
}

/**
 * SAFETY: ServedHashEcho — one evidence predicate for the served hash echo condition.
 *
 * WHY: this section lives here (with the serve-row builders) rather than beside the edit path: the
 * WHY: evidence it judges is a served row, so the module that renders served rows also owns the
 * WHY: gates that read them. Callers keep passing every input explicitly (no session handle).
 *
 * CONTEXT.md served hash echo, ADR-0009 revision 2026-09-15: a candidate line
 * triggers only with evidence — it begins (after one optional leading `+`,
 * `-`, or space diff marker) with an anchor served for this session and path
 * at any position, AND the remainder reproduces the served content for that
 * anchor (`canonDigest(remainder) === served_leases.canon_hash`). One
 * such row suffices. No canon data means no evidence, so the candidate stays
 * silent — the tool never gates on the shape of a line.
 */
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

/** Anchor-shape parse derived from `HASH_LEN`/`HASH_RE`: optional diff-marker strip, then the shared width, separator, and class. */
function anchorShapeFromLine(line: string): { anchor: string; tail: string } | undefined {
  let text = line;
  if (text.length > 0 && (text[0] === "+" || text[0] === "-" || text[0] === " ")) {
    text = text.slice(1);
  }
  if (text.length < HASH_LEN + 1) return undefined;
  if (text[HASH_LEN] !== HASH_SEP) return undefined;
  const anchor = text.slice(0, HASH_LEN);
  if (!HASH_RE.test(anchor)) return undefined;
  return { anchor, tail: text.slice(HASH_LEN + 1) };
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
  "with the same `anchor_from`/`anchor_to` and drop the anchor prefix from `text`.";

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
 * (the live anchor width of alphanumerics plus the separator, after one optional leading diff marker)
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
// WHY: `(sessionKey, path)` convention (`createSessionHandle`,
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
