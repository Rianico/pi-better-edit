// SAFETY: large-class — hasher module owns single wasm instance and helpers as cohesive unit; no split needed.
import { existsSync } from "node:fs";
import { rename, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath, join, dirname } from "node:path";
import { errCode } from "./utils.js";
import { initHasher } from "./hashline/hasher.js";
import { HASH_STORE_VERSION, HASH_STORE_BUSY_TIMEOUT } from "./constants.js";

function homeBase(): string {
  const envHome = process.env.HOME;
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function configBase(): string {
  if (process.platform !== "win32") {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && xdg.length > 0) return xdg;
  }
  // SAFETY: join of trusted homedir (or HOME env validated by OS) with fixed ".config" segment — not user-controlled traversal, base is homedir and suffix is constant.
  return join(homeBase(), ".config");
}

export function configDir(): string {
  // SAFETY: join of trusted configBase (homedir/.config) with fixed "pi-better-edit" — constant suffix, no traversal.
  return join(configBase(), "pi-better-edit");
}

export function hashStorePath(): string {
  // SAFETY: join of trusted configDir with fixed "hash-store.sqlite" — constant suffix, no traversal.
  return join(configDir(), "hash-store.sqlite");
}

export function legacyHashStorePath(): string {
  // SAFETY: join of trusted configDir with fixed "hash-store.json" — constant suffix, no traversal.
  return join(configDir(), "hash-store.json");
}

export function hashStoreDir(): string {
  return dirname(hashStorePath());
}

function expand(filePath: string): string {
  const home = homeBase();
  if (filePath === "~") return home;
  if (filePath.startsWith("~/")) return home + filePath.slice(1);
  return filePath;
}

export function toCwd(filePath: string, cwd: string): string {
  if (filePath.includes("\0"))
    throw new Error(
      "[MODEL] [E_BAD_PAYLOAD] Path contains null byte. Pass a plain file string and retry.",
    );
  const expanded = expand(filePath);
  if (expanded.includes("\0"))
    throw new Error(
      "[MODEL] [E_BAD_PAYLOAD] Path contains null byte. Pass a plain file string and retry.",
    );
  // SAFETY: cwd is trusted (ctx.cwd), expand resolves "~" via homedir/XDG and resolvePath normalizes ".."; editing scope intentionally allows any absolute path — OS permissions enforced by valAccess downstream; guard ensures null-byte free and absolute result.
  const resolved = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
  if (!isAbsolute(resolved))
    throw new Error("[MODEL] [E_BAD_PAYLOAD] Resolved path must be absolute");
  return resolved;
}

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

export function getCached<T>(
  db: DatabaseSync,
  cache: WeakMap<DatabaseSync, T>,
  build: (db: DatabaseSync) => T,
): T {
  let v = cache.get(db);
  if (v) return v;
  v = build(db);
  cache.set(db, v);
  return v;
}

export interface HashStore {
  readonly db: DatabaseSync;
  readonly engine: "node:sqlite";
}

let cachedDb: { path: string; db: DatabaseSync } | null = null;
let opening: { path: string; promise: Promise<HashStore> } | null = null;
let exitHandlerRegistered = false;

export type StoreOpenHook = (db: DatabaseSync, info: { existed: boolean }) => void | Promise<void>;

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
    } catch (closeError: unknown) {
      console.error("[hash-store] failed to close DB after buildStore error:", closeError);
    }
    throw error;
  }
  return db;
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set<string>();
  }
}

function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  if (!tableColumns(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// WHY: snapshot-store reads and writes these tables through HashSnapshotIO, so the DDL lives
// WHY: in the schema owner (spec §5.1) and both modules share one definition.
export function ensureSnapshotTables(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS file_snapshots (" +
      "snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "path TEXT NOT NULL, " +
      "snapshot_hash TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "created_at INTEGER NOT NULL, " +
      "committed INTEGER NOT NULL DEFAULT 1, " +
      "UNIQUE (path, snapshot_hash)" +
      ")",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_snapshots_created ON file_snapshots (created_at)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS line_id_counters (" +
      "path TEXT PRIMARY KEY, " +
      "next_id INTEGER NOT NULL" +
      ")",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS line_lineage (" +
      "snapshot_id INTEGER NOT NULL, " +
      "line_number INTEGER NOT NULL, " +
      "line_id INTEGER NOT NULL, " +
      "canon_hash TEXT NOT NULL, " +
      "anchor TEXT NOT NULL, " +
      "PRIMARY KEY (snapshot_id, line_number), " +
      "FOREIGN KEY (snapshot_id) REFERENCES file_snapshots(snapshot_id) ON DELETE CASCADE" +
      ")",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_lineage_snapshot_line_id " +
      "ON line_lineage (snapshot_id, line_id)",
  );
}

// WHY: file_undo is the single source of truth for undo history in v7; the DDL lives here
// WHY: (spec §5.1) so the store and the undo domain cannot drift apart.
const FILE_UNDO_DDL =
  "CREATE TABLE IF NOT EXISTS file_undo (" +
  "path TEXT PRIMARY KEY, " +
  "content TEXT NOT NULL, " +
  "bom TEXT NOT NULL, " +
  "ending TEXT NOT NULL, " +
  "hashes TEXT NOT NULL, " +
  "result_content TEXT NOT NULL, " +
  "snapshot_hash TEXT, " +
  "updated_at INTEGER NOT NULL" +
  ")";

export function ensureFileUndoSchema(db: DatabaseSync): void {
  db.exec(FILE_UNDO_DDL);
  addColumnIfMissing(db, "file_undo", "snapshot_hash", "TEXT");
}

function buildStore(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (" + "key TEXT PRIMARY KEY, " + "value TEXT NOT NULL" + ")",
  );
  // WHY: v7 normalized CAS tables are strictly additive and idempotent — buildStore
  // WHY: never drops them on meta.version mismatch, so a version flap in
  // WHY: mixed-version / multi-worktree environments cannot destroy leases, lineage, or undo pins.
  ensureSnapshotTables(db);
  db.exec(
    "CREATE TABLE IF NOT EXISTS served_leases (" +
      "session_id TEXT NOT NULL, " +
      "file_path TEXT NOT NULL, " +
      "anchor TEXT NOT NULL, " +
      "line_id INTEGER NOT NULL, " +
      "canon_hash TEXT NOT NULL, " +
      "served_snapshot_hash TEXT NOT NULL, " +
      "served_line_number INTEGER NOT NULL, " +
      "updated_at INTEGER NOT NULL, " +
      "retired_at INTEGER, " +
      "PRIMARY KEY (session_id, file_path, anchor)" +
      ")",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_line " +
      "ON served_leases (session_id, file_path, line_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_line_num " +
      "ON served_leases (session_id, file_path, served_line_number)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_file_retired " +
      "ON served_leases (file_path, retired_at)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS served_session_meta (" +
      "session_id TEXT NOT NULL, " +
      "file_path TEXT NOT NULL, " +
      "reported TEXT, " +
      "updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY (session_id, file_path)" +
      ")",
  );
  ensureFileUndoSchema(db);
  // WHY: complete v6 compatibility shells keep un-restarted v6 sessions and concurrent
  // WHY: worktrees free of missing-table errors and v6 drop-table wipes, while v7 state
  // WHY: stays isolated in v7 tables. Only the ancient pre-session-keyed served shell is
  // WHY: rebuilt — it is unusable by either version without session_id.
  if (tableColumns(db, "served").size > 0 && !tableColumns(db, "served").has("session_id")) {
    db.exec("DROP TABLE served");
  }
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
  db.exec(
    "CREATE TABLE IF NOT EXISTS served (" +
      "session_id TEXT NOT NULL, " +
      "path TEXT NOT NULL, " +
      "hashes TEXT NOT NULL DEFAULT '[]', " +
      "reported TEXT, " +
      "retired TEXT, " +
      "canons TEXT, " +
      "snapshotId TEXT, " +
      "updated_at INTEGER NOT NULL DEFAULT 0, " +
      "PRIMARY KEY (session_id, path)" +
      ")",
  );
  // WHY: non-destructive column migrations keep pre-existing databases aligned without wipes.
  addColumnIfMissing(db, "served", "retired", "TEXT");
  addColumnIfMissing(db, "served", "canons", "TEXT");
  addColumnIfMissing(db, "served", "snapshotId", "TEXT");
  addColumnIfMissing(db, "undo", "result_content", "TEXT NOT NULL DEFAULT ''");
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(HASH_STORE_VERSION));
}

function isHealthy(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
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
  } catch (error: unknown) {
    console.error("[hash-store] failed to checkpoint WAL on shutdown:", error);
  }
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
  if (!cachedDb || !cachedDb.db.isOpen) {
    throw new Error(
      "withStore requires an open SQLite store — call loadHashStore() first or use a MemoryStore in tests",
    );
  }
  withBusyRetry(() => {
    cachedDb!.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      cachedDb!.db.exec("COMMIT");
    } catch (e) {
      try {
        cachedDb!.db.exec("ROLLBACK");
      } catch (rollbackError: unknown) {
        console.error("[hash-store] failed to rollback transaction:", rollbackError);
      }
      throw e;
    }
  });
}

export function __isStoreOpen(): boolean {
  return cachedDb !== null && cachedDb.db.isOpen;
}
