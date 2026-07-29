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
}

export interface HashStore {
  readonly stmts: Prepared;
  readonly engine: "node:sqlite";
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

let cachedDb: { path: string; db: DatabaseSync; stmts: Prepared } | null = null;

function openDb(storePath: string): { db: DatabaseSync; stmts: Prepared } {
  const db = new DatabaseSync(storePath, {
    timeout: HASH_STORE_BUSY_TIMEOUT,
    defensive: false,
  } as any);
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

  const getStmt = db.prepare("SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?");
  const allStmt = db.prepare("SELECT path FROM snapshots");
  const delStmt = db.prepare("DELETE FROM snapshots WHERE path = ?");
  const upsertStmt = db.prepare(
    "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, updated_at = excluded.updated_at"
  );

  const stmts: Prepared = {
    get: (...params) => getStmt.get(...params) as Record<string, unknown> | undefined,
    allPaths: (...params) => allStmt.all(...params) as Record<string, unknown>[],
    deleteOne: (...params) => { delStmt.run(...params); },
    upsert: (...params) => { upsertStmt.run(...params); },
  };

  return { db, stmts };
}

export async function loadHashStore(): Promise<HashStore> {
  const storePath = hashStorePath();
  if (cachedDb && cachedDb.path === storePath && cachedDb.db.isOpen) {
    return { stmts: cachedDb.stmts, engine: "node:sqlite" };
  }

  shutdownHashStore();

  await initHasher();
  await mkdir(hashStoreDir(), { recursive: true });

  const existed = existsSync(storePath);
  const { db, stmts } = openDb(storePath);

  if (!existed) {
    await migrateLegacy(db);
  }

  cachedDb = { path: storePath, db, stmts };
  return { stmts, engine: "node:sqlite" };
}

export function shutdownHashStore(): void {
  if (cachedDb) {
    cachedDb.db.close();
    cachedDb = null;
  }
}

function withStore(fn: () => void): void {
  if (cachedDb) {
    cachedDb.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      cachedDb.db.exec("COMMIT");
    } catch (e) {
      cachedDb.db.exec("ROLLBACK");
      throw e;
    }
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
  withStore(() => {
    store.stmts.upsert(path, checksum, lineCount, hashesJson, Date.now());
  });
}

export function deleteSnapshot(store: HashStore, path: string): void {
  withStore(() => {
    store.stmts.deleteOne(path);
  });
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
  withStore(() => {
    for (const path of missing) store.stmts.deleteOne(path);
  });
}

export { HASH_STORE_VERSION };
