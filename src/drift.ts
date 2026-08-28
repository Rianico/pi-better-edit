import { SERVED_ECHO_CAP } from "./constants.js";
import {
  type ServedRow,
  fmtServedRows,
  type ResolvedRange,
} from "./hashline/served.js";
import {
  currentPositionOfDrifted,
  driftReported,
  markDriftReported,
  recordServedTruncated,
  servedPositionsOf,
} from "./served-state.js";

const DRIFT_NOTICE_HEADING = "drift:";

interface DriftRow extends ServedRow {
  content: string;
  drifted: boolean;
}

export interface ComputeDriftInput {
  served: (string | null)[];
  resultHashes: string[];
  resultLines: string[];
  range: ResolvedRange;
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
  const startPositions = servedPositionsOf(input.served, input.range.startHash);
  const endPositions = servedPositionsOf(input.served, input.range.endHash);
  let servedStartIdx: number;
  let servedEndIdx: number;
  if (startPositions.length === 1 && endPositions.length === 1) {
    servedStartIdx = startPositions[0]!;
    servedEndIdx = endPositions[0]!;
  } else {
    servedStartIdx = input.range.startLine - 1;
    servedEndIdx = input.range.endLine - 1;
  }
  return {
    rangeFrom: Math.min(servedStartIdx, servedEndIdx),
    rangeTo: Math.max(servedStartIdx, servedEndIdx),
  };
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
    const currentPos = currentPositionOfDrifted(
      input.served,
      currentPosOfHash,
      resultHashSet,
      p,
      input.range.delta,
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
  const { rangeFrom, rangeTo } = resolveServedRange(input);
  const {
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
  );
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
  range: ResolvedRange;
  path: string;
}): Promise<string | undefined> {
  const reported = await driftReported(input.sessionKey, input.path);
  const result = computeDrift({ ...input, reported });
  if (!result || result.allAlreadyReported) return result?.text;
  await recordServedTruncated(
    input.sessionKey,
    input.path,
    result.rows.map((row) => ({ position: row.position, hash: row.hash })),
    input.resultLines.length,
  );
  await markDriftReported(
    input.sessionKey,
    input.path,
    result.rows.filter((row) => row.drifted).map((row) => row.hash),
  );
  return result.text;
}
