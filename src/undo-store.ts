import { DatabaseSync } from "node:sqlite";
import {
  loadHashStore,
  onStoreOpen,
  withBusyRetry,
  getCached,
  ensureFileUndoSchema,
  type HashStore,
} from "./hash-store.js";
import { ANCHOR_GENERATION, isValidHashList } from "./hashline/hash.js";

export interface UndoRecord {
  content: string;
  bom: string;
  ending: string;
  hashes: string[];
  resultContent: string;
  /**
   * The anchor generation the stored hashes were derived under. Absent (or 0) is a
   * pre-generation row: never adopted as current — the undo path re-derives instead.
   */
  anchorGeneration?: number | null;
  snapshotHash?: string | null;
  /**
   * (ticket-04b §4) The correlated multi-file cut transaction this row belongs to; `null` is an
   * ordinary single-file edit. Both files' rows of one cut share the same id, so undo of either
   * file can load and revert EVERY file of the transaction.
   */
  transactionId?: string | null;
  /**
   * (04b-rem P2-2/P2-3) The RAW pre-transaction text the file had before the first rename — not
   * the canonical fold. The admission round-trip guard makes re-encoding byte-identical, so a
   * rollback or repair writes `Buffer.from(rawPre, "utf-8")` and restores the exact bytes found.
   * `null` is a row from before this column, or an ordinary single-file edit.
   */
  rawPre?: string | null;
}

export type CutIntentDirection = "revert" | null;

export interface CutIntent {
  txnId: string;
  targetPath: string;
  direction: CutIntentDirection;
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
    rawPre: string | null,
    anchorGeneration: number,
    updatedAt: number,
  ) => void;
  undoGet: (path: string) => Record<string, unknown> | undefined;
  undoDelete: (path: string) => void;
  undoGetTransaction: (transactionId: string) => Record<string, unknown>[];
  undoDeleteTransaction: (transactionId: string) => void;
  intentUpsert: (
    txnId: string,
    targetPath: string,
    direction: CutIntentDirection,
    createdAt: number,
  ) => void;
  intentList: () => { txn_id: string; target_path: string; direction: string | null }[];
  intentDelete: (txnId: string) => void;
}

const stmtsCache = new WeakMap<DatabaseSync, UndoStmts>();

export function undoStmts(db: DatabaseSync): UndoStmts {
  return getCached(db, stmtsCache, buildStmts);
}

function buildStmts(db: DatabaseSync): UndoStmts {
  const undoUpsertStmt = db.prepare(
    "INSERT INTO file_undo (path, content, bom, ending, hashes, result_content, snapshot_hash, transaction_id, raw_pre, anchor_generation, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET content = excluded.content, bom = excluded.bom, ending = excluded.ending, hashes = excluded.hashes, result_content = excluded.result_content, snapshot_hash = excluded.snapshot_hash, transaction_id = excluded.transaction_id, raw_pre = excluded.raw_pre, anchor_generation = excluded.anchor_generation, updated_at = excluded.updated_at",
  );
  const undoGetStmt = db.prepare(
    "SELECT content, bom, ending, hashes, result_content, snapshot_hash, transaction_id, raw_pre, anchor_generation FROM file_undo WHERE path = ?",
  );
  const undoDelStmt = db.prepare("DELETE FROM file_undo WHERE path = ?");
  const undoGetTransactionStmt = db.prepare(
    "SELECT path, content, bom, ending, hashes, result_content, snapshot_hash, transaction_id, raw_pre, anchor_generation FROM file_undo WHERE transaction_id = ? ORDER BY path",
  );
  const undoDelTransactionStmt = db.prepare("DELETE FROM file_undo WHERE transaction_id = ?");
  const intentUpsertStmt = db.prepare(
    "INSERT INTO cut_intent (txn_id, target_path, direction, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(txn_id) DO UPDATE SET target_path = excluded.target_path, direction = excluded.direction, created_at = excluded.created_at",
  );
  const intentListStmt = db.prepare(
    "SELECT txn_id, target_path, direction FROM cut_intent ORDER BY created_at",
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
      rawPre,
      anchorGeneration,
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
          rawPre,
          anchorGeneration,
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
    undoDeleteTransaction: (transactionId) => {
      withBusyRetry(() => {
        undoDelTransactionStmt.run(transactionId);
      });
    },
    intentUpsert: (txnId, targetPath, direction, createdAt) => {
      withBusyRetry(() => {
        intentUpsertStmt.run(txnId, targetPath, direction, createdAt);
      });
    },
    intentList: () =>
      withBusyRetry(() => intentListStmt.all()) as unknown as {
        txn_id: string;
        target_path: string;
        direction: string | null;
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
      rawPre: (row.raw_pre as string | null) ?? null,
      anchorGeneration: (row.anchor_generation as number | null) ?? 0,
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
    entry.rawPre ?? null,
    ANCHOR_GENERATION,
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

/**
 * (04b-rem P2-1) Clear EVERY undo row of one transaction in a single statement. The correlated
 * revert must not clear rows per member as it goes: a mid-loop failure that left rows behind
 * degraded the retry into "No undo history" for the file already reverted. One clear lands only
 * after the last write committed, so a defeated revert keeps the whole row set for repair.
 */
export function deleteUndoTransaction(store: HashStore, transactionId: string): void {
  undoStmts(store.db).undoDeleteTransaction(transactionId);
}

/** (ticket-04b §2) The durable intent record: written BEFORE the first rename of a cut. */
export function writeCutIntent(
  store: HashStore,
  txnId: string,
  targetPath: string,
  direction: CutIntentDirection = null,
): void {
  undoStmts(store.db).intentUpsert(txnId, targetPath, direction, Date.now());
}

export function listCutIntents(store: HashStore): CutIntent[] {
  return undoStmts(store.db)
    .intentList()
    .map((row) => ({
      txnId: row.txn_id,
      targetPath: row.target_path,
      direction: row.direction === "revert" ? ("revert" as const) : null,
    }));
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
export async function saveCutIntent(
  txnId: string,
  targetPath: string,
  direction: CutIntentDirection = null,
): Promise<void> {
  const store = await loadHashStore();
  writeCutIntent(store, txnId, targetPath, direction);
}

export async function dropCutIntent(txnId: string): Promise<void> {
  const store = await loadHashStore();
  deleteCutIntent(store, txnId);
}

export async function listCutIntentsAsync(): Promise<CutIntent[]> {
  const store = await loadHashStore();
  return listCutIntents(store);
}

/** (04b-rem P2-1) The async mirror of `deleteUndoTransaction` for the undo domain. */
export async function clearUndoTransaction(txnId: string): Promise<void> {
  const store = await loadHashStore();
  deleteUndoTransaction(store, txnId);
}

export async function readUndoTransaction(
  txnId: string,
): Promise<(UndoRecord & { path: string })[]> {
  const store = await loadHashStore();
  return getUndoTransaction(store, txnId);
}
