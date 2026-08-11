import { SERVED_ECHO_CAP } from "./constants";
import {
	getReported,
	addReported,
	upsertServed,
	type HashStore,
} from "./hash-store";
import { type ServedRow, fmtServedRows } from "./hashline/served";

export const DRIFT_NOTICE_HEADING = "Drift notice:";

export interface DriftRow extends ServedRow {
	content: string;
	drifted: boolean;
}

export interface ComputeDriftInput {
	served: (string | null)[];
	resultHashes: string[];
	resultLines: string[];
	rangeStartLine: number;
	rangeEndLine: number;
	startHash: string;
	endHash: string;
	delta: number;
	reported: Set<string>;
	cap?: number;
}

export interface DriftNoticeResult {
	text: string;
	rows: DriftRow[];
	total: number;
	allAlreadyReported: boolean;
}

export function computeDrift(
	input: ComputeDriftInput,
): DriftNoticeResult | undefined {
	const {
		served,
		resultHashes,
		resultLines,
		rangeStartLine,
		rangeEndLine,
		startHash,
		endHash,
		delta,
		reported,
		cap = SERVED_ECHO_CAP,
	} = input;

	const resultHashSet = new Set(resultHashes);
	const currentPosOfHash = new Map<string, number>();
	for (let i = 0; i < resultHashes.length; i++) {
		currentPosOfHash.set(resultHashes[i]!, i);
	}

	const servedPositionsOf = (hash: string): number[] => {
		const out: number[] = [];
		for (let i = 0; i < served.length; i++) {
			if (served[i] === hash) out.push(i);
		}
		return out;
	};
	const startPositions = servedPositionsOf(startHash);
	const endPositions = servedPositionsOf(endHash);
	let servedStartIdx: number;
	let servedEndIdx: number;
	if (startPositions.length === 1 && endPositions.length === 1) {
		servedStartIdx = startPositions[0]!;
		servedEndIdx = endPositions[0]!;
	} else {
		servedStartIdx = rangeStartLine - 1;
		servedEndIdx = rangeEndLine - 1;
	}
	const rangeFrom = Math.min(servedStartIdx, servedEndIdx);
	const rangeTo = Math.max(servedStartIdx, servedEndIdx);

	let total = 0;
	let unshown = 0;
	let anyNotReported = false;
	const driftedPositions: number[] = [];

	const nearestSurvivingBelow = (p: number): number | undefined => {
		for (let q = p - 1; q >= 0; q--) {
			const hash = served[q];
			if (hash !== null && resultHashSet.has(hash)) return q;
		}
		return undefined;
	};
	const nearestSurvivingAbove = (p: number): number | undefined => {
		for (let q = p + 1; q < served.length; q++) {
			const hash = served[q];
			if (hash !== null && resultHashSet.has(hash)) return q;
		}
		return undefined;
	};

	for (let p = 0; p < served.length; p++) {
		const servedHash = served[p];
		if (servedHash === null) continue;
		if (p >= rangeFrom && p <= rangeTo) continue;
		if (resultHashSet.has(servedHash)) continue;
		total++;
		if (!reported.has(servedHash)) anyNotReported = true;
		const below = nearestSurvivingBelow(p);
		let currentPos: number;
		if (below !== undefined) {
			currentPos = currentPosOfHash.get(served[below]!)! + 1;
		} else {
			const above = nearestSurvivingAbove(p);
			if (above !== undefined) {
				currentPos = currentPosOfHash.get(served[above]!)! - 1;
			} else {
				currentPos = p + delta;
			}
		}
		if (
			currentPos >= 0 &&
			currentPos < resultHashes.length &&
			currentPos < resultLines.length
		) {
			driftedPositions.push(currentPos);
		} else {
			unshown++;
		}
	}

	if (total === 0) return undefined;

	const countLabel = `${total} line(s)`;
	if (!anyNotReported) {
		return {
			text: `${DRIFT_NOTICE_HEADING} ${countLabel} outside the replaced range drifted and were already reported — call read to refresh.`,
			rows: [],
			total,
			allAlreadyReported: true,
		};
	}

	const driftedSet = new Set(driftedPositions);
	const windowSet = new Set<number>();
	for (const pos of driftedPositions) {
		for (const w of [pos - 1, pos, pos + 1]) {
			if (w >= 0 && w < resultLines.length) windowSet.add(w);
		}
	}
	const windowPositions = [...windowSet].sort((a, b) => a - b);
	const shownPositions = windowPositions.slice(0, cap);
	unshown += windowPositions.length - shownPositions.length;

	const rows: DriftRow[] = shownPositions.map((position) => ({
		position,
		hash: resultHashes[position]!,
		content: resultLines[position]!,
		drifted: driftedSet.has(position),
	}));

	const rowsText = fmtServedRows(rows, resultLines);
	const moreText =
		unshown > 0
			? `\n[... ${unshown} more line(s) — call read to see them]`
			: "";
	return {
		text: `${DRIFT_NOTICE_HEADING} ${countLabel} outside the replaced range drifted. Current content around the drift:\n${rowsText}${moreText}`,
		rows,
		total,
		allAlreadyReported: false,
	};
}

export function scanDrift(input: {
	served: (string | null)[];
	resultHashes: string[];
	resultLines: string[];
	rangeStartLine: number;
	rangeEndLine: number;
	startHash: string;
	endHash: string;
	delta: number;
	store: HashStore;
	path: string;
}): string | undefined {
	let reported: Set<string>;
	try {
		reported = getReported(input.store, input.path);
	} catch (error) {
		console.error("Failed to load reported drift set:", error);
		reported = new Set();
	}
	const result = computeDrift({ ...input, reported });
	if (!result || result.allAlreadyReported) return result?.text;
	try {
		upsertServed(
			input.store,
			input.path,
			result.rows.map((row) => ({ position: row.position, hash: row.hash })),
		);
		addReported(
			input.store,
			input.path,
			result.rows.filter((row) => row.drifted).map((row) => row.hash),
		);
	} catch (error) {
		console.error("Failed to record drift-notice serves:", error);
	}
	return result.text;
}
