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
    throw new Error("[MODEL] [E_BAD_PAYLOAD] Path contains null byte");
  const expanded = expand(filePath);
  if (expanded.includes("\0"))
    throw new Error("[MODEL] [E_BAD_PAYLOAD] Path contains null byte");
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
    } catch (closeError: unknown) {
      console.error(
        "[hash-store] failed to close DB after buildStore error:",
        closeError,
      );
    }
    throw error;
  }
  return db;
}

function buildStore(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (" +
      "key TEXT PRIMARY KEY, " +
      "value TEXT NOT NULL" +
      ")",
  );
  const versionRow = db
    .prepare("SELECT value FROM meta WHERE key = 'version'")
    .get() as { value?: string } | undefined;
  const versionChanged =
    versionRow !== undefined && versionRow.value !== String(HASH_STORE_VERSION);
  if (versionChanged) {
    try {
      db.exec("DROP TABLE IF EXISTS snapshots");
    } catch (error: unknown) {
      console.error(
        "[hash-store] failed to drop snapshots table on version change:",
        error,
      );
    }
    try {
      db.exec("DROP TABLE IF EXISTS undo");
    } catch (error: unknown) {
      console.error(
        "[hash-store] failed to drop undo table on version change:",
        error,
      );
    }
    try {
      db.exec("DROP TABLE IF EXISTS served");
    } catch (error: unknown) {
      console.error(
        "[hash-store] failed to drop served table on version change:",
        error,
      );
    }
  } else {
    try {
      const servedColumns = db.prepare("PRAGMA table_info(served)").all() as {
        name: string;
      }[];
      if (
        servedColumns.length > 0 &&
        !servedColumns.some((c) => c.name === "session_id")
      ) {
        db.exec("DROP TABLE IF EXISTS served");
      }
    } catch (error: unknown) {
      console.error(
        "[hash-store] failed to inspect served table schema:",
        error,
      );
    }
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
      "hashes TEXT NOT NULL, " +
      "reported TEXT, " +
      "retired TEXT, " +
      "canons TEXT, " +
      "snapshotId TEXT, " +
      "updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY (session_id, path)" +
      ")",
  );
  {
    const cols = db.prepare("PRAGMA table_info(served)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "retired")) {
      let migrationOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        migrationOpen = true;
        const mcols = db.prepare("PRAGMA table_info(served)").all() as { name: string }[];
        if (!mcols.some((c) => c.name === "retired")) {
          db.exec("ALTER TABLE served ADD COLUMN retired TEXT");
          db.exec("DELETE FROM snapshots");
          db.exec("DELETE FROM undo");
        }
        db.exec("COMMIT");
        migrationOpen = false;
      } catch (e) {
        if (migrationOpen) {
          try { db.exec("ROLLBACK"); } catch {}
        }
        throw e;
      }
    }
    const cols2 = db.prepare("PRAGMA table_info(served)").all() as { name: string }[];
    if (!cols2.some((c) => c.name === "canons")) {
      db.exec("ALTER TABLE served ADD COLUMN canons TEXT");
    }
    const cols3 = db.prepare("PRAGMA table_info(served)").all() as { name: string }[];
    if (!cols3.some((c) => c.name === "snapshotId")) {
      db.exec("ALTER TABLE served ADD COLUMN snapshotId TEXT");
    }
  }
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
        console.error(
          "[hash-store] failed to rollback transaction:",
          rollbackError,
        );
      }
      throw e;
    }
  });
}

export function __isStoreOpen(): boolean {
  return cachedDb !== null && cachedDb.db.isOpen;
}
