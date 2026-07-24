import { readFileSync, writeFileSync, existsSync } from "fs";
import { readFile, rename, mkdir, stat } from "fs/promises";
import { hashStorePath, hashStoreDir, legacyHashStorePath } from "./paths";
import { errCode } from "./utils";
import { initHasher, contentChecksum } from "./hashline/hasher";
import { HASH_STORE_VERSION, HASH_STORE_BUSY_TIMEOUT } from "./constants";
import initSqlJs from "sql.js";

type SqlParams = (string | number)[];

interface Prepared {
  get: (...params: SqlParams) => Record<string, unknown> | undefined;
  allPaths: (...params: SqlParams) => Record<string, unknown>[];
  deleteOne: (...params: SqlParams) => void;
  upsert: (...params: SqlParams) => void;
}

export interface HashStore {
  readonly stmts: Prepared;
  readonly engine: "better-sqlite3" | "sql.js";
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



interface BackendHandle {
  store: HashStore;
  close: () => void;
  transact: (fn: () => void) => void;
  prepare: (sql: string) => { run: (...params: unknown[]) => void; free: () => void };
}

let cachedHandle: { path: string; handle: BackendHandle } | null = null;



let BetterDatabase: any = undefined;

async function tryLoadBetter(): Promise<boolean> {
  if (BetterDatabase !== undefined) return BetterDatabase !== null;
  try {
    const mod = await import("better-sqlite3");
    BetterDatabase = mod.default || mod;
    return true;
  } catch {
    BetterDatabase = null;
    return false;
  }
}

function openBetterDb(storePath: string): BackendHandle {
  const db = new BetterDatabase(storePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma(`busy_timeout = ${HASH_STORE_BUSY_TIMEOUT}`);
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

  return {
    store: { stmts, engine: "better-sqlite3" },
    close: () => { db.close(); },
    transact: (fn) => { db.transaction(fn).immediate(); },
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return { run: (...params) => stmt.run(...params), free: () => {} };
    },
  };
}



let SqlJsDatabase: any = null;
let sqlJsPromise: Promise<void> | null = null;

async function ensureSqlJs(): Promise<void> {
  if (sqlJsPromise) return sqlJsPromise;
  sqlJsPromise = initSqlJs().then((SQL) => { SqlJsDatabase = SQL.Database; });
  return sqlJsPromise;
}

function openSqlJsDb(storePath: string): BackendHandle {
  const data = existsSync(storePath) ? new Uint8Array(readFileSync(storePath)) : undefined;
  const db = new SqlJsDatabase(data);

  db.run(
    "CREATE TABLE IF NOT EXISTS snapshots (" +
      "path TEXT PRIMARY KEY, " +
      "checksum TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
    ")"
  );

  function save() {
    writeFileSync(storePath, Buffer.from(db.export()));
  }

  save();

  const stmts: Prepared = {
    get: (...params) => {
      const stmt = db.prepare("SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?");
      stmt.bind(params);
      let result: Record<string, unknown> | undefined;
      if (stmt.step()) result = stmt.getAsObject() as Record<string, unknown>;
      stmt.free();
      return result;
    },
    allPaths: (...params) => {
      const stmt = db.prepare("SELECT path FROM snapshots");
      if (params.length > 0) stmt.bind(params);
      const results: Record<string, unknown>[] = [];
      while (stmt.step()) results.push(stmt.getAsObject() as Record<string, unknown>);
      stmt.free();
      return results;
    },
    deleteOne: (...params) => {
      if (params.length > 0) db.run("DELETE FROM snapshots WHERE path = ?", params);
      else db.run("DELETE FROM snapshots WHERE path = ?");
    },
    upsert: (...params) => {
      db.run(
        "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, updated_at = excluded.updated_at",
        params
      );
    },
  };

  return {
    store: { stmts, engine: "sql.js" },
    close: () => { db.close(); },
    transact: (fn) => {
      db.run("BEGIN IMMEDIATE");
      try { fn(); db.run("COMMIT"); save(); } catch (e) { db.run("ROLLBACK"); throw e; }
    },
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => { stmt.bind(params); stmt.step(); stmt.reset(); },
        free: () => { stmt.free(); },
      };
    },
  };
}



let backendPromise: Promise<void> | null = null;

async function initBackend(): Promise<void> {
  if (backendPromise) return backendPromise;
  backendPromise = (async () => {
    const hasBetter = await tryLoadBetter();
    if (!hasBetter) await ensureSqlJs();
  })();
  return backendPromise;
}



export async function loadHashStore(): Promise<HashStore> {
  const storePath = hashStorePath();
  if (cachedHandle && cachedHandle.path === storePath) {
    return cachedHandle.handle.store;
  }

  shutdownHashStore();

  await initHasher();
  await mkdir(hashStoreDir(), { recursive: true });
  await initBackend();

  const existed = existsSync(storePath);

  let handle: BackendHandle;
  if (BetterDatabase) {
    handle = openBetterDb(storePath);
  } else {
    await ensureSqlJs();
    handle = openSqlJsDb(storePath);
  }

  if (!existed) {
    await migrateLegacy(handle);
  }

  cachedHandle = { path: storePath, handle };
  return handle.store;
}

export function shutdownHashStore(): void {
  if (cachedHandle) {
    cachedHandle.handle.close();
    cachedHandle = null;
  }
}



function withStore(store: HashStore, fn: () => void): void {
  const h = cachedHandle?.handle;
  if (h && h.store === store) {
    h.transact(fn);
  } else {
    fn();
  }
}

async function migrateLegacy(handle: BackendHandle): Promise<void> {
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
    handle.transact(() => {
      const stmt = handle.prepare(
        "INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (const row of rows) stmt.run(...row);
      stmt.free();
    });
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
  withStore(store, () => {
    store.stmts.upsert(path, checksum, lineCount, hashesJson, Date.now());
  });
}

export function deleteSnapshot(store: HashStore, path: string): void {
  withStore(store, () => {
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
  withStore(store, () => {
    for (const path of missing) store.stmts.deleteOne(path);
  });
}

export { HASH_STORE_VERSION };
