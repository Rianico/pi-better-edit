import { existsSync } from "fs";
import { readFile, rename, mkdir, stat } from "fs/promises";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath, hashStoreDir, legacyHashStorePath } from "./paths";
import { errCode, splitLines } from "./utils";
import { initHasher, contentChecksum } from "./hashline/hasher";
import { HASH_STORE_VERSION, HASH_STORE_BUSY_TIMEOUT } from "./constants";
type SqlParams = (string | number)[];

interface Prepared {
  get: (...params: SqlParams) => Record<string, unknown> | undefined;
  allPaths: (...params: SqlParams) => Record<string, unknown>[];
  deleteOne: (...params: SqlParams) => void;
  upsert: (...params: SqlParams) => void;
  undoUpsert: (...params: SqlParams) => void;
  undoGet: (...params: SqlParams) => Record<string, unknown> | undefined;
  undoDelete: (...params: SqlParams) => void;
}

export interface HashStore {
  readonly stmts: Prepared;
  readonly engine: "node:sqlite";
}

export interface UndoRecord {
  content: string;
  bom: string;
  ending: string;
  hashes: string[];
  resultContent: string;
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

function withBusyRetry<T>(fn: () => T): T {
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

function openDbWithBusyRetry(storePath: string): { db: DatabaseSync; stmts: Prepared } {
  return withBusyRetry(() => openDb(storePath));
}

let cachedDb: { path: string; db: DatabaseSync; stmts: Prepared } | null = null;
let opening: { path: string; promise: Promise<HashStore> } | null = null;
let exitHandlerRegistered = false;
function openDb(storePath: string): { db: DatabaseSync; stmts: Prepared } {
  const db = new DatabaseSync(storePath, {
    timeout: HASH_STORE_BUSY_TIMEOUT,
  });
  try {
    return buildStore(db);
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}

function buildStore(
  db: DatabaseSync,
): { db: DatabaseSync; stmts: Prepared } {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS snapshots (" +
      "path TEXT PRIMARY KEY, " +
      "checksum TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
    ")"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (" +
      "key TEXT PRIMARY KEY, " +
      "value TEXT NOT NULL" +
    ")"
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
    ")"
  );
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
  if (versionRow && versionRow.value !== String(HASH_STORE_VERSION)) {
    db.exec("DELETE FROM snapshots");
    db.exec("DELETE FROM undo");
  }
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('version', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(HASH_STORE_VERSION));
  const getStmt = db.prepare("SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?");
  const allStmt = db.prepare("SELECT path FROM snapshots UNION SELECT path FROM undo");
  const delStmt = db.prepare("DELETE FROM snapshots WHERE path = ?");
  const upsertStmt = db.prepare(
    "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, updated_at = excluded.updated_at"
  );
  const undoUpsertStmt = db.prepare(
    "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(path) DO UPDATE SET content = excluded.content, bom = excluded.bom, ending = excluded.ending, hashes = excluded.hashes, result_content = excluded.result_content, updated_at = excluded.updated_at"
  );
  const undoGetStmt = db.prepare(
    "SELECT content, bom, ending, hashes, result_content FROM undo WHERE path = ?"
  );
  const undoDelStmt = db.prepare("DELETE FROM undo WHERE path = ?");
  const stmts: Prepared = {
    get: (...params) => getStmt.get(...params) as Record<string, unknown> | undefined,
    allPaths: (...params) => allStmt.all(...params) as Record<string, unknown>[],
    deleteOne: (...params) => { withBusyRetry(() => { delStmt.run(...params); }); },
    upsert: (...params) => { withBusyRetry(() => { upsertStmt.run(...params); }); },
    undoUpsert: (...params) => { withBusyRetry(() => { undoUpsertStmt.run(...params); }); },
    undoGet: (...params) => undoGetStmt.get(...params) as Record<string, unknown> | undefined,
    undoDelete: (...params) => { withBusyRetry(() => { undoDelStmt.run(...params); }); },
  };
  return { db, stmts };
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
  } catch {
  }
  db.close();
}

async function openStore(storePath: string): Promise<HashStore> {
  shutdownHashStore();

  await initHasher();
  await mkdir(hashStoreDir(), { recursive: true });

  let existed = existsSync(storePath);
  let opened: { db: DatabaseSync; stmts: Prepared };
  try {
    opened = openDbWithBusyRetry(storePath);
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    console.error("Hash store failed to open, rebuilding:", error);
    await quarantineStore(storePath);
    existed = false;
    opened = openDbWithBusyRetry(storePath);
  }
  if (!isHealthy(opened.db)) {
    shutdownDb(opened.db);
    await quarantineStore(storePath);
    existed = false;
    opened = openDbWithBusyRetry(storePath);
  }
  const { db, stmts } = opened;

  if (!existed) {
    await migrateLegacy(db);
  }
  cachedDb = { path: storePath, db, stmts };

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

  return { stmts, engine: "node:sqlite" };
}

export function loadHashStore(): Promise<HashStore> {
  const storePath = hashStorePath();
  if (cachedDb && cachedDb.path === storePath && cachedDb.db.isOpen) {
    return Promise.resolve({ stmts: cachedDb.stmts, engine: "node:sqlite" });
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

function withStore(fn: () => void): void {
  if (cachedDb) {
    withBusyRetry(() => {
      cachedDb!.db.exec("BEGIN IMMEDIATE");
      try {
        fn();
        cachedDb!.db.exec("COMMIT");
      } catch (e) {
        try { cachedDb!.db.exec("ROLLBACK"); } catch {}
        throw e;
      }
    });
  } else {
    fn();
  }
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
    console.error("Failed to parse legacy hash store, skipping migration:", error);
    return;
  }

  const raw = parsed.snapshots;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

  const rows: [string, string, number, string, number][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!isValidSnapshot(value)) continue;
    if (new Set(value.hashes).size !== value.hashes.length) {
      console.warn(`Skipped legacy snapshot with duplicate hashes for ${key}; it will be re-hashed on next read.`);
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
        "INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)"
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

export function getSnapshot(
  store: HashStore,
  path: string,
  content: string,
): string[] | undefined {
  const checksum = contentChecksum(content);
  const lineCount = splitLines(content).length;
  const row = store.stmts.get(path, checksum, lineCount);
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.hashes as string);
    return Array.isArray(parsed) && parsed.every((h) => typeof h === "string")
      ? (parsed as string[])
      : undefined;
  } catch {
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
  store.stmts.upsert(path, checksum, lineCount, JSON.stringify(hashes), Date.now());
}

export function upsertUndo(store: HashStore, path: string, entry: UndoRecord): void {
  store.stmts.undoUpsert(
    path,
    entry.content,
    entry.bom,
    entry.ending,
    JSON.stringify(entry.hashes),
    entry.resultContent,
    Date.now(),
  );
}

export function getUndoEntry(store: HashStore, path: string): UndoRecord | undefined {
  const row = store.stmts.undoGet(path);
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.hashes as string);
    if (!Array.isArray(parsed) || !parsed.every((h) => typeof h === "string")) {
      store.stmts.undoDelete(path);
      return undefined;
    }
    return {
      content: row.content as string,
      bom: row.bom as string,
      ending: row.ending as string,
      hashes: parsed as string[],
      resultContent: row.result_content as string,
    };
  } catch {
    store.stmts.undoDelete(path);
    return undefined;
  }
}

export function deleteUndo(store: HashStore, path: string): void {
  store.stmts.undoDelete(path);
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
  const rows = store.stmts.allPaths() as { path: string }[];
  const missing = await statMissing(rows);
  if (missing.length === 0) return;
  withStore(() => {
    for (const path of missing) {
      store.stmts.deleteOne(path);
      store.stmts.undoDelete(path);
    }
  });
}
