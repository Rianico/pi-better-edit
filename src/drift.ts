import { SERVED_ROWS_CAP } from "./constants.js";
import { DomainError } from "./domain-errors.js";
import { type ServedRow, fmtServedRows, type ResolvedRange } from "./hashline/served.js";
import { servedPositionsOf } from "./hashline/served.js";
import { canonDigest } from "./hashline/hash-identity.js";
import { ALPHA, HASH_LEN } from "./hashline/alphabet.js";
import { currentPositionOfDrifted } from "./served-session/drift-helpers.js";
import { createSessionHandle } from "./served-session/session.js";
const DRIFT_NOTICE_HEADING = "[USER] drift:";

/**
 * WHY (CAND-9, ADR-0023): the drift-notice episode identity is the drifted line's rebased
 * position in the CURRENT file — not its anchor string. An anchor is a spelling, not an
 * identity: one reported entry for a hash shared by two distinct lines silenced both
 * (duplicate-hash collapse), and a lease rotation renamed the mirror anchor of an
 * already-reported line, spuriously re-noticing it. The session's reported-set keeps storing
 * strings (schema unchanged); this base-62 encoding of the position at the configured width is the KEY VALUE.
 * Positions are bounded by `MAX_HASH_LINES` (= |ALPHA|^HASH_LEN, files larger cannot be
 * hashed), so the encoding is injective over every reachable position. An out-of-file
 * position (never shown, never marked) keys on "" — not a valid stored entry, always
 * "not yet reported", matching the legacy behavior for unshown drift.
 */
export function driftEpisodeKey(position: number): string {
  const space = ALPHA.length ** HASH_LEN;
  if (!Number.isInteger(position) || position < 0 || position >= space) return "";
  let idx = position;
  let out = "";
  for (let j = 0; j < HASH_LEN; j++) {
    out = ALPHA[idx % ALPHA.length]! + out;
    idx = Math.floor(idx / ALPHA.length);
  }
  return out;
}

interface DriftRow extends ServedRow {
  content: string;
  drifted: boolean;
}

export interface ComputeDriftInput {
  served: (string | null)[];
  resultHashes: string[];
  resultLines: string[];
  range?: ResolvedRange;
  intervals?: ResolvedRange[];
  /** Episode keys (`driftEpisodeKey`) of already-reported drifted lines — see CAND-9 WHY above. */
  reported: Set<string>;
  cap?: number;
  /** WHY: canon digests parallel to `served`, derived from the served rows' leases.
   * Absent/empty preserves legacy hash-equality (existing tests, old DBs). */
  servedCanonDigests?: (string | null)[];
}

export interface DriftNoticeResult {
  text: string;
  rows: DriftRow[];
  total: number;
  allAlreadyReported: boolean;
}

function buildCurrentPosMap(resultHashes: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < resultHashes.length; i++) m.set(resultHashes[i]!, i);
  return m;
}
function resolveServedRange(input: ComputeDriftInput): {
  rangeFrom: number;
  rangeTo: number;
} {
  const range = input.range;
  if (!range)
    throw new DomainError("E_BAD_PAYLOAD", {
      message: "computeDrift requires range or intervals",
    });
  const startPositions = servedPositionsOf(input.served, range.startHash);
  const endPositions = servedPositionsOf(input.served, range.endHash);
  let servedStartIdx: number;
  let servedEndIdx: number;
  if (startPositions.length === 1 && endPositions.length === 1) {
    servedStartIdx = startPositions[0]!;
    servedEndIdx = endPositions[0]!;
  } else {
    // WHY: ADR-0023 position-fallback — an anchor is a spelling, not an identity. When the
    // WHY: served hash names zero or several mirror positions there is no unambiguous
    // WHY: anchor lookup, so the window degrades to the line-number coordinates the range
    // WHY: carries — a judgment aid, not an identity claim; drift inside the window is
    // WHY: excluded, drift near a mis-located boundary may over- or under-report lines.
    servedStartIdx = range.startLine - 1;
    servedEndIdx = range.endLine - 1;
  }
  return {
    rangeFrom: Math.min(servedStartIdx, servedEndIdx),
    rangeTo: Math.max(servedStartIdx, servedEndIdx),
  };
}

function resolveIntervals(
  input: ComputeDriftInput,
): Array<{ from: number; to: number; delta: number }> {
  const intervals = input.intervals;
  if (!intervals || intervals.length === 0) {
    const { rangeFrom, rangeTo } = resolveServedRange(input);
    return [{ from: rangeFrom, to: rangeTo, delta: input.range!.delta }];
  }
  return intervals.map((r) => {
    if (r.startLine > r.endLine) {
      // WHY: zero-width insertion interval (ticket-01): it edits no served line, so the interval
      // WHY: stays empty (`from > to` is never matched by `isInIntervals`) instead of degrading to
      // WHY: a width-1 window that would mask the untouched neighbour lines. `deltaBefore` still
      // WHY: shifts every served line after the insertion point by the inserted line count.
      return { from: r.startLine - 1, to: r.endLine - 1, delta: r.delta };
    }
    const startPositions = servedPositionsOf(input.served, r.startHash);
    const endPositions = servedPositionsOf(input.served, r.endHash);
    let s: number;
    let e: number;
    if (startPositions.length === 1 && endPositions.length === 1) {
      s = startPositions[0]!;
      e = endPositions[0]!;
    } else {
      // WHY: ADR-0023 position-fallback — same degradation as `resolveServedRange`: an
      // WHY: ambiguous (0 or >1 hits) anchor is a spelling, not an identity, so the interval
      // WHY: falls back to the range's line-number coordinates.
      s = r.startLine - 1;
      e = r.endLine - 1;
    }
    return { from: Math.min(s, e), to: Math.max(s, e), delta: r.delta };
  });
}

function isInIntervals(p: number, ranges: Array<{ from: number; to: number }>): boolean {
  for (const r of ranges) if (p >= r.from && p <= r.to) return true;
  return false;
}

function deltaBefore(
  p: number,
  ranges: Array<{ from: number; to: number; delta: number }>,
): number {
  let d = 0;
  for (const r of ranges) if (r.to < p) d += r.delta;
  return d;
}

type RotatedSurvivorCheck = (servedHash: string, servedPos: number) => boolean;

/** WHY: edited served intervals mapped to current-file spans (result coordinates). */
function currentEditedSpans(
  intervals: Array<{ from: number; to: number; delta: number }>,
): Array<{ from: number; to: number }> {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  let shift = 0;
  const spans: Array<{ from: number; to: number }> = [];
  for (const r of sorted) {
    const start = r.from + shift;
    const end = r.to + shift + r.delta;
    if (end >= start) spans.push({ from: start, to: end });
    shift += r.delta;
  }
  return spans;
}

function isInSpans(p: number, spans: Array<{ from: number; to: number }>): boolean {
  for (const s of spans) if (p >= s.from && p <= s.to) return true;
  return false;
}

/**
 * WHY: #68 hash-rotation vs content loss. Probing + blocked-hashes growth reassign
 * distinct hashes to identical duplicate lines across sequential edits, so a
 * served hash missing from the result set may still survive under a fresh hash.
 * Suppress those (consume one matching canon digest outside the edited spans); report
 * only canon deficit. Absent/empty `servedCanonDigests` keeps legacy hash-equality.
 */
function buildRotatedSurvivorCheck(
  input: ComputeDriftInput,
  intervals: Array<{ from: number; to: number; delta: number }>,
): RotatedSurvivorCheck {
  const digests = input.servedCanonDigests;
  if (!digests || !digests.some((c) => c !== null)) return () => false;
  const spans = currentEditedSpans(intervals);
  const remaining = new Map<string, number>();
  for (let i = 0; i < input.resultLines.length; i++) {
    if (isInSpans(i, spans)) continue;
    const c = canonDigest(input.resultLines[i] ?? "");
    remaining.set(c, (remaining.get(c) ?? 0) + 1);
  }
  return (_servedHash, servedPos) => {
    // WHY: only the file-scoped canon digest the lease recorded at the served position counts. A
    // WHY: hash->canon fallback is file-blind and an anchor collision would silently suppress real
    // WHY: drift (#149); the digest is derived, never persisted (#151).
    const c = digests[servedPos] ?? null;
    if (c === null) return false;
    const left = remaining.get(c) ?? 0;
    if (left <= 0) return false;
    remaining.set(c, left - 1);
    return true;
  };
}

function collectDrifted(
  input: ComputeDriftInput,
  resultHashSet: Set<string>,
  currentPosOfHash: Map<string, number>,
  rangeFrom: number,
  rangeTo: number,
  isRotatedSurvivor: RotatedSurvivorCheck,
): {
  total: number;
  unshown: number;
  anyNotReported: boolean;
  driftedPositions: number[];
} {
  let total = 0;
  let unshown = 0;
  let anyNotReported = false;
  const driftedPositions: number[] = [];
  for (let p = 0; p < input.served.length; p++) {
    const servedHash = input.served[p];
    if (servedHash === null) continue;
    if (p >= rangeFrom && p <= rangeTo) continue;
    if (resultHashSet.has(servedHash)) continue;
    if (isRotatedSurvivor(servedHash, p)) continue;
    total++;
    const delta = input.range?.delta ?? 0;
    const currentPos = currentPositionOfDrifted(
      input.served,
      currentPosOfHash,
      resultHashSet,
      p,
      delta,
    );
    if (!input.reported.has(driftEpisodeKey(currentPos))) anyNotReported = true;
    if (
      currentPos >= 0 &&
      currentPos < input.resultHashes.length &&
      currentPos < input.resultLines.length
    )
      driftedPositions.push(currentPos);
    else unshown++;
  }
  return { total, unshown, anyNotReported, driftedPositions };
}

function collectDriftedIntervals(
  input: ComputeDriftInput,
  resultHashSet: Set<string>,
  currentPosOfHash: Map<string, number>,
  intervals: Array<{ from: number; to: number; delta: number }>,
  isRotatedSurvivor: RotatedSurvivorCheck,
): {
  total: number;
  unshown: number;
  anyNotReported: boolean;
  driftedPositions: number[];
} {
  let total = 0;
  let unshown = 0;
  let anyNotReported = false;
  const driftedPositions: number[] = [];
  for (let p = 0; p < input.served.length; p++) {
    const servedHash = input.served[p];
    if (servedHash === null) continue;
    if (isInIntervals(p, intervals)) continue;
    if (resultHashSet.has(servedHash)) continue;
    if (isRotatedSurvivor(servedHash, p)) continue;
    total++;
    const delta = deltaBefore(p, intervals);
    const currentPos = currentPositionOfDrifted(
      input.served,
      currentPosOfHash,
      resultHashSet,
      p,
      delta,
    );
    if (!input.reported.has(driftEpisodeKey(currentPos))) anyNotReported = true;
    if (
      currentPos >= 0 &&
      currentPos < input.resultHashes.length &&
      currentPos < input.resultLines.length
    )
      driftedPositions.push(currentPos);
    else unshown++;
  }
  return { total, unshown, anyNotReported, driftedPositions };
}
export function computeDrift(input: ComputeDriftInput): DriftNoticeResult | undefined {
  const cap = input.cap ?? SERVED_ROWS_CAP;
  const resultHashSet = new Set(input.resultHashes);
  const currentPosOfHash = buildCurrentPosMap(input.resultHashes);
  const intervals = resolveIntervals(input);
  const isRotatedSurvivor = buildRotatedSurvivorCheck(input, intervals);
  const useIntervals = Boolean(input.intervals && input.intervals.length > 0);
  let total: number;
  let initialUnshown: number;
  let anyNotReported: boolean;
  let driftedPositions: number[];
  if (useIntervals) {
    ({
      total,
      unshown: initialUnshown,
      anyNotReported,
      driftedPositions,
    } = collectDriftedIntervals(
      input,
      resultHashSet,
      currentPosOfHash,
      intervals,
      isRotatedSurvivor,
    ));
  } else {
    const { rangeFrom, rangeTo } = resolveServedRange(input);
    ({
      total,
      unshown: initialUnshown,
      anyNotReported,
      driftedPositions,
    } = collectDrifted(
      input,
      resultHashSet,
      currentPosOfHash,
      rangeFrom,
      rangeTo,
      isRotatedSurvivor,
    ));
  }
  if (total === 0) return undefined;
  const countLabel = `${total} line(s)`;
  if (!anyNotReported) {
    return {
      text: `${DRIFT_NOTICE_HEADING} ${countLabel} changed outside the range (already reported) — re-read to refresh.`,
      rows: [],
      total,
      allAlreadyReported: true,
    };
  }
  let unshown = initialUnshown;
  const driftedSet = new Set(driftedPositions);
  const windowSet = new Set<number>();
  for (const pos of driftedPositions)
    for (const w of [pos - 1, pos, pos + 1])
      if (w >= 0 && w < input.resultLines.length) windowSet.add(w);
  const windowPositions = [...windowSet].sort((a, b) => a - b);
  const shownPositions = windowPositions.slice(0, cap);
  unshown += windowPositions.length - shownPositions.length;
  const rows: DriftRow[] = shownPositions.map((position) => ({
    position,
    hash: input.resultHashes[position]!,
    content: input.resultLines[position]!,
    drifted: driftedSet.has(position),
  }));
  const rowsText = fmtServedRows(rows, input.resultLines);
  const moreText = unshown > 0 ? `\n[... ${unshown} more — re-read to see]` : "";
  return {
    text: `${DRIFT_NOTICE_HEADING} ${countLabel} changed outside the range:\n${rowsText}${moreText}`,
    rows,
    total,
    allAlreadyReported: false,
  };
}

export async function scanDrift(input: {
  sessionKey: string;
  served: (string | null)[];
  resultHashes: string[];
  resultLines: string[];
  /** Committed `file_snapshots.snapshot_hash` of the served result; binds the re-served leases. */
  contentHash: string;
  range?: ResolvedRange;
  intervals?: ResolvedRange[];
  path: string;
}): Promise<string | undefined> {
  const handle = createSessionHandle(input.sessionKey, input.path);
  const reported = await handle.driftReported();
  const servedCanonDigests = await handle.loadCanonDigests().catch(() => [] as (string | null)[]);
  const driftInput: ComputeDriftInput = {
    served: input.served,
    resultHashes: input.resultHashes,
    resultLines: input.resultLines,
    reported,
    ...(servedCanonDigests.length > 0 ? { servedCanonDigests } : {}),
    ...(input.intervals ? { intervals: input.intervals } : {}),
    ...(input.range ? { range: input.range } : {}),
  };
  const result = computeDrift(driftInput);
  if (!result || result.allAlreadyReported) return result?.text;
  await handle.recordTruncated(
    result.rows.map((row) => ({ position: row.position, hash: row.hash })),
    input.resultLines.length,
    undefined,
    input.contentHash,
  );
  // WHY: CAND-9 — the episode key is the drifted row's rebased position, not its anchor hash
  // WHY: (see `driftEpisodeKey`). The handle keeps its string[] storage contract unchanged.
  await handle.markDriftReported(
    result.rows.filter((row) => row.drifted).map((row) => driftEpisodeKey(row.position)),
  );
  return result.text;
}
