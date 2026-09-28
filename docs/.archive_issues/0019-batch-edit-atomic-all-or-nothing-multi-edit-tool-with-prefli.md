# batch_edit: atomic all-or-nothing multi-edit tool with preflight validation

> **Archived from pre-migration issue #19.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-13T08:40:48Z · state CLOSED · labels: ready-for-agent

## Body

# batch_edit — atomic multi-edit with preflight validation

## Problem Statement

A model that needs to change several ranges (same file or across files) issues several `edit` calls. Each call is individually atomic, but the sequence is not: edit 2 can fail after edit 1 applied, leaving the file half-migrated and the model to reconcile manually — and every call pays the full pipeline (read, verify, write, diff) plus per-call reasoning overhead. The tool now has the enabling machinery (served-state range verification, reject-and-serve, undo, atomic writes) to make multi-edit application safe; it is just not exposed as one atomic operation.

## Solution

A new `batch_edit` tool accepts an ordered list of edits (each item is exactly the `edit` shape: optional `path`, `remove_from`, `remove_to`, `replacement_text`). The tool preflights every item against current on-disk state (anchor resolution + served-state span verification) before applying anything; applies all items in memory per file (each verified against the evolving content, so disjoint same-file edits compose and overlapping ones fail closed); and writes each touched file exactly once. Any preflight failure, mid-chain verification failure, or same-file conflict aborts the whole batch with nothing written and reject-and-serve feedback for the failing items. On success the response carries one combined per-file diff with fresh anchors (rows count as serves), aggregated warnings, per-file drift notices, and one undo record per touched file so `undo_last_edit` reverts the batch's effect on that file.

## User Stories

1. As a model making several edits to one file, I want to submit them in one `batch_edit` call, so that I pay one roundtrip and get one coherent result.
2. As a model making edits across several files, I want to submit them in one `batch_edit` call, so that cross-file changes land together.
3. As a model submitting a batch where one item is invalid (stale anchor, ambiguous anchor, malformed fields), I want the whole batch rejected with nothing written, so that I never end up with partial edits.
4. As a model rejected for a failing item, I want that item's current range echoed as fresh served rows, so that I can retry without a read; passing items need no feedback because nothing was written.
5. As a model submitting overlapping edits to the same file in one batch, I want the batch rejected with the conflict named, so that I re-plan instead of editing blind.
6. As a model whose batch item fails served-state verification mid-chain (an interior changed since it was served), I want the batch aborted with nothing written and reject-and-serve feedback, so that I never overwrite unseen content.
7. As a model after a successful batch, I want one combined per-file diff with fresh anchors that count as serves, so that follow-up edits verify cleanly without re-reading.
8. As a model after a successful batch, I want `undo_last_edit` on a touched file to restore the pre-batch state of that file, so that the batch's effect is reversible.
9. As a model, I want per-item autocorrections to behave exactly as in single `edit` (prefix stripping, reversed-range swap, boundary-duplicate stripping), so that copy-paste slips are fixed consistently.
10. As a model, I want the batch result to carry drift notices for served territory outside the edited ranges, so that my context stays honest.
11. As a model, I want per-item errors to name the item index and path, so that I can fix the specific failing edit.
12. As a model, I want an all-or-nothing contract: either every non-noop item applied or none, so that I always know the file state is consistent.
13. As a model, I want noop items reported per file without failing the batch, and an all-noop batch to report "no changes made", so that idempotent batches are not errors.
14. As a model, I want `batch_edit` to require nothing from me beyond the same three fields per item, so that the tool owns verification (model–tool boundary).
15. As a model, I want single-`edit` behavior and guidance unchanged, so that existing flows keep working.
16. As a developer, I want batch items applied in order and each verified against the evolving content, so that disjoint same-file edits compose while overlap fails closed.
17. As a developer, I want the batch bounded by an item cap, so that the combined result stays within display budgets.
18. As a developer, I want each touched file written exactly once (not per edit), so that no partial state exists on disk even if a later write fails.
19. As a developer, I want undo records persisted for every touched file before any write, so that a mid-batch write failure is recoverable by restoring already-written files.
20. As a developer, I want a malformed envelope (empty array, non-array, item missing required fields, too many items) rejected with `[E_BAD_SHAPE]` before any file I/O, so that a bad request never touches a file.

## Implementation Decisions

- **New tool, not a schema extension**: `batch_edit` is a distinct tool; `edit` keeps its single-edit contract. One-tool-one-contract avoids ambiguity between single and batch shapes in one tool, and keeps `edit`'s TUI preview/render pipeline untouched.
- **Envelope**: `{ edits: [...] }` — required, non-empty array, capped at `BATCH_EDIT_MAX_ITEMS` (constant, e.g. 32). Each item validated with the shared single-edit validation (item shape `{ path?, remove_from, remove_to, replacement_text }`; `path` optional per item with the same missing-path resolution against the hash store, named in the error when ambiguous).
- **Preflight phase**: for every item, in order — resolve anchors and verify the served span against the current on-disk file. Any failure rejects the whole batch; the failing items' current ranges are echoed as fresh served rows (capped, reject-and-serve); passing items get no feedback because nothing was written and their anchors remain valid.
- **Application phase**: per file, apply items in order in memory (a content-transformation chain), running the served-span verification per item against the evolving content and the original served record. A mid-chain `[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]` / `[E_RANGE_UNVERIFIED]` or unresolved anchor aborts the batch before any write.
- **Same-file overlap**: no special-case overlap detection — the mid-chain verification catches it (the second item's range now contains post-first-edit content and fails as stale), and the rejection names the item.
- **Write phase**: per touched file, one atomic write preserving the original BOM and line endings, after persisting that file's undo record (original → final). If a write fails, restore already-written files from their undo records; the failing file's atomic write left it unchanged. All-or-nothing with existing primitives; the ADR-0001 TOCTOU caveat applies (best-effort span check, undo is the recovery).
- **Result**: per-file sections — diff with fresh anchors (`+HASH│` / `HASH│` / `-HASH│` rows), warnings, drift notice (once per episode per file), metrics (edits attempted, added/removed per file). Every served row is recorded; the `tool_result` handler gets a `batch_edit` branch recording serves per touched file (mirroring the `edit` diff-serve recording).
- **Noop items**: reported per file and do not fail the batch; an all-noop batch reports no changes; the noop-loop guard counts per payload per file (composes with the noop-loop-guard work).
- **Guidelines**: `edit` guidance updated to point multi-edit work at `batch_edit`; the README "do not issue multiple edit calls on the same file in one message" note becomes "use `batch_edit` for multiple edits" (the combined per-file diff keeps attention on one result).
- **Reuse**: the batch orchestrates the existing single-edit pipeline module per item (preflight reuses the same validation/verify path; application reuses the same in-memory apply path; writes reuse the atomic-write + undo path).

## Testing Decisions

- **Primary seam**: the tool-execution integration seam (`setupIntegrationTest` + `withTempFile`) — drive `batch_edit` through the tool-execution seam against real temp files; assert on result text / error text / final file state:
  - happy path: disjoint same-file ranges, cross-file batch, single-file single-item (parity with `edit`);
  - all-or-nothing: one stale-anchor item → nothing written anywhere, error names the item, echoed rows serve cleanly;
  - mid-chain overlap conflict rejected with nothing written;
  - noop item reported without failing; all-noop batch reports no changes;
  - malformed envelope `[E_BAD_SHAPE]` (empty array, non-array, missing fields, over cap) touches no file;
  - per-item missing-path resolution; per-item autocorrections behave as single edit;
  - drift notice per file on a successful batch.
- **Handler seam**: `tool_result` handler records per-file batch diff serves (pattern of `served-rows-handler.test.ts` / `auto-read-handler.test.ts`); chained `edit` after a batch verifies cleanly on diff rows.
- **Store seam**: one undo record per touched file; `undo_last_edit` after a batch restores pre-batch content (extend `test/tools/replace-undo.test.ts` patterns).
- **Prior art**: `test/tools/replace-tool.test.ts`, `test/tools/edit.test.ts`, `test/tools/replace-validation.test.ts`, `test/tools/served-rows-handler.test.ts`, `test/tools/edit.missing-path.test.ts`.

## Out of Scope

- Concurrent multi-agent writers on the same file (worktree-level concern, unchanged).
- TOCTOU elimination / stronger atomicity (best-effort by design, ADR-0001).
- TUI preview parity for `batch_edit` (result text is the contract; rendering reuses the per-file result builder).
- Retry-scheduling logic (which items to resubmit) — the model decides from the reject-and-serve feedback.
- A `batch_edit` for `write`-style whole-file rewrites.

## Further Notes

- Implements `docs/absorption-plan.md` deferred item 4 ("validate ALL edits before ANY write; enabled by interior verification") — the enabling served-state verification now exists (ADR-0001, issues #1–#17).
- Uses the domain vocabulary: *serve, served state, served span, range staleness, reject-and-serve, drift, drift notice, model–tool boundary, anchor philosophy, range*.


## Comments

### @Rianico — 2026-08-13T09:19:33Z

Implemented and verified. New `batch_edit` tool: `src/batch-edit.ts` (envelope { edits: [...] }, cap 32, all-or-nothing preflight/apply in memory, one atomic write per file, undo records before writes with restore-on-write-failure, per-file combined diff + warnings + drift notices, `[E_BATCH_ABORT]` with reject-and-serve echo), `src/noop-guard.ts` (shared per-path noop-loop tracker used by both edit and batch), `src/edit-response.ts` (buildBatchResult + servedByPath), `index.ts` (registration + tool_result branch recording per-file diff serves), prompts (batch-edit.md/snippet/guidelines), README (batch_edit section + `[E_BATCH_ABORT]`/`[E_NOOP_LOOP]` error rows, guidance amended to 'use batch_edit'), register test updated. Tests: `test/tools/batch-edit.test.ts` (14), `batch-edit-handler.test.ts` (2), `batch-edit-undo.test.ts` (1).

Review fix applied post-worker: the abort path now uses `error.servedRows` (single-edit reject-and-serve behavior) before falling back to its own range echo, so a stale *boundary* anchor also serves the current range as recorded rows instead of 'call read'; new regression test covers it. Spec deviations: first-failing-item abort (vs echoing all failing items — nothing written either way; the contract 'all validated before any write' holds), and preflight is folded into the in-memory apply chain (writes still happen only after every item verified).

Verified: `npm run typecheck` ✓, `npm run lint` ✓, `npm test` 964 passed / 1 pre-existing skip ✓.

### @Rianico — 2026-08-13T09:19:35Z

Implemented, verified, closing.
