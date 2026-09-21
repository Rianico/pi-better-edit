# ADR-0022 — Served canons are file-scoped; `[E_STALE_RANGE]` serves a fresh read

Date: 2026-09-21

## Status

accepted — amends [ADR-0018](0018-region-scoped-rejection-serves.md) decision 4 (the payload-shape oracle's heading rule) and [ADR-0021](0021-unified-error-and-warning-contract.md) decision 4 (the remedy-free enumeration). Does **not** supersede ADR-0018's Decision: reject-and-serve still serves the current on-disk range on the same transaction-free path; only the heading and the retry affordance change.

Amends [ADR-0018 — Region-scoped rejection serves; a retired identity recovers by re-read](0018-region-scoped-rejection-serves.md)

Amends [ADR-0021 — Unified error and warning contract: the accepted record](0021-unified-error-and-warning-contract.md)
Amended by [ADR-0023 — Lease lineage is the span verification authority; served canons retire](0023-lease-lineage-is-the-span-verification-authority-served-canons-retire.md) (decision 1: the canon no longer travels with the row)

## Context

Two defects from one live session (#149), both rooted in treating a 3-char anchor as globally meaningful.

**1. A process-global `hash → canon` map collides across files.** `HashIdentity.hashToCanon` (`src/hashline/hash-identity.ts`) was a process-wide `Map<string, string>` keyed by the bare 3-char anchor, first-write-wins, and `globalCanonStore` exposed it to the serve writer. `src/served-session/session.ts` used it as a fallback while persisting `served.canons`:

```ts
const cv = row.hash ? (globalCanonStore.get(row.hash) ?? null) : null;
```

Three characters give 238,328 slots, so cross-file collisions are expected. File A hashing a line to `FU6` locked `FU6 → "}=verification??{};"`; file B hashing an unrelated line to the same anchor was ignored by `rememberHashCanon`, and when file B was edited the writer persisted **file A's canon** into file B's `served.canons`. The next edit of file B compared disk against that poisoned canon in `verifyServedRange` and threw a false `[E_STALE_RANGE]` naming a line that had never changed.

The map was not load-bearing anywhere else. Its only production readers were that fallback, a drift heuristic (`src/drift.ts`), and `ServedVerification`'s `ensureCanonsPopulated`, which *wrote* the map and never read it back. The canon that verification actually compares is the persisted, per-file `served.canons` array, supplied by the read path as `fullReadCanons` — file-scoped by construction since ADR-0005.

**2. `(no read needed)` is a mandate the tool cannot back.** `[E_STALE_RANGE]` rendered `${headline}\nCurrent range:\n${servedBlock}\nRetry with these anchors (no read needed).` and declared `remedy: "Retry with the served rows; no read is needed."`. That is sound only when the rejection proves the anchors are the right retry. A stale range proves the opposite of what a retry needs: served state and disk disagree, and the tool cannot tell whether the model's anchors, the disk, or its own record is wrong — the poisoned-canon case above was the tool's own record. The hint sent models into identical failing retries.

## Decision

**Three checkable statements.**

1. **A canon travels with the row that carries it.** `ServedRow` and `ServedEntry` gain an optional `canon`; every producer that holds the file's lines stamps it (`src/mutation-engine/pipeline.ts` dense diff rows, `src/edit-response.ts` success and batch rows, `src/served-session/session.ts` consumers via `buildRangeServeRows(..., fileLines)`, `src/noop-guard.ts`, `src/drift.ts`, `src/edit-undo.ts`, `src/lifecycle-hooks/index.ts` write path). `writeServeRecord` persists `row.canon ?? null` and never consults a hash-keyed store. A producer with only hashes records no canon, and that position degrades to hash-equality verification — the legacy ADR-0005 fallback — instead of claiming a file-blind canon.

2. **The process-global `hash → canon` map is deleted.** `CanonStore`, `createCanonStore`, `globalCanonStore`, `HashIdentity.hashToCanon`/`rememberHashCanon`/`getCanonForHash`/`clearCanon`/`canonEntries` and `ServedVerification`'s store field and `ensureCanonsPopulated` are removed, together with the `canonStore` parameters on `verifyServedRange`/`verifyServedRangeResult` and `_lineHashesPure`'s store parameter. `src/drift.ts`'s rotated-survivor heuristic reads only `servedCanons[servedPos]`; a missing entry no longer falls back to a same-anchor line from another file. Check: `test/core/serve-recording.test.ts` ("scopes served canons per file when two files share one 3-char anchor (#149)") — two files recorded under one anchor string keep their own canons; it reads back file A's line on the pre-#149 code.

3. **`[E_STALE_RANGE]` serves the current range as a fresh read.** Its format becomes `${headline}\n${FRESH_READ_HEADING}\n${servedBlock}` — the exact heading `Current range (fresh read):` already used by `[E_UNVERIFIED_RANGE]` — and its `remedy` field is removed, joining the remedy-free set by rule (the evidence pins the disagreement, not the cause). `[E_STALE_ANCHOR]` keeps `Current range:` plus `RETRY_HINT`: there the served rows *are* the retry. Check: `test/arch/domain-error-registry.test.ts` ("E_STALE_RANGE serves a fresh read and never mandates a blind retry (#149)") and `test/arch/remedy-eligibility.test.ts`, whose `REMEDY_FREE` set now names `E_STALE_RANGE` in both directions (no `remedy` field, no imperative in the rendered text).

The payload-shape oracle in `test/arch/rejection-payload-region.test.ts` is amended accordingly: the range-family codes (`E_STALE_RANGE`, `E_UNVERIFIED_RANGE`) are the ones that render rows under `Current range (fresh read):` with no retry hint; `E_STALE_ANCHOR` is the remaining row-carrying code under `Current range:` with the hint. A negative control plants a retry hint on a stale-range payload and asserts the oracle fails it, so the new rule is falsifiable, not merely restated. The oracle's substance — rows must be derivable from the submitted anchors' live mapping and must reproduce the current on-disk hashes, never placed by a content lookup — is unchanged.

## Consequences

- `CONTEXT.md` carries the glossary side (`served-range staleness`, `never-served`, `reject-and-serve`, `canon`, `remedy-eligibility`, `tombstone`); `README.md` carries the contract side (the `[E_STALE_RANGE]` row of the error table plus the two comparison rows); `docs/spec/unified-error-and-warning-contract.md` §3.2 carries the heading.
- Accepted ADR prose keeps its original wording as historical quotes and is never rewritten (ADR-0019 procedure); the reciprocal `Amended by` links land on ADR-0018 and ADR-0021.
- The `test/arch/serve-recording-seam.test.ts` oracle still pins one shared writer for mirror, canon sync and lease grant; it now passes canons explicitly, because the writer no longer derives them.
- No public tool surface changes: no new code, no removed code, no payload field. `ServedRow.canon` is an internal row attribute and is never rendered into a serve block.
