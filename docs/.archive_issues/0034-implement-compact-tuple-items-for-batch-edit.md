# Implement compact tuple items for batch_edit

> **Archived from pre-migration issue #34.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-17T08:42:17Z · state CLOSED · labels: enhancement, ready-for-agent

## Body

Part of #32

## Scope

Implement compact tuple items for `batch_edit` from `docs/spec/compact-json-edit-payload.md`:

`{ "edits": [ [path, [remove_from, remove_to], replacement_text] ] }`

- Keep the top-level `edits` object and existing item count limit.
- Reuse the shared tuple contract from the single-edit implementation.
- Preserve item ordering, same-file sequencing, overlap checks, served-range verification, atomic preflight, rollback, persisted undo, and `[E_BATCH_ABORT]` behavior.
- Reject old named-object items and malformed tuples before any write.

## Tests

Add/update public batch tool-seam tests for valid tuples, nullable path, malformed items, old-shape rejection, ordering, atomic failure, and existing batch limits.

## Constraints

Do not add a new tool, compatibility mode, fuzzy matching, digest requirement, or textual patch parser.


## Comments

### @Rianico — 2026-08-17T09:17:58Z

Implemented in commit `69fe48b`.

- `batch_edit` now accepts `{ "edits": [tuple, ...] }`.
- Batch atomicity, ordering, overlap checks, served-state verification, rollback, undo, and limits are preserved.
- Named-object items reject before writes.

Validation: full `npm test` (1000 passed, 1 skipped), typecheck, lint.

