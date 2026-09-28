# fix(edit): stop routing the write-surface prefix note to undo_last_edit

> **Archived from pre-migration issue #128.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-16T07:38:20Z · state CLOSED · labels: ready-for-agent, released

## Body

## Finding (review P1-1, plus a model-facing typo)

`buildServedWritePrefixNote` (`src/hashline/served-guard.ts`) tells the model:

> "If the prefix was unintended, run undo_last_edit and retry without the anchor."

But every successful `write` clears that path's undo history (`deps.clearUndo` in `src/lifecycle-hooks/index.ts`, documented in `prompts/undo-last-edit-guidelines.md`), so the advice is unactionable.

**Counterexample**: model writes `Ab3│new text` → write succeeds, note advises `undo_last_edit` → model calls it → `[MODEL] [E_NO_UNDO] No undo history available for doc.md`.

## Required behaviour

1. The **write** note must name the write-surface remedy only:
   `If the prefix was unintended, re-issue the write without the anchor prefix.`
2. The **edit** note (`buildServedEditPrefixNote`) keeps its `undo_last_edit` remedy — `edit` preserves undo history, so it is actionable there. Do not change it.
3. Same file, same concern: capitalize the refusal sentence in `buildServedEditMessage` and `buildServedWriteMessage` — `nothing was written.` → `Nothing was written.` (the glossary already uses the capitalized form).

## Tests (test-first)

- `test/core/served-prefix-note.test.ts`: the unit note test and the end-to-end case `write result content carries the note` both assert `toContain("undo_last_edit")` today; both must assert `not.toContain("undo_last_edit")` **and** `toContain("re-issue the write without the anchor prefix")`.
- **Do not** satisfy a red test by restoring the old advice.

## Invariants

- Model-facing text only: no byte-level or detection behaviour changes.
- Detection stays evidence-only, never shape-based (ADR-0009 revision).
- The edit-surface remedy and the `mode: "literal"` escape are untouched.


## Comments

### @github-actions — 2026-09-21T16:47:45Z

:tada: This issue has been resolved in version 2.0.0 :tada:

The release is available on [GitHub release](https://github.com/Rianico/pi-better-edit/releases/tag/v2.0.0)

Your **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:
