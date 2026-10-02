import { readFile } from "node:fs/promises";
import { restoreEndings, type LineEnding } from "./edit-diff.js";
import { writeAtomic } from "./fs-write.js";
import { withSortedMutationQueues } from "./mutation-queue.js";
import { errCode } from "./utils.js";
import { loadHashStore, type HashStore } from "./hash-store.js";
import {
  deleteCutIntent,
  getUndoTransaction,
  listCutIntents,
  type UndoRecord,
} from "./undo-store.js";

/**
 * (ticket-04b §2) Next-run repair for the foreign-cut transaction. NO filesystem atomicity is
 * claimed: the two renames leave a real window, and a crash inside it is resolved here — on the
 * NEXT run, from the durable intent record plus the correlated undo rows — with no content lost
 * in either resolution:
 *
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
 * Store materialization is deliberately byte-only: the next read re-materializes snapshots and
 * leases from the committed bytes (the repo's deferred-sync semantics), so repair can never
 * half-write the store.
 */

type MemberRow = UndoRecord & { path: string };
type MemberState = "pre" | "post" | "other";

const VALID_ENDINGS = new Set<string>(["\n", "\r\n", "\r"]);

// WHY: the same canonical serialization every write uses — `bom + restoreEndings(text,
// WHY: ending)` through `writeAtomic` — never a third path (ADR-0028 serializer rule).
function serialized(row: MemberRow, which: "pre" | "post"): string | undefined {
  if (!VALID_ENDINGS.has(row.ending)) return undefined;
  const text = which === "pre" ? row.content : row.resultContent;
  return row.bom + restoreEndings(text, row.ending as LineEnding);
}

async function stateOf(row: MemberRow): Promise<MemberState> {
  let raw: string;
  try {
    raw = await readFile(row.path, "utf-8");
  } catch (error) {
    if (errCode(error) === "ENOENT") return "other";
    throw error;
  }
  if (raw === serialized(row, "post")) return "post";
  if (raw === serialized(row, "pre")) return "pre";
  return "other";
}

async function applyResolution(
  store: HashStore,
  txnId: string,
  rows: MemberRow[],
  toWrite: MemberRow[],
  which: "pre" | "post",
): Promise<void> {
  await withSortedMutationQueues(
    rows.map((row) => row.path),
    async () => {
      // WHY: re-validate under the queues — between the scan and the lock an outside writer may
      // WHY: have moved a member; a moved member means "other", which means touch nothing.
      for (const row of toWrite) {
        const now = await stateOf(row);
        const expected = which === "post" ? "pre" : "post";
        if (now !== expected) return;
      }
      for (const row of toWrite) {
        const bytes = serialized(row, which);
        if (bytes === undefined) return;
        await writeAtomic(row.path, bytes);
      }
      deleteCutIntent(store, txnId);
    },
  );
}

async function repairOne(store: HashStore, txnId: string, targetPath: string): Promise<void> {
  const rows = getUndoTransaction(store, txnId);
  if (rows.length === 0) {
    // WHY: no evidence to resolve from: the rows were consumed (undo ran) or never landed.
    // WHY: Either way the intent can no longer describe a window — retire it.
    deleteCutIntent(store, txnId);
    return;
  }
  const targetRow = rows.find((row) => row.path === targetPath);
  if (targetRow === undefined) return;
  const states = new Map<string, MemberState>();
  for (const row of rows) states.set(row.path, await stateOf(row));
  for (const state of states.values()) {
    if (state === "other") return;
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
  let intents: { txnId: string; targetPath: string }[];
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
      await repairOne(resolved, intent.txnId, intent.targetPath);
    } catch (error) {
      // SAFETY: one unresolvable intent must not abort the scan or the triggering edit; the
      // SAFETY: intent stays, which is exactly the "keep the question open" resolution.
      console.error(`[cut-repair] intent ${intent.txnId} left in place:`, error);
    }
  }
}
