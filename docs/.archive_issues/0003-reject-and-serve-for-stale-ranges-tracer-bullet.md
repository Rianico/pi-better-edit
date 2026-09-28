# Reject-and-serve for stale ranges (tracer bullet)

> **Archived from pre-migration issue #3.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-11T07:41:13Z · state CLOSED · labels: ready-for-agent

## Body

## What to build

The core reject-and-serve loop, end to end. `read` output rows count as **serves**. `replace` then verifies its *entire resolved range* against served state before applying: locate the served positions of the two boundary hashes, require a contiguous fully-served **span** between them, and compare that served span line-for-line against the current resolved span. Any interior hash inequality is a hard `[E_RANGE_STALE]` rejection naming the first offending line, with the current range echoed back as fresh `HASH│content` rows — and those echoed rows count as serves, so the retry applies cleanly with no `read`. Out-of-range external changes (content and positional) are tolerated; a change-then-revert interior passes; single-line ranges pass with no interior overhead; the request schema is unchanged (still `path`, `remove_from`, `remove_to`, `replacement_text`); fresh sessions start with empty served state so no line is ever edited blind.

Also: surface the final resolved range from the apply path (after all autocorrection — reversed swap, prefix stripping, boundary-duplicate stripping) so the check runs on exactly the span that would be spliced; and `[E_STALE_ANCHOR]` context rows count as serves.

Replace the misleading stub test that claims "edit succeeds even when the file changed on disk between read and edit, as long as anchors still match" with a test that actually mutates the file on disk between the calls and asserts the intended outcome.

See `docs/spec/served-state-range-verification.md` (Implementation Decisions 2–4, 8; user stories 1–4, 6–8, 12–14; Testing Decisions) and `docs/adr/0001-served-state-range-verification.md`.

## Acceptance criteria

- [ ] Read, external interior mutation on disk, then `replace` → `[E_RANGE_STALE]` naming the first offending line; the file is left unchanged.
- [ ] The rejection echoes the current range as fresh `HASH│content` rows.
- [ ] Retrying with the echoed rows applies cleanly without calling `read`; reject-and-serve terminates rather than looping.
- [ ] An out-of-range change between read and edit — including one that shifts line positions (deletion/insertion above the range) — does not false-reject.
- [ ] A change-then-revert interior (`b → B → b` on disk) verifies successfully.
- [ ] A single-line `replace` behaves exactly as today.
- [ ] `[E_STALE_ANCHOR]` context rows count as serves for subsequent edits over that territory.
- [ ] Fresh-session start with empty served state is honored by the check (no cross-session allowance).
- [ ] The misleading stub test is replaced by one that mutates the file on disk between read and edit.
- [ ] All behavior driven through the tool-execution seam (`setupIntegrationTest` + `withTempFile`) with disk manipulation between calls; assert only result/error text and final file state.

## Blocked by

- #2

## Blocked by

- #2


## Comments

### @Rianico — 2026-08-11T08:56:36Z

Implemented in commit `60fdc7a`: `src/hashline/served.ts` (pure `verifyServedRange` + typed `ServedRejectionError`/`AnchorMismatchError` + echo builder), read serves in `fmtReadPreview`/read execute (precise: paged/oversized/truncated/empty-file), check injected into `applyEdit` after autocorrection, error-feedback serves recorded in `execPipeline` (skipped when noPersist), 9 existing test files updated to read-first, stub test replaced. Typecheck + lint clean; 8 new primary-seam tests; full suite 870/874 (4 known pre-existing environmental failures).

### @Rianico — 2026-08-11T08:56:38Z

Closing: reject-and-serve loop complete and verified.
