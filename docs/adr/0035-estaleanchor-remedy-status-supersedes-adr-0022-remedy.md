# ADR-0035 — E_STALE_ANCHOR remedy is the rejection's status; supersedes ADR-0022's "no read is needed" remedy

Date: 2026-10-07

## Status

accepted — supersedes ADR-0022's `[E_STALE_ANCHOR]` remedy sentence (`Retry with the served rows; no read is needed.`) and nothing else in that record. ADR-0022's Decision is otherwise intact: the canon travels with the row that carries it, the process-global `hash → canon` map stays deleted, and `[E_STALE_RANGE]` still serves the current range as a fresh read. The replaced quote appears in ADR-0022's Context item 2 and is the remedy its Decision 3 keeps.

Amends [ADR-0022 — Served canons are file-scoped; `[E_STALE_RANGE]` serves a fresh read](0022-file-scoped-canons-and-fresh-read-stale-range.md)

## Context

ADR-0022's Context item 2 rejected the `(no read needed)` mandate on the correct ground — a rejection may not mandate what the tool cannot back — but the replacement it kept for `[E_STALE_ANCHOR]` still told the model what *not* to do. `remedy: "Retry with the served rows; no read is needed."` spent its second clause denying a read instead of stating the status of the range the model asked about, so the operator follow-up (commit `d486d5f`) replaced it lane-wide.

## Decision

**The `[E_STALE_ANCHOR]` remedy states the rejection's status, then the action.**

- OLD: `Retry with the served rows; no read is needed.`
- NEW: `The latest known status is in this rejection. Retry as it directs.`

Reason: `[E_STALE_ANCHOR]` has four construction sites and only one always attaches served state (`makeStaleAnchorRejection` in `src/hashline/served-verification.ts`). The other three — `src/mutation-engine/pipeline.ts`'s missing-hashes fallback and its two foreign-wrap arms — build the code with a headline and no `servedBlock`, and `staleAnchorFormat` then renders headline-only. Any remedy naming the `Current range` block is therefore false in three of the four sites. The NEW sentence is true in all four: the rejection itself carries the latest known status — the block when one is served, the headline otherwise (the missing-hashes arm directs a full re-read; the foreign arms name the file to read) — and "Retry as it directs" defers to that instruction instead of pre-committing to a retry the arms cannot all support. Sentence 1 is the fact and carries no positional reference, so render order is irrelevant; sentence 2 is the single imperative.

Where the supersede takes effect today: the registry field in `src/domain-errors.ts`, the `[E_STALE_ANCHOR]` Remedy cell in `README.md`, and the two `src/mutation-engine/pipeline.ts` WHY-comment quotes. `.remedy` is not rendered by any code path (ADR-0034 Consequences), so served text changes only if remedy rendering lands.

## Consequences

- `CodeSpec.remedy` stays `string`; the `[E_STALE_ANCHOR]` payload, format, audience and remedy-eligibility are unchanged. The format still renders `Current range:` with the served block when one is attached and headline-only otherwise; `test/arch/remedy-eligibility.test.ts` and `test/core/served-rejection-unification.test.ts` pin both.
- The `[E_STALE_ANCHOR]` format no longer interpolates `RETRY_HINT` (removed by the STE100 lane, #56); the retry affordance now lives in the remedy field alone.
- No old ADR body text is rewritten: ADR-0022 carries only the appended `Amended by` chain line, in the format its own Status block already uses.

## Deferred

- **The three headline-only arms deserve their own remedy, or real served state.** `src/mutation-engine/pipeline.ts:272` (missing hashes), `:535` and `:542` (foreign wrap) construct `[E_STALE_ANCHOR]` with no `servedBlock`, so one code carries two recovery shapes: retry-with-the-served-rows where a block is served, re-read-then-retry where the headline directs it. Giving those arms their own code/remedy — or attaching served state where one exists — is a follow-up, not part of this supersede.
