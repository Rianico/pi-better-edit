import {
	loadHashStore,
	getServed,
	recordServes,
	getReported,
	addReported,
	clearReported,
	wipeServed,
} from "./hash-store";

export type ServedEntry = { position: number; hash: string | null };

export async function loadServed(path: string): Promise<(string | null)[]> {
	const store = await loadHashStore();
	return getServed(store, path);
}

export async function recordServed(path: string, rows: ServedEntry[]): Promise<void> {
	if (rows.length === 0) return;
	try {
		const store = await loadHashStore();
		recordServes(store, path, rows);
	} catch (error) {
		console.error("Failed to record served rows:", error);
	}
}

export async function driftReported(path: string): Promise<Set<string>> {
	try {
		const store = await loadHashStore();
		return getReported(store, path);
	} catch (error) {
		console.error("Failed to load reported drift set:", error);
		return new Set();
	}
}

export async function markDriftReported(path: string, hashes: string[]): Promise<void> {
	try {
		const store = await loadHashStore();
		addReported(store, path, hashes);
	} catch (error) {
		console.error("Failed to record reported drift set:", error);
	}
}

export async function clearDriftReported(path: string): Promise<void> {
	try {
		const store = await loadHashStore();
		clearReported(store, path);
	} catch (error) {
		console.error("Failed to clear reported drift set:", error);
	}
}

export async function wipeServedState(): Promise<void> {
	try {
		const store = await loadHashStore();
		wipeServed(store);
	} catch (error) {
		console.error("Failed to wipe served state:", error);
	}
}

export function servedPositionsOf(
	served: (string | null)[],
	hash: string,
): number[] {
	const out: number[] = [];
	for (let i = 0; i < served.length; i++) {
		if (served[i] === hash) out.push(i);
	}
	return out;
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
	const below = nearestSurvivingPosition(served, surviving, servedIndex, "below");
	if (below !== undefined) return currentPositions.get(served[below]!)! + 1;
	const above = nearestSurvivingPosition(served, surviving, servedIndex, "above");
	if (above !== undefined) return currentPositions.get(served[above]!)! - 1;
	return servedIndex + delta;
}
