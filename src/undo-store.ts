import { DatabaseSync } from "node:sqlite";
import {
  loadHashStore,
  onStoreOpen,
  withBusyRetry,
  getCached,
  ensureFileUndoSchema,
  type HashStore,
} from "./hash-store.js";
import { isValidHashList } from "./hashline/hash.js";

export interface UndoRecord {
  content: string;
  bom: string;
  ending: string;
  hashes: string[];
  resultContent: string;
  snapshotHash?: string | null;
  /**
   * (ticket-04b §4) The correlated multi-file cut transaction this row belongs to; `null` is an
   * ordinary single-file edit. Both files' rows of one cut share the same id, so undo of either
   * file can load and revert EVERY file of the transaction.
   */
  transactionId?: string | null;
}

export interface UndoStmts {
  undoUpsert: (
    path: string,
    content: string,
    bom: string,
    ending: string,
    hashes: string,
    resultContent: string,
    snapshotHash: string | null,
    transactionId: string | null,
    updatedAt: number,
  ) => void;
  undoGet: (path: string) => Record<string, unknown> | undefined;
  undoDelete: (path: string) => void;
  undoGetTransaction: (transactionId: string) => Record<string, unknown>[];
  intentUpsert: (txnId: string, targetPath: string, createdAt: number) => void;
  intentList: () => { txn_id: string; target_path: string }[];
  intentDelete: (txnId: string) => void;
}

const stmtsCache = new WeakMap<DatabaseSync, UndoStmts>();

export function undoStmts(db: DatabaseSync): UndoStmts {
  return getCached(db, stmtsCache, buildStmts);
}

function buildStmts(db: DatabaseSync): UndoStmts {
  const undoUpsertStmt = db.prepare(
    "INSERT INTO file_undo (path, content, bom, ending, hashes, result_content, snapshot_hash, transaction_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET content = excluded.content, bom = excluded.bom, ending = excluded.ending, hashes = excluded.hashes, result_content = excluded.result_content, snapshot_hash = excluded.snapshot_hash, transaction_id = excluded.transaction_id, updated_at = excluded.updated_at",
  );
  const undoGetStmt = db.prepare(
    "SELECT content, bom, ending, hashes, result_content, snapshot_hash, transaction_id FROM file_undo WHERE path = ?",
  );
  const undoDelStmt = db.prepare("DELETE FROM file_undo WHERE path = ?");
  const undoGetTransactionStmt = db.prepare(
    "SELECT path, content, bom, ending, hashes, result_content, snapshot_hash, transaction_id FROM file_undo WHERE transaction_id = ? ORDER BY path",
  );
  const intentUpsertStmt = db.prepare(
    "INSERT INTO cut_intent (txn_id, target_path, created_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(txn_id) DO UPDATE SET target_path = excluded.target_path, created_at = excluded.created_at",
  );
  const intentListStmt = db.prepare(
    "SELECT txn_id, target_path FROM cut_intent ORDER BY created_at",
  );
  const intentDelStmt = db.prepare("DELETE FROM cut_intent WHERE txn_id = ?");
  return {
    undoUpsert: (
      path,
      content,
      bom,
      ending,
      hashes,
      resultContent,
      snapshotHash,
      transactionId,
      updatedAt,
    ) => {
      withBusyRetry(() => {
        undoUpsertStmt.run(
          path,
          content,
          bom,
          ending,
          hashes,
          resultContent,
          snapshotHash,
          transactionId,
          updatedAt,
        );
      });
    },
    undoGet: (...params) => undoGetStmt.get(...params) as Record<string, unknown> | undefined,
    undoDelete: (path) => {
      withBusyRetry(() => {
        undoDelStmt.run(path);
      });
    },
    undoGetTransaction: (transactionId) =>
      withBusyRetry(() => undoGetTransactionStmt.all(transactionId)) as unknown as Record<
        string,
        unknown
      >[],
    intentUpsert: (txnId, targetPath, createdAt) => {
      withBusyRetry(() => {
        intentUpsertStmt.run(txnId, targetPath, createdAt);
      });
    },
    intentList: () =>
      withBusyRetry(() => intentListStmt.all()) as unknown as {
        txn_id: string;
        target_path: string;
      }[],
    intentDelete: (txnId) => {
      withBusyRetry(() => {
        intentDelStmt.run(txnId);
      });
    },
  };
}

// WHY: the undo domain owns no DDL of its own — hash-store is the schema owner (spec §5.1).
onStoreOpen((db) => {
  ensureFileUndoSchema(db);
});

function parseUndoRow(row: Record<string, unknown> | undefined): UndoRecord | undefined {
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.hashes as string);
    if (!isValidHashList(parsed)) return undefined;
    return {
      content: row.content as string,
      bom: row.bom as string,
      ending: row.ending as string,
      hashes: parsed as string[],
      resultContent: row.result_content as string,
      snapshotHash: (row.snapshot_hash as string | null) ?? null,
      transactionId: (row.transaction_id as string | null) ?? null,
    };
  } catch {
    return undefined;
  }
}

export function upsertUndo(store: HashStore, path: string, entry: UndoRecord): void {
  undoStmts(store.db).undoUpsert(
    path,
    entry.content,
    entry.bom,
    entry.ending,
    JSON.stringify(entry.hashes),
    entry.resultContent,
    entry.snapshotHash ?? null,
    entry.transactionId ?? null,
    Date.now(),
  );
}

export function getUndoEntry(store: HashStore, path: string): UndoRecord | undefined {
  const row = undoStmts(store.db).undoGet(path);
  const parsed = parseUndoRow(row);
  if (!parsed) {
    if (row) undoStmts(store.db).undoDelete(path);
    return undefined;
  }
  return parsed;
}

/**
 * (ticket-04b §4) Every undo row of one correlated cut transaction, ordered by path. A row whose
 * hashes payload is corrupt is skipped defensively — the caller fails closed on a short set.
 */
export function getUndoTransaction(
  store: HashStore,
  transactionId: string,
): (UndoRecord & { path: string })[] {
  const out: (UndoRecord & { path: string })[] = [];
  for (const row of undoStmts(store.db).undoGetTransaction(transactionId)) {
    const parsed = parseUndoRow(row);
    if (parsed !== undefined && typeof row.path === "string") {
      out.push({ ...parsed, path: row.path });
    }
  }
  return out;
}

/** (ticket-04b §2) The durable intent record: written BEFORE the first rename of a cut. */
export function writeCutIntent(store: HashStore, txnId: string, targetPath: string): void {
  undoStmts(store.db).intentUpsert(txnId, targetPath, Date.now());
}

export function listCutIntents(store: HashStore): { txnId: string; targetPath: string }[] {
  return undoStmts(store.db)
    .intentList()
    .map((row) => ({ txnId: row.txn_id, targetPath: row.target_path }));
}

export function deleteCutIntent(store: HashStore, txnId: string): void {
  undoStmts(store.db).intentDelete(txnId);
}

export function deleteUndo(store: HashStore, path: string): void {
  undoStmts(store.db).undoDelete(path);
}

export async function readUndo(path: string): Promise<UndoRecord | undefined> {
  const store = await loadHashStore();
  return getUndoEntry(store, path);
}

export async function writeUndo(path: string, entry: UndoRecord): Promise<void> {
  const store = await loadHashStore();
  upsertUndo(store, path, entry);
}

export async function removeUndo(path: string): Promise<void> {
  const store = await loadHashStore();
  deleteUndo(store, path);
}

// WHY: (ticket-04b) the async wrappers mirror `readUndo`/`writeUndo`: the cut transaction's rows
// WHY: live in the same global store the undo domain already owns, so repair and the pipeline
// WHY: share one authority for intent and correlation.
export async function saveCutIntent(txnId: string, targetPath: string): Promise<void> {
  const store = await loadHashStore();
  writeCutIntent(store, txnId, targetPath);
}

export async function dropCutIntent(txnId: string): Promise<void> {
  const store = await loadHashStore();
  deleteCutIntent(store, txnId);
}

export async function listCutIntentsAsync(): Promise<{ txnId: string; targetPath: string }[]> {
  const store = await loadHashStore();
  return listCutIntents(store);
}

export async function readUndoTransaction(
  txnId: string,
): Promise<(UndoRecord & { path: string })[]> {
  const store = await loadHashStore();
  return getUndoTransaction(store, txnId);
}
