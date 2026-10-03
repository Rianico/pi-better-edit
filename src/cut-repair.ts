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

/**
 * (ticket-04b section 2) Next-run repair for the foreign-cut transaction. NO filesystem atomicity
 * is claimed: the two renames leave a real window, and a crash inside it is resolved here — on
 * the NEXT run, from the durable intent record plus the correlated undo rows — with no content
 * lost in either resolution:
 *
 * FORWARD intent (a cut that crashed between its renames):
 *  - target at POST  → the crash landed the insert but not the destructive retirement: COMPLETE
 *    the cut by writing each still-PRE member its undo row's post bytes.
 *  - target at PRE   → the insert never committed: RESTORE by writing each POST member its undo
 *    row's pre bytes (the target at PRE is the undo already; the inverse ordering is
 *    unreachable by construction and collapses to a no-op here).
 *  - every member PRE or POST with a definitive state → that state decides (all-POST merely
 *    drops the intent — the crash hit the final intent-delete).
 *  - ANY member outside both (modified or missing) → touch nothing, keep the intent: repairing
 *    over an outside write would destroy content, and the intent keeps the question open.
 *
 * REVERT intent (04b-rem P2-1: a correlated UNDO whose writes failed partway):
 *  - members at POST are not yet reverted → complete the revert by writing them their pre
 *    bytes; members already at PRE stay.
 *  - every member at PRE → the revert landed: clear the transaction's undo rows and the intent.
 *  - ANY member outside both → touch nothing, keep both: same fail-closed rule as forward.
 *
 * (04b-rem P2-2) The state oracle compares BYTES, never decoded text: the abort/rollback arms
 * rest members at their RAW pre-images (never canonically folded), so a mixed-line-ending
 * member must be recognized from its raw bytes — a text oracle would read it as "other" and
 * the intent would leak forever. The rows carry the raw pre image precisely for this reason.
 *
 * Store materialization is deliberately byte-only: the next read re-materializes snapshots and
 * leases from the committed bytes (the repo's deferred-sync semantics), so repair can never
 * half-write the store.
 */

type MemberRow = UndoRecord & { path: string };
type MemberState = "pre" | "post" | "other";

const VALID_ENDINGS = new Set<string>(["\n", "\r\n", "\r"]);

// WHY: the same canonical serialization every COMMIT uses — `bom + restoreEndings(text,
// WHY: ending)` through `writeAtomic` — never a third path (ADR-0028 serializer rule). It is a
// WHY: candidate for the comparison, never the comparison itself: see `candidateFor`.
function serialized(row: MemberRow, which: "pre" | "post"): string | undefined {
  if (!VALID_ENDINGS.has(row.ending)) return undefined;
  const text = which === "pre" ? row.content : row.resultContent;
  return row.bom + restoreEndings(text, row.ending as LineEnding);
}

// WHY: (04b-rem P2-2) the PRE candidate is the row's RAW pre image when it carries one: the
// WHY: admission round-trip guard proved decode/encode lossless, so `Buffer.from(rawPre)` is
// WHY: exactly the bytes the file had before the first rename. NULL rawPre is a pre-remediation
// WHY: row and falls back to the canonical serialization.
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
      // WHY: the revert landed on every member (or the crash hit after the last write): the
      // WHY: rows describe a transaction that is now fully undone — retire BOTH the rows and
      // WHY: the intent, so a retry reads "No undo history" honestly, not a stale revert.
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
    // WHY: (04b-rem P3-5) the target's row was overwritten by a later edit: the direction can no
    // WHY: longer be decided and nothing here can re-create the evidence — the intent can only
    // WHY: ACCUMULATE. Mirror the `rows.length === 0` arm: retire it, write nothing.
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
    // SAFETY: repair is best-effort durability cleanup — a store that will not answer the scan
    // SAFETY: leaves every intent in place for the next run; the edit that triggered it proceeds.
    console.error("[cut-repair] failed to list cut intents:", error);
    return;
  }
  for (const intent of intents) {
    try {
      await repairOne(resolved, intent.txnId, intent.targetPath, intent.direction);
    } catch (error) {
      // SAFETY: one unresolvable intent must not abort the scan or the triggering edit; the
      // SAFETY: intent stays, which is exactly the "keep the question open" resolution.
      console.error(`[cut-repair] intent ${intent.txnId} left in place:`, error);
    }
  }
}
