# ADR-0026 — Retire the library-seam blocked-hash verification signal

Date: 2026-09-29

## Status

accepted — required by issue [#10](https://github.com/Rianico/pi-better-edit/issues/10) (enhancement). Completes the retirement ADR-0017 began and ADR-0023 extended: the blocked-hashes *verification signal* is gone; only its hash-allocation guard remains. Renames the term's live identity per [ADR-0025](0025-rename-tombstone-to-blocked-hashes.md) (`tombstone` → `blockedHashes`); no older ADR is modified.

## Context

**The verification (issue #10, TM-confirmed).** The mirror-vs-mirror blocked-hash signal lives in `ServedVerification.verifyOrThrow` (boundary `throwStaleForBlockedHash` → `[E_STALE_ANCHOR]` `cause: "blocked-hash"`; interior canon tier → `[E_STALE_RANGE]` `cause: "blocked-hash"`), reached from production only through `applyEdit`'s `if (served.length > 0 && !identity)` branch. The sole non-test `applyEdit` caller — `applyOneEdit` (`src/mutation-engine/pipeline.ts`) — always passes a defined `identity` (`leaseSpanSource` returns a non-optional object), so the branch never fires in production. The lease seam owns verification for every edit it resolves (issue #151, ADR-0023): a leased session edit reports the same conditions as `details.cause: "retirement"` through `verifyRebasedSpan`. Only unit tests exercised the mirror path.

## Decision

1. Delete the dead path: the `!identity` mirror branch in `applyEdit`, the `ServedVerification` class with its `verify`/`verifyOrThrow`/private throw builders, the `verifyServedRange`/`verifyServedRangeResult` wrappers and their `served.ts` re-export, the `blockedHashes` field of `ApplyVerificationContext`, and the `"blocked-hash"` member of `RangeCause`/`RANGE_CAUSES`.
2. Keep the allocation guard: `loadBlockedHashes` plumbing, `HashIdentity`'s `used = bitset(oldHashes) ∪ bitset(blockedHashes)`, and the legacy v6 batch retire (#117) are untouched — the set still prevents freed-anchor re-binding.
3. Tests that exercised only the mirror signal are deleted or re-pinned to surviving causes; the suite shrinks by design.

## Consequences

- `details.cause` is emitted from `{retirement, never-served, served-range staleness, anchor staleness, served span}`; `blocked-hash` is no longer a contract value (README and CONTEXT.md updated; `docs/spec/*` historical tables keep their as-written text).
- A library consumer embedding `applyEdit` with a served mirror and no lease source no longer gets mirror staleness — anchor algebra plus the served-hash echo gate still apply; mirror staleness is now the lease seam's alone.
- If issue #10's follow-up ever reinstates a mirror-tier signal, it must come back with a live caller and a name in the current glossary.
