import { HASH_SEP } from "./hashline";
import { SERVED_ECHO_CAP } from "./constants";
import {
	getReported,
	addReported,
	upsertServed,
	type HashStore,
} from "./hash-store";

export const DRIFT_NOTICE_HEADING = "Drift notice:";

export interface DriftRow {
	position: number;
	hash: string;
	content: string;
}

export interface ComputeDriftInput {
	served: (string | null)[];
	resultHashes: string[];
	resultLines: string[];
	rangeStartLine: number;
	rangeEndLine: number;
	delta: number;
	reported: Set<string>;
	cap?: number;
}

export interface DriftNoticeResult {
	text: string;
	rows: DriftRow[];
	total: number;
	pointer: boolean;
}

export function computeDrift(input: ComputeDriftInput): DriftNoticeResult | undefined {
	const {
		served,
		resultHashes,
		resultLines,
		rangeStartLine,
		rangeEndLine,
		delta,
		reported,
		cap = SERVED_ECHO_CAP,
	} = input;
	const startIdx = rangeStartLine - 1;
	const endIdx = rangeEndLine - 1;
	const rows: DriftRow[] = [];
	let total = 0;
	let unshown = 0;
	let anyNotReported = false;

	for (let p = 0; p < served.length; p++) {
		const servedHash = served[p];
		if (servedHash === null) continue;
		if (p >= startIdx && p <= endIdx) continue;
		const postPos = p < startIdx ? p : p + delta;
		const currentHash =
			postPos >= 0 && postPos < resultHashes.length
				? resultHashes[postPos]
				: undefined;
		if (currentHash !== undefined && currentHash === servedHash) continue;
		total++;
		if (!reported.has(servedHash)) anyNotReported = true;
		if (
			currentHash !== undefined &&
			postPos >= 0 &&
			postPos < resultLines.length
		) {
			if (rows.length < cap) {
				rows.push({
					position: postPos,
					hash: currentHash,
					content: resultLines[postPos]!,
				});
			} else {
				unshown++;
			}
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
			pointer: true,
		};
	}

	const rowsText = rows
		.map((row) => `${row.hash}${HASH_SEP}${row.content}`)
		.join("\n");
	const moreText =
		unshown > 0
			? `\n[... ${unshown} more drifted line(s) — call read to see them]`
			: "";
	return {
		text: `${DRIFT_NOTICE_HEADING} ${countLabel} outside the replaced range drifted. Current content:\n${rowsText}${moreText}`,
		rows,
		total,
		pointer: false,
	};
}

export function scanDrift(input: {
	served: (string | null)[];
	resultHashes: string[];
	resultLines: string[];
	rangeStartLine: number;
	rangeEndLine: number;
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
	if (!result || result.pointer) return result?.text;
	try {
		upsertServed(
			input.store,
			input.path,
			result.rows.map((row) => ({ position: row.position, hash: row.hash })),
		);
		addReported(
			input.store,
			input.path,
			result.rows.map((row) => row.hash),
		);
	} catch (error) {
		console.error("Failed to record drift-notice serves:", error);
	}
	return result.text;
}
