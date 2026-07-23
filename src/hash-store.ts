import initSqlJs, { type Database as DatabaseType, type SqlValue } from "sql.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { readFile, rename, mkdir, stat } from "fs/promises";
import { hashStorePath, hashStoreDir, legacyHashStorePath } from "./paths";
import { errCode } from "./utils";
import { initHasher, contentChecksum } from "./hashline/hasher";
import { HASH_STORE_VERSION } from "./constants";

type SqlParams = SqlValue[];

interface Prepared {
  get: (...params: SqlParams) => Record<string, SqlValue> | undefined;
  allPaths: (...params: SqlParams) => Record<string, SqlValue>[];
  deleteOne: (...params: SqlParams) => void;
  upsert: (...params: SqlParams) => void;
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

let cachedStore: { path: string; store: HashStore; filePath: string } | null = null;

let sqlJsInit: Promise<void> | null = null;
let DatabaseCtor!: new (data?: ArrayLike<number> | null) => DatabaseType;

function makeGetter(db: DatabaseType, sql: string) {
  return (...params: SqlParams) => {
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    let result: Record<string, SqlValue> | undefined;
    if (stmt.step()) {
      result = stmt.getAsObject() as Record<string, SqlValue>;
    }
    stmt.free();
    return result;
  };
}

function makeAll(db: DatabaseType, sql: string) {
  return (...params: SqlParams) => {
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const results: Record<string, SqlValue>[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as Record<string, SqlValue>);
    }
    stmt.free();
    return results;
  };
}

function makeRun(db: DatabaseType, sql: string) {
  return (...params: SqlParams) => {
    if (params.length > 0) {
      db.run(sql, params);
    } else {
      db.run(sql);
    }
  };
}

function saveDb(storePath: string, db: DatabaseType): void {
  const data = db.export();
  writeFileSync(storePath, Buffer.from(data));
}

function openDatabase(storePath: string): HashStore {
  let db: DatabaseType;
  if (existsSync(storePath)) {
    const fileBuffer = readFileSync(storePath);
    db = new DatabaseCtor(new Uint8Array(fileBuffer));
  } else {
    db = new DatabaseCtor();
  }

  db.run(
    "CREATE TABLE IF NOT EXISTS snapshots (" +
      "path TEXT PRIMARY KEY, " +
      "checksum TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
    ")"
  );
  saveDb(storePath, db);

  const get = makeGetter(db, "SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?");
  const allPaths = makeAll(db, "SELECT path FROM snapshots");
  const deleteOne = makeRun(db, "DELETE FROM snapshots WHERE path = ?");
  const upsert = makeRun(
    db,
    "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, updated_at = excluded.updated_at"
  );

  const stmts: Prepared = { get, allPaths, deleteOne, upsert };
  return { db, stmts };
}

function withTransaction(db: DatabaseType, fn: () => void): void {
  db.run("BEGIN IMMEDIATE");
  try {
    fn();
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

async function migrateLegacy(store: HashStore, storePath: string): Promise<void> {
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
    rows.push([
      key,
      contentChecksum(value.content),
      value.content.split("\n").length,
      JSON.stringify(value.hashes),
      Date.now(),
    ]);
  }

  if (rows.length > 0) {
    withTransaction(store.db, () => {
      const stmt = store.db.prepare(
        "INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (const row of rows) {
        stmt.run(row);
      }
      stmt.free();
    });
    saveDb(storePath, store.db);
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

  if (!sqlJsInit) {
    sqlJsInit = initSqlJs().then((SQL) => {
      DatabaseCtor = SQL.Database;
    });
  }
  await sqlJsInit;

  const existed = existsSync(storePath);
  const store = openDatabase(storePath);
  if (!existed) {
    await migrateLegacy(store, storePath);
  }

  cachedStore = { path: storePath, store, filePath: storePath };
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
  const row = store.stmts.get(path, checksum, lineCount);
  return row ? (JSON.parse(row.hashes as string) as string[]) : undefined;
}

export function upsertSnapshot(
  store: HashStore,
  path: string,
  checksum: string,
  lineCount: number,
  hashes: string[],
): void {
  const hashesJson = JSON.stringify(hashes);
  withTransaction(store.db, () => {
    store.stmts.upsert(path, checksum, lineCount, hashesJson, Date.now());
  });
  if (cachedStore) saveDb(cachedStore.filePath, store.db);
}

export function deleteSnapshot(store: HashStore, path: string): void {
  withTransaction(store.db, () => {
    store.stmts.deleteOne(path);
  });
  if (cachedStore) saveDb(cachedStore.filePath, store.db);
}

export async function pruneMissing(store: HashStore): Promise<void> {
  const rows = store.stmts.allPaths() as { path: string }[];
  const missing: string[] = [];
  for (const row of rows) {
    try {
      await stat(row.path);
    } catch {
      missing.push(row.path);
    }
  }
  if (missing.length === 0) return;
  withTransaction(store.db, () => {
    for (const path of missing) {
      store.stmts.deleteOne(path);
    }
  });
  if (cachedStore) saveDb(cachedStore.filePath, store.db);
}

export { HASH_STORE_VERSION };
