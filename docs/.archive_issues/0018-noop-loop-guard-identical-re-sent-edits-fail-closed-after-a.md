# Noop-loop guard: identical re-sent edits fail closed after a threshold

> **Archived from pre-migration issue #18.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-13T08:40:45Z · state CLOSED · labels: ready-for-agent

## Body

# Noop-loop guard for edit

## Problem Statement

A model that mis-tracks its own prior edits can re-send the exact same edit repeatedly. Each re-send that lands on already-replaced content returns a soft "No changes made" noop result, and nothing stops the model from looping forever — burning a tool call per iteration. The tool records `noopEditsCount` telemetry but has no behavioral response to a re-send loop.

## Solution

The edit pipeline tracks, per file, the most recent noop-producing payload (normalized absolute path + `remove_from` + `remove_to` + `replacement_text`). When the same payload produces a noop a threshold number of times consecutively, the tool hard-rejects with `[E_NOOP_LOOP]` and serves the current range back as fresh `HASH│content` rows, so the model can see the content is already as intended and stop retrying. Any intervening applied edit, or a noop from a different payload, resets the counter. Counters are session-scoped and in-memory.

## User Stories

1. As a model that accidentally re-sends an edit that already applied, I want the first re-send to return "No changes made", so that I can tell the edit is already in place.
2. As a model that re-sends the exact same edit a second time, I want a notice that this exact edit has repeatedly produced no changes, so that I stop retrying it.
3. As a model that re-sends the exact same edit a third time, I want a hard `[E_NOOP_LOOP]` rejection, so that I am forced to read and re-evaluate instead of looping.
4. As a model hitting the noop-loop rejection, I want the current range echoed as fresh served rows, so that I can see the content is already as I wanted without a separate read.
5. As a model making a genuine different edit to the same file, I want the loop counter to reset, so that a real edit never trips the guard.
6. As a model issuing a noop with a different payload, I want the counter to reset to that new payload, so that only true resends accumulate.
7. As a model editing different files, I want counters to be per-file, so that a loop in one file never affects another.
8. As a developer, I want the guard keyed on the exact submitted payload (path + anchors + replacement), so that only true resends trip it.
9. As a developer, I want previews (noPersist) to never touch the counters, so that typing/preview never triggers the guard.
10. As a model in a fresh session, I want counters to start empty, so that a previous session's loop cannot poison the new session.
11. As a developer, I want the threshold and error code to be constants, so that tuning is a one-line change.
12. As a model, I want the guard not to create undo records or touch the file, so that the noop path keeps its current file-safety guarantees.
13. As a model, I want the noop-loop rejection rows to count as serves, so that a follow-up edit on those rows verifies cleanly.

## Implementation Decisions

- **Identity**: the canonical payload is the normalized absolute path plus the three submitted fields, taken after `normReq` path normalization and missing-path resolution (a resolved-missing-path resend counts as identical to the explicit-path version). No autocorrections are applied to identity — the guard matches what the model actually submitted.
- **Counting**: per absolute path, `{ payload, count }`. A noop with the same payload increments; a noop with a different payload replaces the entry at count 1; a successful applied edit to that path clears the entry. Consecutive-identical semantics.
- **Threshold**: `NOOP_LOOP_THRESHOLD = 3` in the constants module. Noop 1 = current "No changes made" behavior; noop 2 = same message plus a warning that this exact edit has produced no changes twice; noop 3 = hard `[E_NOOP_LOOP]`.
- **Scope**: module-level in-memory map in the edit pipeline module; session-scoped — a fresh process starts empty. Not persisted: a previous session's loop must not poison a new session, consistent with the served-state session-scoping philosophy.
- **Previews**: `noPersist` runs must not read or mutate counters.
- **Error contract**: `[E_NOOP_LOOP]` on the 3rd identical noop, naming the file and anchors, echoing the current range as served rows (capped like reject-and-serve) so the model sees the content already matches. The echoed rows are recorded as serves via the existing echo-serve recording path.
- **Composition**: the guard applies to the same noop path in any future batch tool (noop items in a batch increment per payload per file).
- **Undo**: noop edits never write undo records (file unchanged); the guard does not alter that.

## Testing Decisions

- **Primary seam**: the tool-execution integration seam (`setupIntegrationTest` + `withTempFile`) — drive `edit` through the tool-execution seam against a real temp file; assert on result text / error text / final file state:
  - same identical payload 3× → 1st noop, 2nd noop with warning, 3rd hard `[E_NOOP_LOOP]` error with echoed rows;
  - a real applied edit in between resets the counter (identical noop after it is again a noop, not an error);
  - a different-payload noop resets the counter;
  - per-file isolation: loop in file A does not affect file B;
  - missing-path resend counts as identical to explicit-path (both forms of the same payload);
  - echoed rows from the rejection are usable anchors for a follow-up edit (verify cleanly).
- **Preview seam**: `compPreview` (or the preview tool path) never trips the guard.
- **Prior art**: `test/tools/edit.noop-warning.test.ts` (noop path), `test/tools/replace-validation.test.ts` (error contracts), `test/tools/served-rows-handler.test.ts` (echo-serve recording).

## Out of Scope

- Loop detection beyond identical payloads — different-payload noops are legitimate model exploration.
- Persisting counters across sessions.
- A noop-loop guard for `undo_last_edit` (undo has its own `[E_UNDO_STALE]` contract and no noop path).
- General "model is stuck" heuristics beyond exact resends.

## Further Notes

- Implements `docs/absorption-plan.md` deferred item 5 ("3 identical no-ops throw an error; `appliedPayloadTracker` detects re-sent payloads").
- Uses the domain vocabulary: *noop, served rows, reject-and-serve, anchor philosophy, model–tool boundary*.


## Comments

### @Rianico — 2026-08-13T08:54:20Z

Implemented and verified. Files: `src/constants.ts` (NOOP_LOOP_THRESHOLD=3), `src/edit.ts` (per-path payload tracker, count logic, [E_NOOP_LOOP] with reject-and-serve echo, applied-edit reset), `src/edit-response.ts` (noop text now surfaces warnings), README error-codes row, `test/tools/edit.noop-loop.test.ts` (7 tests); adapted two integration tests that previously sent unlimited identical noops. Verified: typecheck ✓, lint ✓, 947/947 tests ✓.

### @Rianico — 2026-08-13T09:19:38Z

Implemented, verified, closing.
