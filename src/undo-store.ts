import { DatabaseSync } from "node:sqlite";
import {
  loadHashStore,
  onStoreOpen,
  withBusyRetry,
  getCached,
  type HashStore,
} from "./hash-store.js";
import { isValidHashList } from "./hashline/hash.js";

export interface UndoRecord {
  content: string;
  bom: string;
  ending: string;
  hashes: string[];
  resultContent: string;
}

export interface UndoStmts {
  undoUpsert: (
    path: string,
    content: string,
    bom: string,
    ending: string,
    hashes: string,
    resultContent: string,
    updatedAt: number,
  ) => void;
  undoGet: (path: string) => Record<string, unknown> | undefined;
  undoDelete: (path: string) => void;
}

const stmtsCache = new WeakMap<DatabaseSync, UndoStmts>();

export function undoStmts(db: DatabaseSync): UndoStmts {
  return getCached(db, stmtsCache, buildStmts);
}

function buildStmts(db: DatabaseSync): UndoStmts {
  const undoUpsertStmt = db.prepare(
    "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET content = excluded.content, bom = excluded.bom, ending = excluded.ending, hashes = excluded.hashes, result_content = excluded.result_content, updated_at = excluded.updated_at",
  );
  const undoGetStmt = db.prepare(
    "SELECT content, bom, ending, hashes, result_content FROM undo WHERE path = ?",
  );
  const undoDelStmt = db.prepare("DELETE FROM undo WHERE path = ?");
  return {
    undoUpsert: (path, content, bom, ending, hashes, resultContent, updatedAt) => {
      withBusyRetry(() => {
        undoUpsertStmt.run(
          path,
          content,
          bom,
          ending,
          hashes,
          resultContent,
          updatedAt,
        );
      });
    },
    undoGet: (...params) =>
      undoGetStmt.get(...params) as Record<string, unknown> | undefined,
    undoDelete: (path) => {
      withBusyRetry(() => {
        undoDelStmt.run(path);
      });
    },
  };
}


export function ensureUndoSchema(db: DatabaseSync): void {
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
}

onStoreOpen((db) => {
  ensureUndoSchema(db);
});

export function upsertUndo(
  store: HashStore,
  path: string,
  entry: UndoRecord,
): void {
  undoStmts(store.db).undoUpsert(
    path,
    entry.content,
    entry.bom,
    entry.ending,
    JSON.stringify(entry.hashes),
    entry.resultContent,
    Date.now(),
  );
}

export function getUndoEntry(
  store: HashStore,
  path: string,
): UndoRecord | undefined {
  const row = undoStmts(store.db).undoGet(path);
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.hashes as string);
    if (!isValidHashList(parsed)) {
      undoStmts(store.db).undoDelete(path);
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
    undoStmts(store.db).undoDelete(path);
    return undefined;
  }
}

export function deleteUndo(store: HashStore, path: string): void {
  undoStmts(store.db).undoDelete(path);
}

export async function readUndo(path: string): Promise<UndoRecord | undefined> {
  const store = await loadHashStore();
  return getUndoEntry(store, path);
}

export async function writeUndo(
  path: string,
  entry: UndoRecord,
): Promise<void> {
  const store = await loadHashStore();
  upsertUndo(store, path, entry);
}

export async function removeUndo(path: string): Promise<void> {
  const store = await loadHashStore();
  deleteUndo(store, path);
}
