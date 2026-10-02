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
   undo state and must die and live with it) and its `raw_pre` text (the file's decoded bytes as
   found, never the canonical fold), and one `cut_intent(txn_id, target_path, direction,
   created_at)` row is written naming the transaction. `direction` is NULL for a forward cut and
   `"revert"` for an interrupted correlated undo; the rows that repair must delete with the
   transaction are named by `idx_file_undo_transaction_id`, so the correlation read stays
   indexed even though the intent scan is not (see Decision 3). After the last rename the intent
   row is deleted. Presence of an intent row therefore marks a half-applied transaction —
   forward or revert, the record itself says which.

3. **Repair on the next run.** `repairCutIntents` (`src/cut-repair.ts`) runs on every live
   `apply` (previews skip it). The read is honest about its index: the intent rows are listed by
   an ORDER BY over the UNINDEXED `created_at` — a handful of rows at most — while the member
   lookup per intent uses `idx_file_undo_transaction_id`. For each orphaned intent it compares
   each member file's BYTES on disk (one byte primitive, `readBytes` in `src/fs-write.ts`)
   against the row's candidate images: the PRE candidate is the row's `raw_pre` when present —
   the same bytes the crash/abort paths rest — and otherwise the canonical serialization
   (`bom + restoreEndings(text, ending)`), so pre-remediation rows stay resolvable; the POST
   candidate is always canonical. A textual oracle would read a mixed-endings member resting at
   its raw bytes as "neither" and leak that intent forever. Forward intents (`direction` NULL):
   - every member at POST → the transaction actually landed; the intent is stale → drop it,
     keep the undo rows (correlated undo stays available);
   - target at POST, some member at PRE → complete the cut: write POST to the members still at
     PRE (never the inverse — the insert is already durable, so finishing cannot lose bytes);
   - target at PRE → restore both: write each member's PRE candidate (raw when present);
   - the target's undo row is gone (a later ordinary edit re-anchored it — no evidence can
     re-create it) → drop the intent and write nothing: an intent that can no longer act must
     not accumulate;
   - any member at NEITHER (outside modification, or deleted) → touch nothing and KEEP the
     intent row: a repair that guesses would destroy user content that appeared after the crash.
   Revert intents (`direction` `"revert"`, from Decision 4) resolve against the same images:
   members still at POST are restored to their PRE candidate; every member already at PRE → the
   revert landed, delete the whole transaction's undo rows (`deleteUndoTransaction`) and drop
   the intent. Resolution re-validates the bytes it writes inside the same sorted mutation
   queues the transaction used. All resolutions are byte-only; the store re-materializes on the
   next read. No resolution loses content.

4. **Correlated undo is itself a durable transaction.** `undo_last_edit` on a file whose undo
   row carries a `transaction_id` reverts EVERY member of the transaction — never one file
   alone — using the same journal-and-repair machinery as the forward cut. Validation and
   preparation happen BEFORE any write: every member's bytes are compared to its POST candidate
   and every restore plan is computed in memory, so a stale or deleted member fails closed with
   the existing `E_UNDO_STALE` naming THAT member, with no write, no intent and NO undo row
   cleared — clearing one row of a correlated set would degrade a future undo into exactly the
   partial revert the contract forbids (this deviates deliberately from the single-file arm,
   which clears its own stale row because that row is the whole story). Once preparation
   succeeds, a revert intent (`cut_intent` with `direction: "revert"`) is written before the
   first rename; members are restored one rename at a time; an interruption inside the window
   is met by an inline COMPLETION over the members not yet restored (repair semantics, not a
   rollback — the already-restored members stay at PRE because finishing the revert cannot lose
   bytes). Only a defeated completion — a member that could not be written twice — refuses,
   with the typed `E_UNDO_REVERT_FAILED` naming that member; the undo rows and the revert intent
   stay intact and the next run's repair completes the revert. When every byte has landed the
   store re-materializes per member (deferred warnings are non-fatal) and exactly ONE
   `deleteUndoTransaction` clears the whole set, followed by the intent drop (a failed drop
   self-retires via the repair "every member at PRE" arm). An unexpected throw anywhere in the
   correlated path is wrapped into a `[MODEL] [E_UNKNOWN]` envelope — a raw non-`[MODEL]` escape
   would break the registry doctrine (ADR-0021 d4) and leave the model with no remedy. Reverts
   run under sorted multi-path queues (`src/mutation-queue.ts`) so two transactions touching the
   same files in swapped order cannot deadlock.

5. **Failure surface.** Byte-identity claims in this ADR ("VERBATIM pre-image", `raw_pre`) are
   true BY CONSTRUCTION: admission applies a round-trip guard — a file whose bytes do not
   round-trip a UTF-8 decode (invalid sequences replaced by U+FFFD on read) is refused with the
   typed `E_LOSSY_TEXT` before any mutation, naming that file. Such files stay READABLE (the
   read path keeps disclosing them); only the edit path refuses. Given the guard, `Buffer.from`
   of a decoded text reproduces the file's bytes, so a raw capture is verbatim rather than
   near-verbatim. Any refusal before the first rename leaves both files untouched and
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

## Ratifications (TICKET-04b remediation)

The review run `944b6142` (REWORK, 0 P1 / 3 P2 / 4 P3) landed the changes described above;
these deviations from the ticket's design notes are ratified here as the governing text. NOTE-04
itself is not on disk in this repository, so this section — not the note — is the record.

- **Correlated staleness no longer clears rows.** Where the pre-remediation text (and NOTE-04)
  described fail-closed validation that kept rows but performed the revert inline per member,
  the ratified design is Decision 4: preparation is pure, the revert is journaled, the rows are
  cleared exactly once via `deleteUndoTransaction` (NOTE-04 named it `deleteUndoByTransaction`)
  after the last byte lands, and a defeated completion is the only refusal — typed
  `E_UNDO_REVERT_FAILED`, rows and intent intact.
- **The intent is directional.** `cut_intent.direction` distinguishes a forward cut from an
  interrupted revert, so repair resolves by the record rather than by inference.
- **The byte oracle replaces the textual oracle.** Pre-remediation repair compared canonical
  text; ratified Decision 3 compares bytes with `raw_pre` precedence, which is what closes the
  mixed-endings intent leak.
- **`idx_file_undo_transaction_id` is ADDed, not waived**, and Decision 3's original claim of
  "one indexed SELECT" for the intent scan was false and is corrected: intents order by the
  unindexed `created_at`; only the per-transaction member lookup is indexed.
- **Admission refuses lossy files.** The `E_LOSSY_TEXT` round-trip guard (Decision 5) is new in
  the remediation; it is what makes every VERBATIM/`raw_pre` claim in this ADR true by
  construction.
- **Model-facing text follows the durability story.** The batch guideline in
  `src/payload-contract.ts` and its mirror `prompts/edit-guidelines.md` state the pre-rename
  validation guarantee and the cut's ordered-write/repair behaviour, not whole-call atomicity.

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
