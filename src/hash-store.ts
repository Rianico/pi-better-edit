import { existsSync } from "fs";
import { rename, mkdir } from "fs/promises";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath, hashStoreDir } from "./paths";
import { errCode } from "./utils";
import { initHasher } from "./hashline/hasher";
import { HASH_STORE_VERSION, HASH_STORE_BUSY_TIMEOUT } from "./constants";

export function isCorruptionError(error: unknown): boolean {
	if (error && typeof error === "object") {
		const errcode = (error as { errcode?: unknown }).errcode;
		if (typeof errcode === "number") {
			return errcode === 11 || errcode === 24 || errcode === 26;
		}
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && /NOTADB|CORRUPT/.test(code)) return true;
	}
	return (
		error instanceof Error &&
		/corrupt|not a database|malformed|database disk image/i.test(error.message)
	);
}

function isBusyError(error: unknown): boolean {
	if (error && typeof error === "object") {
		const errcode = (error as { errcode?: unknown }).errcode;
		if (typeof errcode === "number") return errcode === 5 || errcode === 6;
	}
	return error instanceof Error && /busy|locked/i.test(error.message);
}

function sleepSync(ms: number): void {
	const sab = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(sab, 0, 0, ms);
}

const BUSY_RETRIES = 3;
const BUSY_RETRY_DELAY_MS = 100;

export function withBusyRetry<T>(fn: () => T): T {
	let lastError: unknown;
	for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
		try {
			return fn();
		} catch (error) {
			lastError = error;
			if (!isBusyError(error) || attempt === BUSY_RETRIES) throw error;
			sleepSync(BUSY_RETRY_DELAY_MS);
		}
	}
	throw lastError;
}

export interface HashStore {
	readonly db: DatabaseSync;
	readonly engine: "node:sqlite";
}

let cachedDb: { path: string; db: DatabaseSync } | null = null;
let opening: { path: string; promise: Promise<HashStore> } | null = null;
let exitHandlerRegistered = false;

export type StoreOpenHook = (
	db: DatabaseSync,
	info: { existed: boolean },
) => void | Promise<void>;

const openHooks: StoreOpenHook[] = [];

export function onStoreOpen(hook: StoreOpenHook): void {
	openHooks.push(hook);
}

function openDbWithBusyRetry(storePath: string): DatabaseSync {
	return withBusyRetry(() => openDb(storePath));
}

function openDb(storePath: string): DatabaseSync {
	const db = new DatabaseSync(storePath, {
		timeout: HASH_STORE_BUSY_TIMEOUT,
	});
	try {
		buildStore(db);
	} catch (error) {
		try {
			db.close();
		} catch {}
		throw error;
	}
	return db;
}

function buildStore(db: DatabaseSync): void {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec(
		"CREATE TABLE IF NOT EXISTS snapshots (" +
			"path TEXT PRIMARY KEY, " +
			"checksum TEXT NOT NULL, " +
			"line_count INTEGER NOT NULL, " +
			"hashes TEXT NOT NULL, " +
			"updated_at INTEGER NOT NULL" +
			")",
	);
	db.exec(
		"CREATE TABLE IF NOT EXISTS meta (" +
			"key TEXT PRIMARY KEY, " +
			"value TEXT NOT NULL" +
			")",
	);
	db.exec(
		"CREATE TABLE IF NOT EXISTS undo (" +
			"path TEXT PRIMARY KEY, " +
			"content TEXT NOT NULL, " +
			"bom TEXT NOT NULL, " +
			"ending TEXT NOT NULL, " +
			"hashes TEXT NOT NULL, " +
			"result_content TEXT NOT NULL, " +
			"updated_at INTEGER NOT NULL" +
			")",
	);
	const versionRow = db
		.prepare("SELECT value FROM meta WHERE key = 'version'")
		.get() as { value?: string } | undefined;
	const versionChanged =
		versionRow !== undefined &&
		versionRow.value !== String(HASH_STORE_VERSION);
	if (versionChanged) {
		db.exec("DELETE FROM snapshots");
		db.exec("DELETE FROM undo");
	}
	const servedColumns = db.prepare("PRAGMA table_info(served)").all() as {
		name: string;
	}[];
	if (
		versionChanged ||
		!servedColumns.some((column) => column.name === "session_id")
	) {
		db.exec("DROP TABLE IF EXISTS served");
	}
	db.exec(
		"CREATE TABLE IF NOT EXISTS served (" +
			"session_id TEXT NOT NULL, " +
			"path TEXT NOT NULL, " +
			"hashes TEXT NOT NULL, " +
			"reported TEXT, " +
			"updated_at INTEGER NOT NULL, " +
			"PRIMARY KEY (session_id, path)" +
			")",
	);
	db.prepare(
		"INSERT INTO meta (key, value) VALUES ('version', ?) " +
			"ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(String(HASH_STORE_VERSION));
}

function isHealthy(db: DatabaseSync): boolean {
	try {
		const row = db.prepare("PRAGMA quick_check").get() as
			| { quick_check?: string }
			| undefined;
		return row?.quick_check === "ok";
	} catch (error) {
		if (isCorruptionError(error)) return false;
		return true;
	}
}

async function quarantineStore(storePath: string): Promise<void> {
	const suffix = `.corrupt-${Date.now()}`;
	for (const candidate of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
		try {
			await rename(candidate, `${candidate}${suffix}`);
		} catch (error) {
			if (errCode(error) !== "ENOENT") {
				console.error("Failed to quarantine corrupt hash store file:", error);
			}
		}
	}
}

function shutdownDb(db: DatabaseSync): void {
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch {}
	db.close();
}

async function openStore(storePath: string): Promise<HashStore> {
	shutdownHashStore();

	await initHasher();
	await mkdir(hashStoreDir(), { recursive: true });

	let existed = existsSync(storePath);
	let db: DatabaseSync;
	try {
		db = openDbWithBusyRetry(storePath);
	} catch (error) {
		if (!isCorruptionError(error)) throw error;
		console.error("Hash store failed to open, rebuilding:", error);
		await quarantineStore(storePath);
		existed = false;
		db = openDbWithBusyRetry(storePath);
	}
	if (!isHealthy(db)) {
		shutdownDb(db);
		await quarantineStore(storePath);
		existed = false;
		db = openDbWithBusyRetry(storePath);
	}

	for (const hook of openHooks) {
		await hook(db, { existed });
	}

	cachedDb = { path: storePath, db };

	if (!exitHandlerRegistered) {
		exitHandlerRegistered = true;
		process.once("exit", () => shutdownHashStore());
		for (const sig of ["SIGINT", "SIGTERM"] as const) {
			process.once(sig, () => {
				shutdownHashStore();
				process.kill(process.pid, sig);
			});
		}
	}

	return { db, engine: "node:sqlite" };
}

export function loadHashStore(): Promise<HashStore> {
	const storePath = hashStorePath();
	if (cachedDb && cachedDb.path === storePath && cachedDb.db.isOpen) {
		return Promise.resolve({ db: cachedDb.db, engine: "node:sqlite" });
	}
	if (opening && opening.path === storePath) {
		return opening.promise;
	}
	const promise = openStore(storePath).finally(() => {
		if (opening?.path === storePath) opening = null;
	});
	opening = { path: storePath, promise };
	return promise;
}

export function shutdownHashStore(): void {
	if (cachedDb) {
		shutdownDb(cachedDb.db);
		cachedDb = null;
	}
}

export function withStore(fn: () => void): void {
	if (cachedDb) {
		withBusyRetry(() => {
			cachedDb!.db.exec("BEGIN IMMEDIATE");
			try {
				fn();
				cachedDb!.db.exec("COMMIT");
			} catch (e) {
				try {
					cachedDb!.db.exec("ROLLBACK");
				} catch {}
				throw e;
			}
		});
	} else {
		fn();
	}
}
