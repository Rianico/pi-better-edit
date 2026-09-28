# Compact JSON edit payload contract

> **Archived from pre-migration issue #32.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-17T08:42:03Z · state CLOSED · labels: enhancement, ready-for-agent

## Body

## Spec

Implement the accepted compact JSON calling contract described in `docs/spec/compact-json-edit-payload.md` and ADR-0006.

The contract is:

- `edit`: `[path, [remove_from, remove_to], replacement_text]`
- `batch_edit`: `{ "edits": [ [path, [remove_from, remove_to], replacement_text] ] }`
- `path` is a non-empty string or `null` for existing anchor-based path inference.
- The two-anchor range is inclusive.
- Empty replacement text means deletion.

Preserve the existing model–tool boundary, served-state verification, reject-and-serve behavior, atomic batch writes, rollback, and persisted undo. Do not add tools, format configuration, digests, fuzzy matching, textual patch languages, block operations, registers, or file lifecycle operations.

Spec: `docs/spec/compact-json-edit-payload.md`
Decision: `docs/adr/0006-compact-json-edit-payload.md`


## Comments

### @Rianico — 2026-08-17T09:18:07Z

The accepted compact JSON contract is implemented and documented.

Commits:
- `958d9d3` — single `edit` tuple payload
- `69fe48b` — `batch_edit` tuple items
- `5c948dd` — spec, ADR, glossary, absorption plan, README
- `c20ee2f` — tuple diff-serve regression fix and documentation cleanup

The implementation keeps the existing served-state verification, reject-and-serve, atomic batch, rollback, and undo semantics. Unified diff and other textual patch languages remain deferred.

Validation: focused tests passed; full `npm test` passed (93 files: 1000 passed, 1 skipped); typecheck and lint passed.

