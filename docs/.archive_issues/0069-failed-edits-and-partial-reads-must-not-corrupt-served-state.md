# Failed edits and partial reads must not corrupt served state

> **Archived from pre-migration issue #69.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-04T15:18:36Z · state CLOSED · labels: ready-for-agent

## Body

## What to build

A rejected edit records no serves, and a partial read merges hashes without advancing snapshotId, tombstone, or the drift-reported set. Full reads keep exclusive ownership of epoch lifecycle (CONTEXT.md: epoch, tombstone).

Concrete repro: bad-payload edit (content used as anchors, e.g. [['findActivatingFile,', ...]]) followed by partial read (offset 1, limit 18) leaves the next edit reporting stale drift.

## Acceptance criteria

- [ ] Rejected/parse-failed edit performs zero serve writes (recordEcho skipped on pre-load failure path)
- [ ] Partial read merges window rows only; snapshotId, tombstone clear, and drift-reported clear happen on full reads alone
- [ ] Regression test: failed-edit plus partial-read sequence then edit is drift-free
- [ ] `npm test` and `tsc --noEmit` green

## Blocked by

None (can start immediately)

## Comments

### @Rianico — 2026-09-05T06:42:50Z

Opened PR #72 (fix/serve-lifecycle → main).
