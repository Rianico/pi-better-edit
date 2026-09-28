# Implement compact tuple payload for edit

> **Archived from pre-migration issue #33.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-17T08:42:14Z · state CLOSED · labels: enhancement, ready-for-agent

## Body

Part of #32

## Scope

Implement the single `edit` tuple payload from `docs/spec/compact-json-edit-payload.md`:

`[path, [remove_from, remove_to], replacement_text]`

- `path` must be a non-empty string or JSON `null`.
- The range must be a fixed two-element tuple of inclusive anchor strings.
- Preserve `null` path resolution through the existing `resolveMissingPath` behavior.
- Normalize into the existing internal edit representation before execution.
- Reject the old named-object shape and malformed tuples before mutation.
- Preserve all existing verification, reject-and-serve, noop, undo, and response semantics.

## Tests

Add/update public tool-seam tests for valid tuples, nullable path, malformed arity/types, deletion, and rejection of the old object shape. Update only the single-edit prompt guidance needed by this contract.

## Constraints

Do not change `batch_edit` in this ticket except for shared contract exports required by both tickets. Do not add a new tool or a compatibility mode.


## Comments

### @Rianico — 2026-08-17T09:17:55Z

Implemented in commit `958d9d3`.

- `edit` now accepts `[path, [remove_from, remove_to], replacement_text]`.
- `null` path preserves anchor-based inference.
- Named-object payloads and malformed tuples reject before mutation.
- Existing verification, reject-and-serve, noop, undo, and response behavior preserved.

Validation: full `npm test` (1000 passed, 1 skipped), typecheck, lint.

