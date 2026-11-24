import { restoreEndings, type LineEnding } from "./edit-diff.js";
import { readBytes, writeAtomic } from "./fs-write.js";
import { withSortedMutationQueues } from "./mutation-queue.js";
import { errCode } from "./utils.js";
import { loadHashStore, type HashStore } from "./hash-store.js";
import {
  deleteCutIntent,
  deleteUndoTransaction,
  getUndoTransaction,
  listCutIntents,
  type CutIntentDirection,
  type UndoRecord,
} from "./undo-store.js";
import { reportDiagnostic } from "./diagnostics.js";

/**
 * (ticket-04b section 2) Next-run repair for the foreign-cut transaction. NO filesystem atomicity is
 * claimed: the two renames leave a window, and a crash in it is resolved on the NEXT run from the
 * durable intent plus the correlated undo rows. FORWARD: target at POST → COMPLETE (still-PRE members
 * get post bytes); at PRE → RESTORE (POST members get pre bytes; the inverse ordering is unreachable).
 * All members PRE or POST → that state decides (all-POST drops the intent). ANY member outside both
 * (modified or missing) → touch nothing, keep the intent: an outside write must not be destroyed.
 * REVERT (04b-rem P2-1): POST members get pre bytes; all at PRE → clear the undo rows and the intent;
 * ANY outside both → touch nothing, keep both. (04b-rem P2-2) The oracle compares BYTES, never decoded
 * text: RAW pre-images are what abort/rollback arms rest, so a text oracle would read a mixed-ending
 * member as "other" and leak the intent; repair stays byte-only and never half-writes the store.
 */

type MemberRow = UndoRecord & { path: string };
type MemberState = "pre" | "post" | "other";

const VALID_ENDINGS = new Set<string>(["\n", "\r\n", "\r"]);

// Ref: docs/.archive_adrs/0028-correlated-multifile-cut-transaction-durability.md
function serialized(row: MemberRow, which: "pre" | "post"): string | undefined {
  const ending = which === "post" ? (row.effectiveEnding ?? row.ending) : row.ending;
  if (!VALID_ENDINGS.has(ending)) return undefined;
  const text = which === "pre" ? row.content : row.resultContent;
  return row.bom + restoreEndings(text, ending as LineEnding);
}

function candidateFor(row: MemberRow, which: "pre" | "post"): Buffer | undefined {
  if (which === "pre" && row.rawPre !== null && row.rawPre !== undefined) {
    return Buffer.from(row.rawPre, "utf-8");
  }
  const text = serialized(row, which);
  return text === undefined ? undefined : Buffer.from(text, "utf-8");
}

async function stateOf(row: MemberRow): Promise<MemberState> {
  let bytes: Buffer;
  try {
    bytes = await readBytes(row.path);
  } catch (error) {
    if (errCode(error) === "ENOENT") return "other";
    throw error;
  }
  const post = candidateFor(row, "post");
  if (post !== undefined && bytes.equals(post)) return "post";
  const pre = candidateFor(row, "pre");
  if (pre !== undefined && bytes.equals(pre)) return "pre";
  return "other";
}

/** Returns true when the resolution completed (bytes written or nothing to write) and the intent retired. */
async function applyResolution(
  store: HashStore,
  txnId: string,
  rows: MemberRow[],
  toWrite: MemberRow[],
  which: "pre" | "post",
): Promise<boolean> {
  return withSortedMutationQueues(
    rows.map((row) => row.path),
    async () => {
      for (const row of toWrite) {
        const now = await stateOf(row);
        const expected = which === "post" ? "pre" : "post";
        if (now !== expected) return false;
      }
      for (const row of toWrite) {
        const bytes = candidateFor(row, which);
        if (bytes === undefined) return false;
        await writeAtomic(row.path, bytes);
      }
      deleteCutIntent(store, txnId);
      return true;
    },
  );
}

async function repairOne(
  store: HashStore,
  txnId: string,
  targetPath: string,
  direction: CutIntentDirection,
): Promise<void> {
  const rows = getUndoTransaction(store, txnId);
  if (rows.length === 0) {
    deleteCutIntent(store, txnId);
    return;
  }
  const states = new Map<string, MemberState>();
  for (const row of rows) states.set(row.path, await stateOf(row));
  for (const state of states.values()) {
    if (state === "other") return;
  }

  if (direction === "revert") {
    const toWrite = rows.filter((row) => states.get(row.path) === "post");
    if (toWrite.length === 0) {
      deleteUndoTransaction(store, txnId);
      deleteCutIntent(store, txnId);
      return;
    }
    if (await applyResolution(store, txnId, rows, toWrite, "pre")) {
      deleteUndoTransaction(store, txnId);
    }
    return;
  }

  const targetRow = rows.find((row) => row.path === targetPath);
  if (targetRow === undefined) {
    deleteCutIntent(store, txnId);
    return;
  }
  if (states.get(targetRow.path) === "post") {
    await applyResolution(
      store,
      txnId,
      rows,
      rows.filter((row) => states.get(row.path) === "pre"),
      "post",
    );
  } else {
    await applyResolution(
      store,
      txnId,
      rows,
      rows.filter((row) => states.get(row.path) === "post"),
      "pre",
    );
  }
}

export async function repairCutIntents(store?: HashStore): Promise<void> {
  const resolved = store ?? (await loadHashStore());
  let intents: { txnId: string; targetPath: string; direction: CutIntentDirection }[];
  try {
    intents = listCutIntents(resolved);
  } catch (error) {
    reportDiagnostic("cut-repair", "[cut-repair] failed to list cut intents:", error);
    return;
  }
  for (const intent of intents) {
    try {
      await repairOne(resolved, intent.txnId, intent.targetPath, intent.direction);
    } catch (error) {
      reportDiagnostic("cut-repair", `[cut-repair] intent ${intent.txnId} left in place:`, error);
    }
  }
}
