import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { existsSync } from "fs";
import { readFile, rename, mkdir, stat } from "fs/promises";
import { hashStorePath, hashStoreDir, legacyHashStorePath } from "./paths";
import { errCode } from "./utils";
import { initHasher, contentChecksum } from "./hashline/hasher";
import { HASH_STORE_VERSION, HASH_STORE_BUSY_TIMEOUT } from "./constants";

interface Prepared {
	get: Statement<[string, string, number], { hashes: string }>;
	allPaths: Statement<[], { path: string }>;
	deleteOne: Statement<[string]>;
	upsert: Statement<[string, string, number, string, number]>;
}

export interface HashStore {
	readonly db: DatabaseType;
	readonly stmts: Prepared;
}

interface LegacySnapshot {
	content: string;
	hashes: string[];
}

function isValidSnapshot(value: unknown): value is LegacySnapshot {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.content !== "string") return false;
	if (!Array.isArray(v.hashes)) return false;
	for (const h of v.hashes) {
		if (typeof h !== "string") return false;
	}
	return true;
}

let cachedStore: { path: string; store: HashStore } | null = null;

function openDatabase(storePath: string): HashStore {
	const db = new Database(storePath);
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma(`busy_timeout = ${HASH_STORE_BUSY_TIMEOUT}`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS snapshots (
			path       TEXT PRIMARY KEY,
			checksum   TEXT NOT NULL,
			line_count INTEGER NOT NULL,
			hashes     TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);
	`);
	const stmts: Prepared = {
		get: db.prepare<[string, string, number], { hashes: string }>(
			"SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?",
		),
		allPaths: db.prepare<[], { path: string }>("SELECT path FROM snapshots"),
		deleteOne: db.prepare<[string]>("DELETE FROM snapshots WHERE path = ?"),
		upsert: db.prepare<[string, string, number, string, number]>(
			"INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
				"ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, updated_at = excluded.updated_at",
		),
	};
	return { db, stmts };
}

async function migrateLegacy(store: HashStore): Promise<void> {
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
		console.error("Failed to parse legacy hash store, skipping migration:", error);
		return;
	}

	const raw = parsed.snapshots;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

	const insert = store.db.prepare(
		"INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
	);
	const rows: [string, string, number, string, number][] = [];
	for (const [key, value] of Object.entries(raw)) {
		if (!isValidSnapshot(value)) continue;
		rows.push([
			key,
			contentChecksum(value.content),
			value.content.split("\n").length,
			JSON.stringify(value.hashes),
			Date.now(),
		]);
	}

	if (rows.length > 0) {
		store.db.transaction(() => {
			for (const row of rows) insert.run(...row);
		}).immediate();
	}

	try {
		await rename(legacyPath, `${legacyPath}.bak`);
	} catch (error) {
		console.error("Failed to rename legacy hash store after migration:", error);
	}
}

export async function loadHashStore(): Promise<HashStore> {
	const storePath = hashStorePath();
	if (cachedStore && cachedStore.path === storePath) {
		return cachedStore.store;
	}

	shutdownHashStore();

	await initHasher();
	await mkdir(hashStoreDir(), { recursive: true });

	const existed = existsSync(storePath);
	const store = openDatabase(storePath);
	if (!existed) {
		await migrateLegacy(store);
	}
	cachedStore = { path: storePath, store };
	return store;
}

export function shutdownHashStore(): void {
	if (cachedStore) {
		cachedStore.store.db.close();
		cachedStore = null;
	}
}

export function getSnapshot(
	store: HashStore,
	path: string,
	content: string,
): string[] | undefined {
	const checksum = contentChecksum(content);
	const lineCount = content.split("\n").length;
	const row = store.stmts.get.get(path, checksum, lineCount);
	return row ? (JSON.parse(row.hashes) as string[]) : undefined;
}

export function upsertSnapshot(
	store: HashStore,
	path: string,
	checksum: string,
	lineCount: number,
	hashes: string[],
): void {
	const hashesJson = JSON.stringify(hashes);
	store.db.transaction(() => {
		store.stmts.upsert.run(path, checksum, lineCount, hashesJson, Date.now());
	}).immediate();
}

export function deleteSnapshot(store: HashStore, path: string): void {
	store.db.transaction(() => {
		store.stmts.deleteOne.run(path);
	}).immediate();
}

export async function pruneMissing(store: HashStore): Promise<void> {
	const rows = store.stmts.allPaths.all();
	const missing: string[] = [];
	for (const row of rows) {
		try {
			await stat(row.path);
		} catch {
			missing.push(row.path);
		}
	}
	if (missing.length === 0) return;
	store.db.transaction(() => {
		for (const path of missing) store.stmts.deleteOne.run(path);
	}).immediate();
}

export { HASH_STORE_VERSION };