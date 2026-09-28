# Arch C3: Serve recording after success leaves the tool_result handler — one recordDiffServes helper

> **Archived from pre-migration issue #23.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-15T03:47:39Z · state CLOSED · labels: ready-for-agent

## Body

Part of #20

Blocked by: C1 ticket (the serve-recording policy should land on a clean served-state surface; `recordEchoServes` is moving there in C1).

## Goal
Move successful-edit serve recording out of the session-level `tool_result` event handler in `index.ts` and into one tested helper. index.ts is the most-churned file in the repo (13 of the last 40 commits), and the truncation policy it embeds is currently untestable in isolation — the last truncation bug (commit 25ed5f0) was caught by the runtime edge eval, not by a unit test.

## Friction (why)
For successful edits the diff rows are recorded as serves in `index.ts`'s `tool_result` handler — three near-identical branches, each doing `resolveTarget(toCwd(...))`, computing `clearFrom = firstChangedLine - 1` (or 0), then `recordServedTruncated(sessionKey, path, rows, resultLineCount, clearFrom)` (or `recordServed` when no line count), with the same `console.error` catch:
1. `write` auto-read-after-write (records `preview.served`)
2. `batch_edit` via `details.servedByPath` loop
3. `edit` / `undo_last_edit` via `details.servedRows`

Meanwhile rejections are recorded inside the pipeline (`execPipeline`/`processFile` → `recordEchoServes` with a live/preview policy). The serve-recording policy for one tool is split by outcome across two modules, and the success-side decision logic lives in an event callback no unit test can reach.

## Solution
- One `recordDiffServes({ sessionKey, path, servedRows, resultLineCount, firstChangedLine })` helper (pure policy + persistence through served-state), unit-tested.
- The `tool_result` handler calls it once per path and shrinks to thin glue.
- Optionally route the pipeline's rejection recording through the same policy module so the split-by-outcome disappears.

## Files
`index.ts`, `src/edit-response.ts`, `src/edit-undo.ts`, `src/served-state.ts` / `src/served-store.ts` (helper placement), new test file (e.g. `test/core/serve-recording.test.ts`).

## Acceptance
- `test/tools/served-rows-handler.test.ts`, `test/tools/auto-read-handler.test.ts`, `test/integration/served-truncation-chained.test.ts`, `test/integration/diff-serve-chained.test.ts` pass.
- The three branches collapse to one helper call; truncation/clearFrom policy is a pure tested function.
- `npm run typecheck && npm run lint && npm test` green.

## Constraints
ADR-0001 holds: served rows count as serves; only the tool's own serves count. ADR-0002: session-keyed; do not change the TTL/GC behavior.


## Comments

### @Rianico — 2026-08-15T05:12:40Z

Done — merged to main as 394b9ad (wt merge, squash). recordDiffServes + planServeRecording in src/served-state.ts; three tool_result branches collapsed to one call; 8 new tests. Verified: typecheck, lint, 997 tests, coverage 93.7/92.9/92.8/88.5.
