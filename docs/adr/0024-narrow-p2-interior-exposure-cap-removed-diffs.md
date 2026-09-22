# ADR-0024 — Narrow informed destruction to the boundaries; cap the applied diff's removals

Date: 2026-09-21

## Status

accepted — amends [ADR-0020](0020-unverified-range-replaces-unserved-range-boundary-rule-for-retired-identities.md) decision 2 (the interior-hole producer no longer collapses into `[E_STALE_RANGE]`), [ADR-0018](0018-region-scoped-rejection-serves.md)'s Context principle (a model's decision is a function of the content it was served), and [ADR-0023](0023-lease-lineage-is-the-span-verification-authority-served-canons-retire.md)'s interior-coverage claim (the span gate no longer requires a served row for every interior position). Extends [ADR-0022](0022-file-scoped-canons-and-fresh-read-stale-range.md)'s principle — a rejection may not mandate what the tool cannot back — to the exposure gate; ADR-0022's payload contract (fresh read, no retry mandate) is unchanged and not superseded.

Amends [ADR-0018 — Region-scoped rejection serves; a retired identity recovers by re-read](0018-region-scoped-rejection-serves.md)

Amends [ADR-0020 — Unverified range replaces unserved range; boundary rule for retired identities](0020-unverified-range-replaces-unserved-range-boundary-rule-for-retired-identities.md)

Amends [ADR-0023 — Lease lineage is the span verification authority; served canons retire](0023-lease-lineage-is-the-span-verification-authority-served-canons-retire.md)

Extends [ADR-0022 — Served canons are file-scoped; `[E_STALE_RANGE]` serves a fresh read](0022-file-scoped-canons-and-fresh-read-stale-range.md)

## Context

Two costs, one root: the tool policed **exposure** — what the model had been shown — where it can only verify **identity** — what the model names.

**P1 vs P2.** P1 (verified intent) is the correctness invariant: every line the model *names* must resolve against served state. P2 (informed destruction) is a policy: every line the model *discards* must previously have been shown to it. Only P2 produced the "never served" refusal; the `cause` discriminator already carried the truth while all five rejection sites shared the `E_STALE_RANGE` code (whose name asserts P1).

**1. The interior exposure gate fired on correct edits.** `verifyRebasedSpan` (`src/hashline/served-verification.ts`) required a served mirror row for *every* position of the window, so an edit whose boundaries the model had read but whose interior it had not was refused `[E_STALE_RANGE]` / `details.cause: "never-served"`. Measured in an independent benchmark (452 trials, 226 tasks × 2 models, pi 0.85.1 + pi-better-edit 2.1.0): 8 of 242 `edit` calls, all in trials that passed, all recovering on an immediate resend of the *identical* payload — because the refusal had already served the rows it demanded. Payloads ran 7.9–11.6 KB (107–150 rows). The same sample produced zero firings from the branches it shares for real drift (`served-range staleness`, `retirement`, `tombstone`): the gate was not earning its keep as a staleness check, and its demand was satisfied by its own payload — a handshake, not a verification.

**2. The applied diff rendered every removed row.** The largest observed result was 11,635 chars / 108 lines for a single range deletion, while the refusal side has been capped at `SERVED_ROWS_CAP` (150) rows since ADR-0018/0020. The tool capped what it demanded and not what it returned.

## Decision

Three checkable statements.

1. **The span gate verifies the boundaries and the served interior; an unserved interior row is accepted.** In `verifyRebasedSpan`, rows `k = 0` and `k = servedLen - 1` — the anchors the model named — keep the full check: a served mirror row, a lease for the anchor it names, `retiredAt === null`, and `rebasedLineOf(lease.lineId) === currentLine`. For `0 < k < servedLen - 1`: a `null` slot (never served, or cleared by an earlier write) is accepted and the loop continues, because the row carries no identity to verify and the window's extent is already pinned by the two boundary leases plus the window-length gate; an `undefined` slot (the mirror was truncated out from under the span) keeps `E_STALE_RANGE` / `served-range staleness`; a served slot keeps every lease check. Check: `test/hashline/lease-resolve.test.ts` ("accepts an unread interior row between two leased boundaries (ADR-0024)", "still rejects an unread boundary row of a three-line window (ADR-0024)", "reports E_STALE_RANGE for a never-served boundary row (a two-line window is all boundary)") and `test/hashline/mixed-snapshot-interior.test.ts` ("accepts an explicitly cleared interior mirror slot — no identity to verify (ADR-0024)"), with the truncation, retirement and drift diagnoses keeping their own tests in the same files.

2. **`details.cause: "never-served"` from the leased-span gate now means a boundary row, or an anchor holding no lease.** The library-level seam for callers with no lease source (`validateResolvedSpan`, `src/hashline/served-verification.ts:734`) keeps its own never-served interior diagnosis: there the mirror is the only evidence and the caller has no boundary leases to pin the span. The change is confined to the leased path. Check: the boundary tests named in decision 1.

3. **The applied diff caps removals.** Above `DIFF_REMOVED_CAP` (6) rows, `pushRemovedLines` (`src/edit-diff.ts`) renders 2 head rows, ` - ... [N lines omitted] ...`, and 2 tail rows — and advances the coordinate cursor by every omitted row, so every surviving row keeps its exact old line number and hash. Check: `test/core/edit-diff.preview.test.ts` ("renders head + exact-count marker + tail for a large deletion, keeping tail coordinates", "leaves a deletion at the cap uncapped", "caps at one row past the threshold") plus the existing column-alignment property test, which still pins the `│` column across randomized content.

## Rejected alternatives

- **Mint `E_UNSERVED_INTERIOR` (or reuse `E_UNVERIFIED_RANGE`) for the case** — rejected: a new public code costs the `DomainError` union, the registry, the README table, the AST and rejection-payload oracles and the prompts, to express a distinction the `details.cause` field already carries — and it would preserve the handshake rather than delete it. The mis-naming is best fixed by removing the producer, not by adding a label.
- **Keep the gate and re-add a retry hint under `E_STALE_RANGE`** — rejected by ADR-0022 decision 3 and ADR-0021 decision 4 (remedy-eligibility): a retry hint here is the same mandate the tool cannot back, and the range family is remedy-free by rule.
- **Make the tool judge intent — reject a fully served but mis-targeted span** — rejected: that needs heuristics over the model's replacement, the `tryHealOrphanedSpan` class ADR-0016 retired. Reproduced as case C: a span from the `0042` BEGIN to the `9002` END applies, and the applied diff names every removed line — the signal exists, and the judgement is the model's.
- **Leave the applied diff uncapped, or cap it harder than the refusals** — rejected: the refusal side was already capped at 150 rows; the uncapped side grew with the model's own edit, which is the side the token budget is spent on. A 150-row equivalence is unnecessary: the removal's exact size plus both ends is what a decision needs.
- **Reconstruct a truncated served window from leases** — already rejected by ADR-0023 and unchanged here: an `undefined` slot still fails closed.

## Consequences

- A range deletion over a voided interior (a write clears the mirror from `firstChangedLine` on) is no longer gated on exposure. Accepted residual risk: the replacement is defined by the two boundaries the model named, the applied diff reports the removal's exact size, and `read` re-serves the interior in one turn.
- The compensating signal is the size marker, not the removed content: decision 1 and decision 3 land together, so the contract is "you can see how much you destroyed, and re-read when it matters" — never "you have seen it".
- `details.cause: "never-served"` narrows. `CONTEXT.md` (`served-range staleness`, `never-served`), `docs/spec/content-addressed-line-identity-mvcc.md` §5.3, and the `README.md` `[E_STALE_RANGE]` row carry the glossary, table and contract sides; the spec keeps its as-built sentences as historical record and amends them in place rather than rewriting them (ADR-0019 procedure).
- Expected, not yet re-measured: the 8 `E_STALE_RANGE` errors in the 452-trial run go to 0 and those 8 trials pass without the resend round trip. Falsifiable by re-running the benchmark's 24-task block-span family against a patched build.
- Out of scope: 52% of the benchmark trials wrote files through `bash` rather than `edit`, a route around every edit-time gate. That is a routing-cost signal about the tool's friction, not evidence that this gate worked.
