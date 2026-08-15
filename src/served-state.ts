import { recordServed, recordServedTruncated } from "./served-store";
import type { ServedRow } from "./hashline/served";

export {
	type ServedEntry,
	loadServed,
	recordServed,
	recordServedTruncated,
	driftReported,
	markDriftReported,
	clearDriftReported,
	wipeServedState,
	sessionKeyFor,
} from "./served-store";

export { servedPositionsOf } from "./hashline/served";

export type ServeRecordPolicy = "live" | "preview";

export async function recordEchoServes(
	sessionKey: string,
	path: string,
	rows: ServedRow[],
	policy: ServeRecordPolicy,
): Promise<void> {
	if (policy !== "live") return;
	await recordServed(sessionKey, path, rows);
}

export type ServeRecordingPlan =
	| { mode: "plain" }
	| { mode: "truncated"; lineCount: number; clearFrom: number };

export function planServeRecording(input: {
	resultLineCount?: number;
	firstChangedLine?: number;
}): ServeRecordingPlan {
	if (typeof input.resultLineCount !== "number") {
		return { mode: "plain" };
	}
	return {
		mode: "truncated",
		lineCount: input.resultLineCount,
		clearFrom:
			input.firstChangedLine !== undefined ? input.firstChangedLine - 1 : 0,
	};
}

export async function recordDiffServes(input: {
	sessionKey: string;
	path: string;
	servedRows: ServedRow[];
	resultLineCount?: number;
	firstChangedLine?: number;
}): Promise<void> {
	if (input.servedRows.length === 0) return;
	const plan = planServeRecording(input);
	if (plan.mode === "plain") {
		await recordServed(input.sessionKey, input.path, input.servedRows);
		return;
	}
	await recordServedTruncated(
		input.sessionKey,
		input.path,
		input.servedRows,
		plan.lineCount,
		plan.clearFrom,
	);
}

function nearestSurvivingPosition(
	served: (string | null)[],
	surviving: Set<string>,
	from: number,
	direction: "below" | "above",
): number | undefined {
	if (direction === "below") {
		for (let q = from - 1; q >= 0; q--) {
			const hash = served[q];
			if (hash !== null && surviving.has(hash)) return q;
		}
		return undefined;
	}
	for (let q = from + 1; q < served.length; q++) {
		const hash = served[q];
		if (hash !== null && surviving.has(hash)) return q;
	}
	return undefined;
}

export function currentPositionOfDrifted(
	served: (string | null)[],
	currentPositions: Map<string, number>,
	surviving: Set<string>,
	servedIndex: number,
	delta: number,
): number {
	const below = nearestSurvivingPosition(
		served,
		surviving,
		servedIndex,
		"below",
	);
	if (below !== undefined) return currentPositions.get(served[below]!)! + 1;
	const above = nearestSurvivingPosition(
		served,
		surviving,
		servedIndex,
		"above",
	);
	if (above !== undefined) return currentPositions.get(served[above]!)! - 1;
	return servedIndex + delta;
}
