import { SERVED_ECHO_CAP } from "./constants.js";
import {
  type ServedRow,
  fmtServedRows,
  type ResolvedRange,
} from "./hashline/served.js";
import { servedPositionsOf } from "./hashline/served.js";
import { currentPositionOfDrifted } from "./served-session/drift-helpers.js";
import { createSessionHandle } from "./served-session/session.js";

const DRIFT_NOTICE_HEADING = "drift:";

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
  reported: Set<string>;
  cap?: number;
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
    throw new Error("[E_BAD_SHAPE] computeDrift requires range or intervals");
  const startPositions = servedPositionsOf(input.served, range.startHash);
  const endPositions = servedPositionsOf(input.served, range.endHash);
  let servedStartIdx: number;
  let servedEndIdx: number;
  if (startPositions.length === 1 && endPositions.length === 1) {
    servedStartIdx = startPositions[0]!;
    servedEndIdx = endPositions[0]!;
  } else {
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
    const startPositions = servedPositionsOf(input.served, r.startHash);
    const endPositions = servedPositionsOf(input.served, r.endHash);
    let s: number;
    let e: number;
    if (startPositions.length === 1 && endPositions.length === 1) {
      s = startPositions[0]!;
      e = endPositions[0]!;
    } else {
      s = r.startLine - 1;
      e = r.endLine - 1;
    }
    return { from: Math.min(s, e), to: Math.max(s, e), delta: r.delta };
  });
}

function isInIntervals(
  p: number,
  ranges: Array<{ from: number; to: number }>,
): boolean {
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
function collectDrifted(
  input: ComputeDriftInput,
  resultHashSet: Set<string>,
  currentPosOfHash: Map<string, number>,
  rangeFrom: number,
  rangeTo: number,
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
    total++;
    if (!input.reported.has(servedHash)) anyNotReported = true;
    const delta = input.range?.delta ?? 0;
    const currentPos = currentPositionOfDrifted(
      input.served,
      currentPosOfHash,
      resultHashSet,
      p,
      delta,
    );
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
    total++;
    if (!input.reported.has(servedHash)) anyNotReported = true;
    const delta = deltaBefore(p, intervals);
    const currentPos = currentPositionOfDrifted(
      input.served,
      currentPosOfHash,
      resultHashSet,
      p,
      delta,
    );
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
export function computeDrift(
  input: ComputeDriftInput,
): DriftNoticeResult | undefined {
  const cap = input.cap ?? SERVED_ECHO_CAP;
  const resultHashSet = new Set(input.resultHashes);
  const currentPosOfHash = buildCurrentPosMap(input.resultHashes);
  const intervals = resolveIntervals(input);
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
  const moreText =
    unshown > 0 ? `\n[... ${unshown} more — re-read to see]` : "";
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
  range?: ResolvedRange;
  intervals?: ResolvedRange[];
  path: string;
}): Promise<string | undefined> {
  const handle = createSessionHandle(input.sessionKey, input.path);
  const reported = await handle.driftReported();
  const driftInput: ComputeDriftInput = {
    served: input.served,
    resultHashes: input.resultHashes,
    resultLines: input.resultLines,
    reported,
    ...(input.intervals ? { intervals: input.intervals } : {}),
    ...(input.range ? { range: input.range } : {}),
  };
  const result = computeDrift(driftInput);
  if (!result || result.allAlreadyReported) return result?.text;
  await handle.recordTruncated(
    result.rows.map((row) => ({ position: row.position, hash: row.hash })),
    input.resultLines.length,
  );
  await handle.markDriftReported(
    result.rows.filter((row) => row.drifted).map((row) => row.hash),
  );
  return result.text;
}
