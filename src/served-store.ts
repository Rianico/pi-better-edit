import { HASH_RE } from "./hashline/alphabet";
import { loadHashStore, withStore, type HashStore } from "./hash-store";

export type ServedEntry = { position: number; hash: string | null };

function isValidServedList(value: unknown): value is (string | null)[] {
	if (!Array.isArray(value)) return false;
	for (const entry of value) {
		if (entry === null) continue;
		if (typeof entry !== "string" || !HASH_RE.test(entry)) return false;
	}
	return true;
}

export function getServed(store: HashStore, path: string): (string | null)[] {
	const row = store.stmts.servedGet(path);
	if (!row) return [];
	try {
		const parsed = JSON.parse(row.hashes as string);
		if (isValidServedList(parsed)) return parsed;
		store.stmts.servedDelete(path);
		return [];
	} catch {
		store.stmts.servedDelete(path);
		return [];
	}
}

export function upsertServed(
	store: HashStore,
	path: string,
	entries: Array<{ position: number; hash: string | null }>,
): void {
	if (entries.length === 0) return;
	withStore(() => {
		const updated = getServed(store, path).slice();
		for (const entry of entries) {
			if (!Number.isInteger(entry.position) || entry.position < 0) {
				throw new TypeError(`Invalid served position: ${entry.position}`);
			}
			if (
				entry.hash !== null &&
				(typeof entry.hash !== "string" || !HASH_RE.test(entry.hash))
			) {
				throw new TypeError(`Invalid served hash: ${String(entry.hash)}`);
			}
			while (updated.length <= entry.position) updated.push(null);
			updated[entry.position] = entry.hash;
		}
		while (updated.length > 0 && updated[updated.length - 1] === null)
			updated.pop();
		store.stmts.servedUpsert(path, JSON.stringify(updated), Date.now());
	});
}

export function recordServes(
	store: HashStore,
	path: string,
	rows: Array<{ position: number; hash: string | null }>,
): void {
	if (rows.length === 0) return;
	try {
		upsertServed(store, path, rows);
	} catch (error) {
		console.error("Failed to record served rows:", error);
	}
}

export function getReported(store: HashStore, path: string): Set<string> {
	const row = store.stmts.servedGet(path);
	if (!row) return new Set();
	const raw = row.reported;
	if (typeof raw !== "string" || raw.length === 0) return new Set();
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return new Set();
		return new Set(
			parsed.filter(
				(h): h is string => typeof h === "string" && HASH_RE.test(h),
			),
		);
	} catch {
		return new Set();
	}
}

export function addReported(
	store: HashStore,
	path: string,
	hashes: string[],
): void {
	const valid = hashes.filter((hash) => HASH_RE.test(hash));
	if (valid.length === 0) return;
	withStore(() => {
		const current = getReported(store, path);
		for (const hash of valid) current.add(hash);
		store.stmts.servedReportedUpsert(
			path,
			JSON.stringify([...current]),
			Date.now(),
		);
	});
}

export function clearReported(store: HashStore, path: string): void {
	withStore(() => {
		store.stmts.servedReportedClear(Date.now(), path);
	});
}

export function deleteServed(store: HashStore, path: string): void {
	store.stmts.servedDelete(path);
}

export function wipeServed(store: HashStore): void {
	store.stmts.servedWipe();
}

export async function loadServed(path: string): Promise<(string | null)[]> {
	const store = await loadHashStore();
	return getServed(store, path);
}

export async function recordServed(
	path: string,
	rows: ServedEntry[],
): Promise<void> {
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

export async function markDriftReported(
	path: string,
	hashes: string[],
): Promise<void> {
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
