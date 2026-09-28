# Update compact payload prompts and validation documentation

> **Archived from pre-migration issue #35.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-17T08:42:19Z · state CLOSED · labels: documentation, ready-for-agent

## Body

Part of #32

## Scope

After the tuple implementations land, update model-facing prompt snippets/guidelines and contract-facing documentation so they describe only the compact JSON payload:

- `edit`: `[path, [remove_from, remove_to], replacement_text]`
- `batch_edit`: `{ "edits": [tuples] }`
- `null` path is fixed-position anchor-based inference.
- The range is inclusive; empty replacement deletes.
- Do not teach the old named-object shape or textual patch syntax.

Update tests that assert prompt terminology. Keep README, CONTEXT, ADR, and spec consistent. Run the full validation suite and report any unrelated working-tree changes without reverting them.


## Comments

### @Rianico — 2026-08-17T09:18:03Z

Implemented across commits `958d9d3`, `69fe48b`, and `c20ee2f`.

Prompts and README now describe only the tuple contract. A follow-up fix also restores post-edit diff serving for tuple inputs, including nullable-path edits.

Validation: focused served-row/chained-edit tests and full `npm test` (1000 passed, 1 skipped), typecheck, lint.

