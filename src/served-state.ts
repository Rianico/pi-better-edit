import { randomUUID } from "crypto";
import { DatabaseSync } from "node:sqlite";
import { HASH_RE } from "./hashline/alphabet";
import { SERVED_TTL_MS } from "./constants";
import {
	loadHashStore,
	onStoreOpen,
	withStore,
	withBusyRetry,
	type HashStore,
} from "./hash-store";
import type { ServedRow } from "./hashline/served";

export type ServedEntry = { position: number; hash: string | null };

let fallbackSessionKey: string | undefined;

export function sessionKeyFor(ctx?: {
	sessionManager?: { getSessionId(): string };
}): string {
	const fromSession = ctx?.sessionManager?.getSessionId();
	if (fromSession) return fromSession;
	fallbackSessionKey ??= randomUUID();
	return fallbackSessionKey;
}

export interface ServedStmts {
	servedGet: (
		sessionKey: string,
		path: string,
	) => Record<string, unknown> | undefined;
	servedUpsert: (
		sessionKey: string,
		path: string,
		hashes: string,
		updatedAt: number,
	) => void;
	servedReportedUpsert: (
		sessionKey: string,
		path: string,
		reported: string,
		updatedAt: number,
	) => void;
	servedReportedClear: (
		sessionKey: string,
		updatedAt: number,
		path: string,
	) => void;
	servedDelete: (sessionKey: string, path: string) => void;
	servedDeletePath: (path: string) => void;
	servedWipe: (sessionKey: string) => void;
	servedPruneOlderThan: (updatedBefore: number) => void;
}

const stmtsCache = new WeakMap<DatabaseSync, ServedStmts>();

export function servedStmts(db: DatabaseSync): ServedStmts {
	let stmts = stmtsCache.get(db);
	if (stmts) return stmts;
	stmts = buildStmts(db);
	stmtsCache.set(db, stmts);
	return stmts;
}

function buildStmts(db: DatabaseSync): ServedStmts {
	const servedGetStmt = db.prepare(
		"SELECT hashes, reported FROM served WHERE session_id = ? AND path = ?",
	);
	const servedUpsertStmt = db.prepare(
		"INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?, ?, ?, ?) " +
			"ON CONFLICT(session_id, path) DO UPDATE SET hashes = excluded.hashes, updated_at = excluded.updated_at",
	);
	const servedReportedUpsertStmt = db.prepare(
		"INSERT INTO served (session_id, path, hashes, reported, updated_at) VALUES (?, ?, '[]', ?, ?) " +
			"ON CONFLICT(session_id, path) DO UPDATE SET reported = excluded.reported, updated_at = excluded.updated_at",
	);
	const servedReportedClearStmt = db.prepare(
		"UPDATE served SET reported = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
	);
	const servedDeleteStmt = db.prepare(
		"DELETE FROM served WHERE session_id = ? AND path = ?",
	);
	const servedDeletePathStmt = db.prepare("DELETE FROM served WHERE path = ?");
	const servedWipeStmt = db.prepare("DELETE FROM served WHERE session_id = ?");
	const servedPruneOlderThanStmt = db.prepare(
		"DELETE FROM served WHERE updated_at < ?",
	);
	return {
		servedGet: (...params) =>
			servedGetStmt.get(...params) as Record<string, unknown> | undefined,
		servedUpsert: (sessionKey, path, hashes, updatedAt) => {
			withBusyRetry(() => {
				servedUpsertStmt.run(sessionKey, path, hashes, updatedAt);
			});
		},
		servedReportedUpsert: (sessionKey, path, reported, updatedAt) => {
			withBusyRetry(() => {
				servedReportedUpsertStmt.run(sessionKey, path, reported, updatedAt);
			});
		},
		servedReportedClear: (sessionKey, updatedAt, path) => {
			withBusyRetry(() => {
				servedReportedClearStmt.run(updatedAt, sessionKey, path);
			});
		},
		servedDelete: (sessionKey, path) => {
			withBusyRetry(() => {
				servedDeleteStmt.run(sessionKey, path);
			});
		},
		servedDeletePath: (path) => {
			withBusyRetry(() => {
				servedDeletePathStmt.run(path);
			});
		},
		servedWipe: (sessionKey) => {
			withBusyRetry(() => {
				servedWipeStmt.run(sessionKey);
			});
		},
		servedPruneOlderThan: (updatedBefore) => {
			withBusyRetry(() => {
				servedPruneOlderThanStmt.run(updatedBefore);
			});
		},
	};
}

onStoreOpen((db) => {
	servedStmts(db).servedPruneOlderThan(Date.now() - SERVED_TTL_MS);
});

function isValidServedList(value: unknown): value is (string | null)[] {
	if (!Array.isArray(value)) return false;
	for (const entry of value) {
		if (entry === null) continue;
		if (typeof entry !== "string" || !HASH_RE.test(entry)) return false;
	}
	return true;
}

function patchServed(
	updated: (string | null)[],
	entries: Array<{ position: number; hash: string | null }>,
): void {
	const index = new Map<string, number>();
	for (let i = 0; i < updated.length; i++) {
		const h = updated[i];
		if (h === null) continue;
		const prev = index.get(h);
		if (prev !== undefined) {
			updated[prev] = null;
		}
		index.set(h, i);
	}
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
		if (entry.hash !== null) {
			const existing = index.get(entry.hash);
			if (existing !== undefined && existing !== entry.position) {
				updated[existing] = null;
				index.delete(entry.hash);
			}
			const oldAtPos = updated[entry.position];
			if (oldAtPos !== null && oldAtPos !== entry.hash) {
				index.delete(oldAtPos);
			}
			index.set(entry.hash, entry.position);
		} else {
			const oldAtPos = updated[entry.position];
			if (oldAtPos !== null) index.delete(oldAtPos);
		}
		updated[entry.position] = entry.hash;
	}
	while (updated.length > 0 && updated[updated.length - 1] === null)
		updated.pop();
}

export function getServed(
	store: HashStore,
	sessionKey: string,
	path: string,
): (string | null)[] {
	const row = servedStmts(store.db).servedGet(sessionKey, path);
	if (!row) return [];
	try {
		const parsed = JSON.parse(row.hashes as string);
		if (isValidServedList(parsed)) return parsed;
		servedStmts(store.db).servedDelete(sessionKey, path);
		return [];
	} catch {
		servedStmts(store.db).servedDelete(sessionKey, path);
		return [];
	}
}

export function upsertServed(
	store: HashStore,
	sessionKey: string,
	path: string,
	entries: Array<{ position: number; hash: string | null }>,
): void {
	if (entries.length === 0) return;
	withStore(() => {
		const updated = getServed(store, sessionKey, path).slice();
		patchServed(updated, entries);
		servedStmts(store.db).servedUpsert(sessionKey, path, JSON.stringify(updated), Date.now());
	});
}

export function recordServes(
	store: HashStore,
	sessionKey: string,
	path: string,
	rows: Array<{ position: number; hash: string | null }>,
): void {
	if (rows.length === 0) return;
	try {
		upsertServed(store, sessionKey, path, rows);
	} catch (error) {
		console.error("Failed to record served rows:", error);
	}
}

export function recordServesTruncated(
	store: HashStore,
	sessionKey: string,
	path: string,
	rows: Array<{ position: number; hash: string | null }>,
	lineCount: number,
	clearFrom?: number,
): void {
	if (rows.length === 0) return;
	try {
		withStore(() => {
			const before = getServed(store, sessionKey, path);
			const updated = before.slice();
			if (updated.length > lineCount) updated.length = lineCount;
			if (clearFrom !== undefined) {
				for (let i = clearFrom; i < updated.length; i++) updated[i] = null;
			}
			patchServed(updated, rows);
			if (
				before.length === updated.length &&
				before.every((v, i) => v === updated[i])
			)
				return;
			servedStmts(store.db).servedUpsert(sessionKey, path, JSON.stringify(updated), Date.now());
		});
	} catch (error) {
		console.error("Failed to record truncated served rows:", error);
	}
}

export function getReported(store: HashStore, sessionKey: string, path: string): Set<string> {
	const row = servedStmts(store.db).servedGet(sessionKey, path);
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
	sessionKey: string,
	path: string,
	hashes: string[],
): void {
	const valid = hashes.filter((hash) => HASH_RE.test(hash));
	if (valid.length === 0) return;
	withStore(() => {
		const current = getReported(store, sessionKey, path);
		for (const hash of valid) current.add(hash);
		servedStmts(store.db).servedReportedUpsert(
			sessionKey,
			path,
			JSON.stringify([...current]),
			Date.now(),
		);
	});
}

export function clearReported(store: HashStore, sessionKey: string, path: string): void {
	withStore(() => {
		servedStmts(store.db).servedReportedClear(sessionKey, Date.now(), path);
	});
}

export function deleteServed(store: HashStore, sessionKey: string, path: string): void {
	servedStmts(store.db).servedDelete(sessionKey, path);
}

export function deleteServedByPath(store: HashStore, path: string): void {
	servedStmts(store.db).servedDeletePath(path);
}

export function wipeServed(store: HashStore, sessionKey: string): void {
	servedStmts(store.db).servedWipe(sessionKey);
}

export async function loadServed(
	sessionKey: string,
	path: string,
): Promise<(string | null)[]> {
	const store = await loadHashStore();
	return getServed(store, sessionKey, path);
}

export async function recordServed(
	sessionKey: string,
	path: string,
	rows: ServedEntry[],
): Promise<void> {
	if (rows.length === 0) return;
	try {
		const store = await loadHashStore();
		recordServes(store, sessionKey, path, rows);
	} catch (error) {
		console.error("Failed to record served rows:", error);
	}
}

export async function recordServedTruncated(
	sessionKey: string,
	path: string,
	rows: ServedEntry[],
	lineCount: number,
	clearFrom?: number,
): Promise<void> {
	if (rows.length === 0) return;
	try {
		const store = await loadHashStore();
		recordServesTruncated(store, sessionKey, path, rows, lineCount, clearFrom);
	} catch (error) {
		console.error("Failed to record truncated served rows:", error);
	}
}

export async function driftReported(sessionKey: string, path: string): Promise<Set<string>> {
	try {
		const store = await loadHashStore();
		return getReported(store, sessionKey, path);
	} catch (error) {
		console.error("Failed to load reported drift set:", error);
		return new Set();
	}
}

export async function markDriftReported(
	sessionKey: string,
	path: string,
	hashes: string[],
): Promise<void> {
	try {
		const store = await loadHashStore();
		addReported(store, sessionKey, path, hashes);
	} catch (error) {
		console.error("Failed to record reported drift set:", error);
	}
}

export async function clearDriftReported(sessionKey: string, path: string): Promise<void> {
	try {
		const store = await loadHashStore();
		clearReported(store, sessionKey, path);
	} catch (error) {
		console.error("Failed to clear reported drift set:", error);
	}
}

export async function wipeServedState(sessionKey: string): Promise<void> {
	try {
		const store = await loadHashStore();
		wipeServed(store, sessionKey);
	} catch (error) {
		console.error("Failed to wipe served state:", error);
	}
}

export { servedPositionsOf } from "./hashline/served";

export type ServeRecordPolicy = "live" | "preview";

export async function recordEchoServes(
	sessionKey: string,
	path: string,
	rows: ServedRow[],
	policy: ServeRecordPolicy,
	lineCount?: number,
): Promise<void> {
	if (policy !== "live") return;
	if (lineCount === undefined) {
		await recordServed(sessionKey, path, rows);
		return;
	}
	await recordServedTruncated(sessionKey, path, rows, lineCount);
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
