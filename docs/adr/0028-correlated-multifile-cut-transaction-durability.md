# ADR-0028 — Durability and recovery of the correlated multi-file cut transaction

Date: 2026-10-02

## Status

accepted — required by TICKET-04b (`edit-op` lane). Governs the foreign-source `mode: "cut"`
introduced at the `text_ref` wire (ticket-04 admitted the shape; this ADR owns its durability).
Does not modify ADR-0007: `EditRequest.file` stays singular and multiple top-level targets remain
dropped by ADR-0007 — the second file of a cut is a side effect of one item, never a second
batch target.

## Context

A `text_ref` item naming another served file with `mode: "cut"` mutates TWO files in one call:
the request's file receives the span bytes at the target anchors, and the named file retires the
span. The engine writes files through `writeAtomic`, which is atomic PER PATH (temp file +
rename). Two files therefore mean two renames with a real crash window between them. **No
filesystem atomicity is claimed anywhere in this design** — `writeAtomic` cannot give it, and no
application-level scheme below pretends otherwise.

The honest requirement is three-part: after a crash in the window, the next run must converge to
a state that lost no content, the model must never be told half a transaction succeeded, and
undo must never revert one file of the pair alone.

## Decision

1. **Ordered commit — the spine.** The target insert is durably renamed BEFORE the destructive
   source retirement. A crash in the window then leaves the span bytes present at BOTH files —
   duplication, which repair and the model can both live with. The inverse ordering would leave
   the bytes at neither: data loss, unrecoverable by any intent record. Test `inside the window`
   in `test/tools/edit.foreign-cut-repair.test.ts` observes the seam state directly; an
   implementation that retired first fails there.

2. **Durable intent record.** Before the first rename, every member's `file_undo` row is saved
   with a shared `transaction_id` (a column on `file_undo`, not a new table — the rows are the
   undo state and must die and live with it), and one `cut_intent(txn_id, target_path,
   created_at)` row is written naming the transaction. After the last rename the intent row is
   deleted. Presence of an intent row therefore marks a half-applied transaction.

3. **Repair on the next run.** `repairCutIntents` (`src/cut-repair.ts`) runs on every live
   `apply` (one indexed SELECT; previews skip it). For each orphaned intent it compares each
   member file's bytes on disk against the row's pre- and post-serialization
   (`bom + restoreEndings(text, ending)` — the same canonical serializer as every write):
   - every member at POST → the transaction actually landed; the intent is stale → drop it,
     keep the undo rows (correlated undo stays available);
   - target at POST, some member at PRE → complete the cut: write POST to the members still at
     PRE (never the inverse — the insert is already durable, so finishing cannot lose bytes);
   - target at PRE → restore both: write PRE to every member;
   - any member at NEITHER (outside modification, or deleted) → touch nothing and KEEP the
     intent row: a repair that guesses would destroy user content that appeared after the crash.
     Resolution re-validates the bytes it writes inside the same sorted mutation queues the
     transaction used. All resolutions are byte-only; the store re-materializes on the next
     read. No resolution loses content.

4. **Correlated undo.** `undo_last_edit` on a file whose undo row carries a `transaction_id`
   reverts EVERY member of the transaction or fails closed with no partial revert: all members
   are validated first; a stale or deleted member fails the undo with the existing
   `E_UNDO_STALE` naming THAT member, and NO undo row of the transaction is cleared — clearing
   one row of a correlated set would degrade a future undo into exactly the partial revert the
   contract forbids (this deviates deliberately from the single-file arm, which clears its own
   stale row because that row is the whole story). Reverts run under sorted multi-path queues
   (`src/mutation-queue.ts`) so two transactions touching the same files in swapped order cannot
   deadlock.

5. **Failure surface.** Any refusal before the first rename leaves both files untouched and
   persists no undo rows (Option-A ruling from the rework: foreign failures carry ZERO undo
   rows; the response keeps `servedRows: []`, `servedBlock: ""`, and the headline names the
   `refFile`). A fault inside the window rolls each written file back to its VERBATIM pre-image
   — captured raw under the queue before the first rename, so a rollback is not a re-
   serialization — and drops the intent only when the rollback held; a rollback that did not
   hold leaves the intent for repair. A noop cut retires nothing. A `noPersist` preview shows
   the target-side insert only: the retirement lives in the commit path's second plan, and the
   preview writes neither file nor store row.

6. **Response surface.** The committed call answers with sections for BOTH files —
   `Successfully edited 2 file(s)`, per-path served-block sets, and a diff carrying
   `--- target ---` and `--- source ---` segments — so the model holds fresh anchors for the
   file it did not name. Batch span-disjointness is evaluated per file across both plans:
   overlapping retire spans in one source abort the whole call before any rename.

## Considered Options

- **Two renames + intent record (chosen).** Uses the only durable primitive the runtime gives
  (per-file rename), adds the minimal journal (one row, two paths) and a deterministic resolver.
  Honest window; every failure mode maps to a repair arm with a test.
- **A real write-ahead journal of byte images (rejected).** A journal that re-implements
  `file_undo` under another name: the undo rows already ARE full pre/post images with the
  transaction id; a second journal adds a consistency surface without shrinking the window —
  the renames are still two, and a journal that lands out of order needs its own repair.
- **Write-intent-then-apply with a staging copy per file (rejected).** Copying both files to
  staging and renaming twice narrows nothing: multi-file atomic swap does not exist on POSIX
  without a filesystem transaction, so the window persists while the cost (duplicated bytes,
  temp-dir coupling, mtime churn) lands on every cut.

## Consequences

- Cut durability is a REPAIR contract, not an atomicity contract: docs and response text must
  never say the two files are written atomically. The window is real and its crash states are
  enumerated and tested.
- `file_undo.transaction_id` is the correlation authority; vacuum pinning sees each member row
  per (path, snapshot_hash) — a transaction multiplies pinned rows, asserted against budget in
  `test/core/snapshot-vacuum.test.ts`.
- Foreign `mode: "cut"` is now a supported, admitted payload shape; the item-(iv) refusal is
  deleted in the same commit that lands this behaviour, with its replacement witnesses in
  `edit.foreign-cut.test.ts`, `edit.wire-contract.test.ts` and
  `mutation-engine.span-ref.test.ts`, and the guard-arm in
  `test/arch/terminology-foreign-source.test.ts` keeping the deletion falsifiable.
