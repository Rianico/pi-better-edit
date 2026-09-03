# Boundary-duplication auto-fix removal (pure edit)

## Problem Statement

`applyEdit` silently rewrites `replacement_text` when a replacement line equals a line outside the resolved range. Four helpers in `src/hashline/resolve.ts` implement this:

- `trailingDups` / `leadingDups` — byte `===` on 1-line boundaries (last line vs `fileLines[endLine]`, first line vs `fileLines[startLine-2]`).
- `firstNewAfterDups` / `lastNewBeforeDups` — `canon()` + `sectionIsUnique` on new-line runs duplicating a unique section after/before the range, via `findNewEdge`/`canonCounts`.

`valEdit` collects `boundaryDups`, `applyEdit` splices them from `content_lines` and re-runs `valEdit` before `verifyServed → resToSpan`. Consequence: `range = hash_bounds, replacement = replacement_text` is not pure. Minimal repro `a\nb\n` replace `a` with `a\nb` → expected `a\nb\nb\n` (3 lines) but tool produces `a\nb\n` (2 lines, stripped as trailing duplicate, then noop). Brace case `}` at boundary loses balance irreversibly. A loud duplicate in the post-edit diff is reversible (model fixes next turn); silent removal is not. This violates `model–tool boundary` and `pure edit`.

## Solution

Delete the auto-fix entirely. `valEdit → verifyServed → resToSpan` with no splice. Preserve `replacement_text` verbatim. A true duplicate stays loud in the diff/drift signal (user-facing) for the model to correct. No new error code (`E_BOUNDARY_DUP` considered and rejected — it keeps guessing). Fix, not breaking change: restores the documented pure-edit invariant; prior stripping was the bug.

## User Stories

1. As a model replacing `a` with `a\nb` where `b` already follows the range, I want `a\nb\nb\n` preserved, so intentional duplication is not eaten.
2. As a model pasting a block that ends with `}` matching the line after the range, I want the `}` kept, so brace balance never breaks silently.
3. As a model pasting a leading line that equals the line before the range, I want it kept, so `before();` is not stripped.
4. As a model inserting `export interface Foo {…}` where the same block exists uniquely after the range, I want all new lines kept — even with `canon()` uniqueness, the tool does not guess.
5. As a model that *did* paste a true duplicate, I want the duplicate visible in the post-edit diff, so I fix it next turn explicitly.
6. As a maintainer, I want `src/hashline/resolve.ts` to export only `valEdit/resEdit/strip*/swapReversedRanges/warnUnicodeEsc` with no `BDup/AutoFix/findNewEdge` surface, so the graded surface is narrow.

## Implementation Decisions

1. **Delete helpers** in `src/hashline/resolve.ts`: `trailingDups`, `leadingDups`, `firstNewAfterDups`, `lastNewBeforeDups`, `findNewEdge`, `canonCounts`, `sectionIsUnique`, `collectBoundaryDups`, types `BDup`/`AutoFix`, `boundaryDups` field on `valEdit` return, and the `canonLines` memo. `valEdit` returns `{ resolved, mismatches }` only.
2. **Delete splice** in `src/hashline/apply.ts`: remove `boundaryDups` handling, `AutoFix`/`BDup` imports, `correctedEdit` clone + `splice` + second `valEdit`, and `autoFixes` on the result. `valEdit → verifyServed → resToSpan` directly. `resToSpan`/`assemble` already handle the verbatim replacement.
3. **Narrow public surface** in `src/hashline/index.ts`: stop re-exporting `BDup`, `AutoFix`, `findNewEdge`. `mutation-engine/pipeline.ts` drops `removedAutoFixes`/`autoFixes` bookkeeping (metrics count `edit.content_lines.length` directly).
4. **No new code** — pure deletion. `prepareEdit` (`swapReversedRanges → stripBare → stripDiff`) and `verifyServedRange`/`findEditHashEcho` remain the only pre-splice steps.
5. **Fix semantics** — `fix(hashline): remove boundary-dup auto-fix` (patch), not `feat!`. Restores `pure edit` invariant documented in `CONTEXT.md`.

## Testing Decisions

- **Remove/update auto-fix tests**: `test/integration/boundary-dup-correction.test.ts` — rewrite expectations to *keep* duplicates (`a → a\nb` over `a` in `a\nb\n` now yields `a\nb\nb\n`; `FIRST-NEW-AFTER` block no longer stripped). Or delete and keep one regression for the pure case.
- **Keep hash-echo/bare-prefix only**: `test/core/hashline-apply-internals.test.ts`, `test/core/hashline.apply.test.ts` — drop `autoFixes` assertions, keep `E_BAD_ANCHOR`/`E_SERVED_ECHO` paths.
- **Rewrite fuzz**: `test/core/hashline-fuzz-autofix.test.ts` — delete `applyAutoFix` mirror and `findNewEdge` import; fuzz now asserts `expectedEditContent(lines,s,e,repl,…)` verbatim, no `fixed`/`fixes` delta. Retain hash-stability invariants.
- **Regression**: minimal `a/b` over `a` (3 lines) and brace case; multi-line runs all preserved. `npm run typecheck && npm test` green.

## Out of Scope

- `E_BOUNDARY_DUP` fail-closed mode (rejected — keeps guessing).
- Threshold `≥2` heuristic (rejected — even `}\n}` ambiguous).
- Tombstone / hash-allocation fix (`#31` `removedByContent`) — orthogonal, separate change.
- Drift-signal changes — duplicates remain visible via existing diff/drift notice.

## References

- `CONTEXT.md` — `model–tool boundary`, `pure edit`, `boundary duplication (historical)` .
- `src/hashline/resolve.ts:38-473` / `src/hashline/apply.ts:19,200,215,230-250` (pre-fix) .
- Handoff `/Users/zhengxk/development/ai/boundary-deps.md` (dsh `Rianico/dsh-better-edit#38/#31`, grill Q1-5, delete-all plan).
