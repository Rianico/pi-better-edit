# Architecture: reject-and-serve as a seam + per-domain store modules (spec)

> **Archived from pre-migration issue #12.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-12T09:28:40Z · state CLOSED · labels: ready-for-agent

## Body

## Problem Statement

The reject-and-serve invariant — the ADR's central consequence ("rejection feedback rows count as serves; without that, reject-and-serve would reject every retry") — is enforced at call sites, not by structure. `verifyServedRange` builds the echo rows and throws; the caller must remember to record them (`src/edit.ts:293`, gated on `noPersist`), and the same "rows that entered the model's context count as serves" rule is separately re-implemented in the drift scan, the post-edit diff recording, and the auto-read-after-write path. Delete one line and verification silently stops recording serves. Separately, the `details` contract between the tools and the handler is re-declared by every consumer (five inline casts in the handler; untyped construction in undo), so adding a field compiles everywhere and is re-declared by hand. And `hash-store.ts` is one file hosting four domains (DB lifecycle, snapshot index, served table + reported set, undo store): a served-schema change collides with undo and lifecycle changes in one diff, even though the callers and tests already cross per-domain seams.

## Solution

(A) Make the serve-recording rule structural: one `verifyRangeAndServe` seam that verifies and, on rejection, records the echo serves with the record policy passed in (live edit vs preview = two real adapters); a pure `finalizeToolResult(details)` returning `{ content, servedRows }` so the diff-serve invariant gets a direct seam; the `details` contract owned by one module and imported (no casts); the resolved range promoted to one geometry value consumed by verification and drift. (B) Split `hash-store.ts` into a DB-lifecycle module plus per-domain store modules (snapshot, served, undo), with the existing wrapper modules consuming the new seams. Zero observable behavior change; the suite and eval battery are the proof.

## User Stories

1. As the model using the extension, I want every serve surface (read rows, post-edit diffs, rejection echoes, drift rows) to behave exactly as today, so that this refactor never changes what I can do.
2. As a developer, I want the "rejection feedback rows count as serves" rule to live in the verification seam itself, so that forgetting to record echo serves is not possible at a call site.
3. As a developer, I want live edit and preview to be two explicit adapters over the same verification+record seam, so that the noPersist policy is one parameter, not scattered `if` checks.
4. As a developer, I want the post-edit diff serve-recording (content + servedRows) to be a pure function, so that the invariant is unit-testable without the fake-pi harness.
5. As a developer, I want the `details` contract defined once and imported by the handler, so that adding a field is a one-line change, not a five-cast re-declaration.
6. As a developer, I want the resolved range (start/end line, boundary hashes, delta) to be one geometry value from `applyEdit`, so that verification and drift stop reassembling it from three sources.
7. As a developer, I want the hash store split into per-domain modules (snapshot, served, undo) over a shared DB-lifecycle seam, so that a served-schema change no longer collides with undo or lifecycle changes in one diff.
8. As a developer, I want the undo store to be a seam shaped like the served store, so that the undo tool stops reaching into the raw store five times.
9. As a test maintainer, I want the serve-recording policy and the diff-serve invariant testable at the module seam, so that I do not need a fake-pi harness to assert core behavior.
10. As a test maintainer, I want the existing integration/tool tests and the eval battery to stay green unchanged in observable behavior, so that this refactor is provably behavior-preserving.
11. As a reviewer, I want the work to land in a small number of vertical, verifiable slices, so that each slice's diff is reviewable on its own.
12. As a future contributor, I want the codebase-design vocabulary honored (deep modules, deletion test, interface-as-test-surface), so that the next serve surface or store change is a one-place change.

## Implementation Decisions

- **`verifyRangeAndServe` seam**: one function that takes the served array, the resolved geometry, the current hashes/lines, and a record policy; verifies the span; on rejection records the echo rows (policy: live records, preview does not) and returns `{ rejected, echoRows }`; on success returns nothing extra. Live edit and preview are two real adapters over the same seam (two adapters = a real seam, not hypothetical).
- **`finalizeToolResult(details)`**: pure, in the response module, returns `{ content, servedRows }` for the post-edit diff path; the `tool_result` handler becomes a thin adapter that calls it and records the served rows. The write-branch auto-read pipeline stays in the handler (out of scope beyond the invariant).
- **Details contract**: `EditDetails` (and its consumers) live in one module; the handler imports the type instead of re-declaring it with casts; the undo tool builds its details through the same contract.
- **Range geometry**: `applyEdit` already returns `rangeStartLine`/`rangeEndLine`; promote that into one range value (start/end line, boundary hashes, delta) consumed by `verifyServedRange` args and `ComputeDriftInput` (reducing the ~10-field input).
- **Store split**: a DB-lifecycle module (open/migrate/quarantine/busy-retry/withStore) plus per-domain modules — snapshot-store, served-store (served table + reported set), undo-store — each owning its parse/validate/delete-corrupt logic; `served-state.ts` and `edit-undo.ts` consume the new seams; per-domain tests move with their modules. Pure split, no behavior change.
- **No `force`/model-asserted override** — ADR-0001 stands; this work only structuralizes the existing rule.

## Testing Decisions

- **Good test = external behavior.** The existing fake-pi harness tests, the full suite, and the eval battery are the regression net: they must stay green with identical observable behavior.
- **New seams tested directly**: `verifyRangeAndServe` (live adapter records echo serves; preview adapter does not; success records nothing), `finalizeToolResult` (pure content + servedRows), the geometry value, and the per-domain store modules (the existing per-domain store tests move with them).
- **Prior art**: `test/core/served-state.test.ts`, `test/core/drift.test.ts`, `test/core/edit-response.test.ts`, `test/core/served-store.test.ts`, `test/core/hash-store.test.ts`, `test/core/undo-store.test.ts`.

## Out of Scope

- Extracting the write-branch auto-read pipeline beyond the serve-recording invariant.
- Folding `undo` into `edit` (decision made and recorded).
- Any change to rejection codes, messages, echo content, drift notices, auto-read diffs, the eval battery, or prompts.
- Rewriting `docs/spec` or ADR-0001 beyond what is needed to record this structuralization.

## Further Notes

- No conflict with ADR-0001; this deepens the same model–tool boundary the ADR describes.
- The two-adapters rule (live vs preview) is what makes the `verifyRangeAndServe` seam real rather than hypothetical.
- The store split is the highest-churn, lowest-behavior-change slice — do it only as the second slice, after the seam work.

## Comments

### @Rianico — 2026-08-16T04:08:34Z

Implemented. Children #13 (T1 reject-and-serve as a seam — verifyRangeAndServe + pure finalizeToolResult + typed details) and #14 (T2 per-domain store modules over the shared DB-lifecycle seam) are merged. Echo serves are recorded via the seam and store modules are split per domain.
