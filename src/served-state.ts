import { recordServed } from "./served-store";
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
