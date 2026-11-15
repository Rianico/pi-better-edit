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

// WHY: the serialization every COMMIT uses, through `writeAtomic` — never a third path; and a
// WHY: candidate for the comparison, never the comparison itself (see `candidateFor`).
// Ref: docs/.archive_adrs/0028-correlated-multifile-cut-transaction-durability.md
function serialized(row: MemberRow, which: "pre" | "post"): string | undefined {
  if (!VALID_ENDINGS.has(row.ending)) return undefined;
  const text = which === "pre" ? row.content : row.resultContent;
  return row.bom + restoreEndings(text, row.ending as LineEnding);
}

// WHY: (04b-rem P2-2) the PRE candidate is the row's RAW pre image: the admission round-trip
// WHY: guard proved decode/encode lossless, so those bytes are exactly what the file held before
// WHY: the first rename. NULL rawPre is a pre-remediation row and falls back to `serialized`.
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
      // WHY: re-validate under the queues — between the scan and the lock an outside writer may
      // WHY: have moved a member; a moved member means "other", which means touch nothing.
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
    // WHY: no evidence to resolve from: the rows were consumed (undo ran) or never landed.
    // WHY: Either way the intent can no longer describe a window — retire it.
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
      // WHY: the revert landed on every member (or the crash hit after the last write), so the
      // WHY: transaction is fully undone — a retry must read "No undo history", not a stale revert.
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
    // WHY: (04b-rem P3-5) the target's row was overwritten by a later edit, so the direction can no
    // WHY: longer be decided and nothing here re-creates the evidence — mirrored: retire, write nothing.
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
    // WHY: repair is best-effort durability cleanup — a store that will not answer the scan
    // WHY: leaves every intent in place for the next run; the edit that triggered it proceeds.
    reportDiagnostic("cut-repair", "[cut-repair] failed to list cut intents:", error);
    return;
  }
  for (const intent of intents) {
    try {
      await repairOne(resolved, intent.txnId, intent.targetPath, intent.direction);
    } catch (error) {
      // WHY: one unresolvable intent must not abort the scan or the triggering edit; the intent stays, which is exactly the "keep the question open" resolution.
      reportDiagnostic("cut-repair", `[cut-repair] intent ${intent.txnId} left in place:`, error);
    }
  }
}
