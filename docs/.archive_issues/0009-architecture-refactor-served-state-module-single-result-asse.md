# Architecture refactor: served-state module + single result assembly (spec)

> **Archived from pre-migration issue #9.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-12T06:09:44Z · state CLOSED · labels: ready-for-agent

## Body

## Problem Statement

The served-state verification feature works, but its architecture makes the domain's central verb — **serve** (delivering a line's `HASH│content` row into the model's context) — a scattered habit instead of a module. Five call sites across four modules independently re-implement "open the store, record the rows, tolerate failure", and two policies already disagree: `read` serves at execute-time and clears the drift-reported set, while the edit diff serves at tool_result-time and never clears it. Separately, the model-facing result of an edit is assembled twice: the response module builds the full text (success line, summary, drift notice), then the tool_result handler discards it and rebuilds from `details` — recovering warnings by string-parsing the rendered text, even though warnings already exist as structured data.

Consequences: every new serve surface (a new reject code, a new tool that shows rows) re-implements the habit a sixth time; the result text's wording is a hidden contract for warning extraction; and the core serve/drift policy is only testable through heavy fake-pi harness setups.

## Solution

Introduce **one served-state module** — the mirror of what the model saw — through which every serve flows: `load(path)`, `record(path, rows)`, `clearReported(path)`, `wipe()`, plus the served-span reconstruction ("where was this hash served, and where is it now?"). The four serve sites shrink to `record(path, rows)` calls. Move post-edit result assembly into **one pure function** in the response-assembly module, with warnings carried in `details` as structured data. The tool_result handler becomes a thin adapter.

Zero observable behavior change: rejection codes, echo content, drift notices, and auto-read diffs stay identical. The suite and eval battery are the proof.

## User Stories

1. As the model using the extension, I want edits that verify their range against served state to behave exactly as they do today (same reject codes, same echo rows, same drift notices), so that this refactor never changes what I can do.
2. As the model using the extension, I want auto-read post-edit diffs to show exactly the same content as today, so that follow-up edits keep verifying without a re-read.
3. As the model using the extension, I want read, edit, and undo_last_edit to serve the same rows at the same moments as today, so that my knowledge of the file stays in sync.
4. As a developer adding a new serve surface (a new reject code, a new tool that shows file rows), I want one `record(path, rows)` call to record serves, so that I don't re-implement store-open + record + tolerate at a sixth site.
5. As a developer, I want the serve timing policy (read at execute-time, edit diff at tool_result-time) and the reported-set clearing policy (read clears; rejection echoes and drift rows don't) to live in one documented place, so that the two current inconsistencies stop being a silent footgun.
6. As a developer, I want the served-span reconstruction (positions of a hash in served state; where a drifted line sits now) implemented once, so that verification and drift can't drift apart in their answers.
7. As a developer, I want the post-edit result the model sees to be assembled once by a pure function, so that "what does the model see after an edit" is answerable from one module.
8. As a developer, I want warnings to flow through `details` as structured data, so that the result text's wording is no longer a hidden contract parsed back out of the rendered string.
9. As a test maintainer, I want the serve-recording policy and the result assembly unit-testable at the module seam, so that I don't need a 40-line fake-pi harness to assert core policy.
10. As a test maintainer, I want the existing integration/tool tests and the eval battery to stay green unchanged in observable behavior, so that the refactor is provably behavior-preserving.
11. As a reviewer, I want the refactor to land in a small number of vertical, verifiable slices, so that each slice's diff is reviewable on its own.
12. As a developer, I want the pure verification core (verifyServedRange, buildRangeEcho, fmtServedRows) to stay pure and unchanged, so that the model–tool boundary's fail-closed guarantees are untouched.

## Implementation Decisions

- **One served-state module** owns the mirror of what the model saw. Interface: `load(path)`, `record(path, rows)`, `clearReported(path)`, `wipe()`, plus the served-span reconstruction helpers. All four serve sites (`read`, the edit rejection echo, the drift scan, the tool_result handler's diff recording) call `record(path, rows)`.
- **Existing policies preserved as-is, but owned by the module**: serve timing (read = execute-time, edit diff = tool_result-time) and reported-set clearing (read clears; rejection echoes and drift rows don't). These are NOT unified — read's content *is* the preview, while edit's diff is only delivered when auto-read rebuilds the result — but the module documents the policy once, in one place.
- **Pure core stays pure**: the verification module keeps its value-taking `verifyServedRange`/`buildRangeEcho`/`fmtServedRows` untouched; the served-state module wraps it and owns the impure store side.
- **Served-span reconstruction lives in the module once**: the positions-of-hash scan and the neighbor-survival/current-position mapping (the drift fix for external positional shifts) are implemented in the served-state module and consumed by both verification and drift.
- **One result assembly**: `warnings: string[]` flows through `details`; the string-parsing warning recovery is deleted; a pure `finalizeResult(details)` in the response-assembly module produces the post-edit text (diff + warnings + drift notice); the tool_result handler becomes a thin adapter that calls it.
- **No `verifyRangeAndServe` pipeline seam in this pass**: `execPipeline` keeps its shape beyond the `record()` one-liners; the serve-side bookkeeping it would own is exactly what the served-state module absorbs. A future pass may add the full seam.

## Testing Decisions

- **Good test = external behavior.** The existing fake-pi harness integration/tool tests, the full suite, and the eval battery are the regression net: they must stay green with identical observable behavior (modulo import re-points). They are the proof this refactor changed nothing the model could notice.
- **The served-state module is tested at its own seam** (unit tests at the module boundary): `record` semantics (upsert, null handling), the reported-clearing policy, and the reconstruction helpers.
- **`finalizeResult` is tested like the existing response builders** (unit tests over pure functions).
- **Prior art**: the existing `test/core` unit tests for the served table, drift computation, and response builders show the established pattern for module-seam tests.

## Out of Scope

- Splitting the hash-store god module (DB lifecycle vs repositories) — no behavior change, pure churn; revisit only if a persistence-format change lands.
- The `verifyRangeAndServe` pipeline seam — future candidate; the module is its natural home.
- `details` type hygiene beyond carrying `warnings` (broader typed-contract cleanup).
- Any change to rejection codes, messages, echo content, drift notices, auto-read diffs, the eval battery, undo, or the read tool.
- Prompts, docs, README, CONTEXT.md, ADR-0001 — none change.

## Further Notes

- No conflict with ADR-0001; the refactor deepens the same model–tool boundary the ADR describes.
- The timing policy distinction (execute-time vs tool_result-time) is a deliberate preservation, not an oversight — unifying it would change when rows enter the model's context.
- The served-state module is the natural future home for the verifyRangeAndServe seam (the verify → echo-serve → drift chain the ADR already treats as one policy).

## Comments

### @Rianico — 2026-08-16T04:08:31Z

Implemented. Children #10 (T1 served-state module) and #11 (T2 single result assembly) are merged; served-state recording is consolidated in src/served-state.ts and result assembly is pure (finalizeToolResult). ADR-0001/0002 accepted.
