# Flatten batch_edit payload to a root tuple array

> **Archived from pre-migration issue #36.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-17T09:26:14Z · state CLOSED · labels: enhancement, ready-for-agent

## Body

## Scope

Change `batch_edit` from:

```json
{ "edits": [[path, [from, to], replacement]] }
```

to a root array:

```json
[
  ["src/a.ts", ["from", "to"], "replacement"]
]
```

Each item remains the existing fixed tuple `[path, [remove_from, remove_to], replacement_text]`.

Preserve all existing batch behavior: tuple validation, nullable-path inference, ordering, overlap checks, served-state verification, atomic writes, rollback, persisted undo, limits, reject-and-serve, and `[E_BATCH_ABORT]`.

Update batch prompts and public-seam tests. Update the compact payload spec, ADR, README, and absorption plan to remove the `edits` wrapper. No new tool or compatibility mode is needed.


## Comments

### @Rianico — 2026-08-17T09:35:05Z

Implemented in commit `cce3cef`.

`batch_edit` now accepts a root array directly:

```json
[
  ["src/a.ts", ["from", "to"], "replacement"]
]
```

The `edits` wrapper is rejected. Existing tuple validation, nullable-path inference, ordering, overlap checks, served-state verification, atomic writes, rollback, undo, limits, reject-and-serve, and batch abort behavior are preserved. Prompts, tests, README, spec, ADR, and absorption plan were updated.

Validation: full `npm test` (1000 passed, 1 skipped), typecheck, lint, and `git diff --check`.

