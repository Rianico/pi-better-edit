# Diff and auto-read rows count as serves (chained edits)

> **Archived from pre-migration issue #5.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-11T07:41:18Z · state CLOSED · labels: ready-for-agent

## Body

## What to build

Post-edit **diff rows** for `replace` and `undo_last_replace` (delivered via the `tool_result` handler when auto-read is enabled) and **auto-read-after-write preview rows** are recorded as serves. Chained edits can therefore anchor follow-up edits on post-edit diff rows without re-reading, and those edits verify cleanly. With auto-read disabled, diff rows are not delivered and therefore not recorded; a follow-up edit spanning the model's own prior change recovers in exactly one reject-and-serve roundtrip. `undo_last_replace` itself keeps working unchanged (file-level `[E_UNDO_STALE]`) — this ticket is only the serve-recording side of its diff.

See `docs/spec/served-state-range-verification.md` (Implementation Decisions 2, 8; user stories 11, 17, 21; Testing Decisions — handler seam).

## Acceptance criteria

- [ ] With auto-read enabled: after `replace`, a follow-up edit anchored on the diff rows verifies cleanly without a `read`.
- [ ] `undo_last_replace` diff rows serve the restored hashes; undo behavior itself is unchanged (including `[E_UNDO_STALE]`).
- [ ] Auto-read-after-`write` preview rows count as serves.
- [ ] With auto-read disabled: diff rows are neither delivered nor recorded; a follow-up edit spanning the model's own change is rejected once and applies on the retry (one reject-and-serve roundtrip).
- [ ] Handler-seam tests follow the captured-handlers patterns used by the auto-read and lifecycle tests, including the auto-read-disabled non-serve case.

## Blocked by

- #3

## Blocked by

- #3


## Comments

### @Rianico — 2026-08-11T09:44:23Z

Implemented in commit `523f325`: `genDiff` now returns `servedRows` (emitted `+` and context rows at new-file positions; `-` rows and ellipsis-skipped lines excluded); `ReplaceDetails.servedRows` attached by replace and undo; `tool_result` handler records diff rows (replace/undo) and `preview.served` (write) when autoRead, never when disabled/noop. 7 new tests (handler seam + chained-edit behavior seam incl. auto-read-off one-roundtrip). Full suite 886/886, typecheck+lint clean.

### @Rianico — 2026-08-11T09:44:25Z

Closing: serve surfaces complete and verified.
