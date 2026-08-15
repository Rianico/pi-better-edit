import { readFile, rename, stat } from "fs/promises";
import { DatabaseSync } from "node:sqlite";
import { contentChecksum } from "./hashline/hasher";
import {
	isValidHashList,
	setDefaultHashSnapshotIO,
	type HashSnapshotIO,
} from "./hashline/hash";
import { splitLines, errCode } from "./utils";
import {
	loadHashStore,
	onStoreOpen,
	withStore,
	withBusyRetry,
	type HashStore,
} from "./hash-store";
import { legacyHashStorePath } from "./paths";
import { deleteUndo } from "./undo-store";
import { deleteServedByPath } from "./served-state";

export interface LegacySnapshot {
	content: string;
	hashes: string[];
}

export interface SnapshotStmts {
	get: (
		path: string,
		checksum: string,
		lineCount: number,
	) => Record<string, unknown> | undefined;
	allHashes: () => Record<string, unknown>[];
	allPaths: () => Record<string, unknown>[];
	deleteOne: (path: string) => void;
	upsert: (
		path: string,
		checksum: string,
		lineCount: number,
		hashes: string,
		updatedAt: number,
	) => void;
}

const stmtsCache = new WeakMap<DatabaseSync, SnapshotStmts>();

export function snapshotStmts(db: DatabaseSync): SnapshotStmts {
	let stmts = stmtsCache.get(db);
	if (stmts) return stmts;
	stmts = buildStmts(db);
	stmtsCache.set(db, stmts);
	return stmts;
}

function buildStmts(db: DatabaseSync): SnapshotStmts {
	const getStmt = db.prepare(
		"SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?",
	);
	const allHashesStmt = db.prepare("SELECT path, hashes FROM snapshots");
	const allPathsStmt = db.prepare(
		"SELECT path FROM snapshots UNION SELECT path FROM undo UNION SELECT path FROM served",
	);
	const deleteStmt = db.prepare("DELETE FROM snapshots WHERE path = ?");
	const upsertStmt = db.prepare(
		"INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
			"ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, updated_at = excluded.updated_at",
	);
	return {
		get: (...params) =>
			getStmt.get(...params) as Record<string, unknown> | undefined,
		allHashes: () => allHashesStmt.all() as Record<string, unknown>[],
		allPaths: () => allPathsStmt.all() as Record<string, unknown>[],
		deleteOne: (path) => {
			withBusyRetry(() => {
				deleteStmt.run(path);
			});
		},
		upsert: (path, checksum, lineCount, hashes, updatedAt) => {
			withBusyRetry(() => {
				upsertStmt.run(path, checksum, lineCount, hashes, updatedAt);
			});
		},
	};
}

export function isValidSnapshot(value: unknown): value is LegacySnapshot {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.content !== "string") return false;
	return isValidHashList(v.hashes);
}

export function getSnapshot(
	store: HashStore,
	path: string,
	content: string,
	deleteCorrupt = true,
): string[] | undefined {
	const checksum = contentChecksum(content);
	const lineCount = splitLines(content).length;
	const row = snapshotStmts(store.db).get(path, checksum, lineCount);
	if (!row) return undefined;
	try {
		const parsed = JSON.parse(row.hashes as string);
		if (isValidHashList(parsed)) return parsed;
		if (deleteCorrupt) snapshotStmts(store.db).deleteOne(path);
		return undefined;
	} catch {
		if (deleteCorrupt) snapshotStmts(store.db).deleteOne(path);
		return undefined;
	}
}

export function upsertSnapshot(
	store: HashStore,
	path: string,
	checksum: string,
	lineCount: number,
	hashes: string[],
): void {
	snapshotStmts(store.db).upsert(
		path,
		checksum,
		lineCount,
		JSON.stringify(hashes),
		Date.now(),
	);
}

export function snapshotIOFor(store: HashStore): HashSnapshotIO {
	return {
		async get(path, content, deleteCorrupt) {
			return getSnapshot(store, path, content, deleteCorrupt);
		},
		async upsert(path, checksum, lineCount, hashes) {
			upsertSnapshot(store, path, checksum, lineCount, hashes);
		},
	};
}

setDefaultHashSnapshotIO({
	async get(path, content, deleteCorrupt) {
		const store = await loadHashStore();
		return getSnapshot(store, path, content, deleteCorrupt);
	},
	async upsert(path, checksum, lineCount, hashes) {
		const store = await loadHashStore();
		upsertSnapshot(store, path, checksum, lineCount, hashes);
	},
});

export async function findSnapshotPathsByHashes(
	hashes: string[],
): Promise<string[]> {
	const store = await loadHashStore();
	return findSnapshotPaths(store, hashes);
}

export async function pruneMissingAll(): Promise<void> {
	const store = await loadHashStore();
	await pruneMissing(store);
}

export async function upsertSnapshotFor(
	path: string,
	checksum: string,
	lineCount: number,
	hashes: string[],
): Promise<void> {
	const store = await loadHashStore();
	upsertSnapshot(store, path, checksum, lineCount, hashes);
}

export function findSnapshotPaths(
	store: HashStore,
	hashes: string[],
): string[] {
	const rows = snapshotStmts(store.db).allHashes() as {
		path: string;
		hashes: string;
	}[];
	const matches: string[] = [];
	for (const row of rows) {
		try {
			const parsed = JSON.parse(row.hashes) as unknown;
			if (!isValidHashList(parsed)) continue;
			if (hashes.every((h) => parsed.includes(h))) matches.push(row.path);
		} catch {
			continue;
		}
	}
	return matches;
}

const STAT_BATCH = 64;

async function statMissing(rows: { path: string }[]): Promise<string[]> {
	const missing: string[] = [];
	for (let i = 0; i < rows.length; i += STAT_BATCH) {
		const batch = rows.slice(i, i + STAT_BATCH);
		const results = await Promise.all(
			batch.map(async (row) => {
				try {
					await stat(row.path);
					return undefined;
				} catch {
					return row.path;
				}
			}),
		);
		for (const path of results) {
			if (path !== undefined) missing.push(path);
		}
	}
	return missing;
}

export async function pruneMissing(store: HashStore): Promise<void> {
	const rows = snapshotStmts(store.db).allPaths() as { path: string }[];
	const missing = await statMissing(rows);
	if (missing.length === 0) return;
	withStore(() => {
		for (const path of missing) {
			snapshotStmts(store.db).deleteOne(path);
			deleteUndo(store, path);
			deleteServedByPath(store, path);
		}
	});
}

async function migrateLegacy(db: DatabaseSync): Promise<void> {
	const legacyPath = legacyHashStorePath();
	let content: string;
	try {
		content = await readFile(legacyPath, "utf-8");
	} catch (error: unknown) {
		if (errCode(error) === "ENOENT") return;
		console.error("Failed to read legacy hash store for migration:", error);
		return;
	}

	let parsed: { snapshots?: Record<string, unknown> };
	try {
		parsed = JSON.parse(content) as typeof parsed;
	} catch (error) {
		console.error(
			"Failed to parse legacy hash store, skipping migration:",
			error,
		);
		return;
	}

	const raw = parsed.snapshots;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

	const rows: [string, string, number, string, number][] = [];
	for (const [key, value] of Object.entries(raw)) {
		if (!isValidSnapshot(value)) continue;
		if (new Set(value.hashes).size !== value.hashes.length) {
			console.warn(
				`Skipped legacy snapshot with duplicate hashes for ${key}; it will be re-hashed on next read.`,
			);
			continue;
		}
		rows.push([
			key,
			contentChecksum(value.content),
			splitLines(value.content).length,
			JSON.stringify(value.hashes),
			Date.now(),
		]);
	}
	if (rows.length > 0) {
		db.exec("BEGIN IMMEDIATE");
		try {
			const stmt = db.prepare(
				"INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
			);
			for (const row of rows) stmt.run(...row);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
	}

	try {
		await rename(legacyPath, `${legacyPath}.bak`);
	} catch (error) {
		console.error("Failed to rename legacy hash store after migration:", error);
	}
}

onStoreOpen(async (db, { existed }) => {
	if (existed) return;
	await migrateLegacy(db);
});
