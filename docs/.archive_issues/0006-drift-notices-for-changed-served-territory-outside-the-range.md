# Drift notices for changed served territory outside the range

> **Archived from pre-migration issue #6.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-11T07:41:20Z · state CLOSED · labels: ready-for-agent

## Body

## What to build

**Drift notices** on `replace` results. After a successful `replace` — applied *and* noop, never `undo` — when served territory outside the resolved range has drifted (lines the model was shown whose content changed on disk), append an informational section with the current content of the drifted lines, capped like `read` output; the rows count as serves. The notice fires once per drift episode: reported drifted hashes are tracked, and a later `replace` finding only already-reported drift emits a one-line pointer instead of re-echoing rows — until a `read` re-serves the lines. The drift scan compares the *pre-edit* served record (outside the range) against the post-edit file, and must run before the diff-driven served-record update (or against a snapshot of the pre-update record). Drift inside the range is the check's own reject path, so the two never overlap.

See `docs/spec/served-state-range-verification.md` (Implementation Decision 5; user stories 15, 16, 18, 26).

## Acceptance criteria

- [ ] Applied `replace` with drift outside the range → notice shows the current content of the drifted lines; those rows verify cleanly in a follow-up edit (they count as serves).
- [ ] Noop `replace` also reports drift.
- [ ] Once per episode: a subsequent `replace` over already-reported drift emits a one-line pointer, not a re-echo.
- [ ] A `read` re-serves the drifted lines and resets the pointer behavior.
- [ ] Drift inside the range remains the reject path (no overlap with the notice).
- [ ] `undo_last_replace` results carry no drift notice.
- [ ] Behavior driven at the tool-execution seam with real disk mutation between calls.

## Blocked by

- #3

## Blocked by

- #3


## Comments

### @Rianico — 2026-08-11T10:15:28Z

Implemented in commit `e8f9f3d`: `src/drift.ts` (pure `computeDrift` + `scanDrift`), served `reported` column with ALTER migration, resolved-range exposure on both apply paths, notice wired into applied+noop results (text + `details.driftNotice`, appended after the diff by the `tool_result` handler), reported-set cleared by read. 15 drift tests + 8 store tests + 10 unit tests; full suite 910/910, typecheck+lint clean.

### @Rianico — 2026-08-11T10:15:30Z

Closing: drift notices complete and verified.
