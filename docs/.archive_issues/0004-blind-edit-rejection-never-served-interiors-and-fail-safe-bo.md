# Blind-edit rejection: never-served interiors and fail-safe boundaries

> **Archived from pre-migration issue #4.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-11T07:41:15Z · state CLOSED · labels: ready-for-agent

## Body

## What to build

Complete the span check's remaining verdicts and harden its error feedback. A range whose interior contains positions with no served entry — lines the model was never shown (paged reads, truncated auto-read previews, disjoint diff hunks, auto-read-disabled chains) — is rejected with `[E_RANGE_UNSERVED]` naming the first unserved line, echoing the current range (echoed rows count as serves so the retry terminates). Soundness edges: an interior line changed externally to *another* content served elsewhere in the file (duplicate content) is still rejected; a boundary anchor served at multiple positions, or with no served position at all, fails safe rather than guessing. Rejection feedback for large ranges is capped (~150 lines) with a pagination hint past the cap.

See `docs/spec/served-state-range-verification.md` (Implementation Decisions 3–4; user stories 5, 9, 10, 19; Testing Decisions — the data-model edges are constructed via disk manipulation: paged read then span over unseen lines; duplicate-content change; duplicate-line file with one duplicate externally deleted).

## Acceptance criteria

- [ ] Paged read (`offset`/`limit`), then a `replace` whose range spans the unseen lines → `[E_RANGE_UNSERVED]` naming the first unserved line; retry after the echo applies.
- [ ] Interior changed to content served elsewhere in the file → still rejected (verification stays sound with repeated lines).
- [ ] Boundary hash served at multiple positions (duplicate lines, one externally de-duplicated) → fail-safe rejection, never a silent relocation.
- [ ] Missing served position for a boundary → fail-safe rejection.
- [ ] Large-range rejection feedback is capped with a pagination hint, not a context flood.
- [ ] All verdicts tested at the tool-execution seam with real disk mutation between calls; internal served-record contents are never asserted through tool tests.

## Blocked by

- #3

## Blocked by

- #3


## Comments

### @Rianico — 2026-08-11T09:14:55Z

Implemented in commit `f5dc18f`: `SERVED_ECHO_CAP=150` in constants; echo capped with pagination hint in `verifyServedRange` (shared by all three verdicts, `echoRows` holds only shown rows — shown=served); 5 new primary-seam edge tests (paged-read gap → `[E_RANGE_UNSERVED]`, duplicate-content soundness, served-side ambiguity → `[E_RANGE_UNVERIFIED]`, missing served position, cap+hint). Typecheck+lint clean; full suite 875/874+... full suite green except the 4 known environmental failures.

### @Rianico — 2026-08-11T09:14:56Z

Closing: edge cases complete and verified.
