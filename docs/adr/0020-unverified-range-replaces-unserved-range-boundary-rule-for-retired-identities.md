# ADR-0020 — Unverified range replaces unserved range; boundary rule for retired identities

Date: 2026-09-19

## Status

accepted — amends [ADR-0018](0018-region-scoped-rejection-serves.md) decisions 1–2 and 4, and [ADR-0014](0014-user-model-audience.md) decision 33. Implementation landed in the task's code commit; this record is accepted in the same docs commit that syncs `CONTEXT.md`, `README.md` and the living specs, so no accepted ADR claims a contract the code does not honor.

Amends [ADR-0018 — Region-scoped rejection serves; a retired identity recovers by re-read](0018-region-scoped-rejection-serves.md)

Amends [ADR-0014 — User/Model audience split and glossary-aligned error codes](0014-user-model-audience.md)

Amended by [ADR-0021 — Unified error and warning contract: the accepted record](0021-unified-error-and-warning-contract.md)
Amended by [ADR-0024 — Narrow informed destruction to the boundaries; cap the applied diff's removals](0024-narrow-p2-interior-exposure-cap-removed-diffs.md) (decision 2: the interior-hole producer is accepted, not collapsed into `[E_STALE_RANGE]`)

## Context

ADR-0018 decision 1 served the model's coordinates iff at least one stale-branch bound was live and unshifted, keeping `[E_STALE_RANGE]` with its blind-retry affordance. The disjunction is unsound: a live, unshifted head with a deleted tail serves a window of lines the model never targeted while carrying `Retry with these anchors (no read needed)` — a silent wrong-range write of the Bug-1 class. The rows are leased, so the retry writes where the model never aimed.

Two adjacent defects fell out of the same review. `E_UNSERVED_RANGE` carried two opposite remedies under one code (retry-with-rows for the interior hole, full re-read for the unplaceable boundary — audit finding F2a), and `README.md` promised a `details.unservedKind` field no producer emits (audit finding F2b). ADR-0014:33 merged the old `E_RANGE_UNVERIFIED` into `E_UNSERVED_RANGE` on the premise that the two remedies are identical; they are not — decide-from-a-fresh-read and retry-with-the-served-rows ask the model to do different things.

## Decision

**The model-facing range family is exactly four codes, split by remedy:** `E_STALE_ANCHOR` (no lease — acquire anchors from the served rows), `E_STALE_RANGE` (drift — retry with the served rows), `E_UNVERIFIED_RANGE` (unplaceable bound — decide from a fresh read of the named window), `E_TARGET_LOST` (no range — read and re-target). `E_UNSERVED_RANGE` is retired with no alias.

1. **Boundary rule** (`src/hashline/lease-resolve.ts`): rows are served only when exactly one bound is stale and the survivor is live *and* unshifted. That single case is `[E_UNVERIFIED_RANGE]`: the named window (served coordinates clamped to the file) under the exact heading `Current range (fresh read):`, one general headline clause with no line-by-line narration, no retry hint and no mandate; the rows are leased through the normal seam so deciding from them writes. Both bounds stale, a shifted survivor, or a clamped window that collapses or misses the file is `[E_TARGET_LOST]` with no rows and no heading. The named coordinate is always lease-derived (`lease.servedLineNumber`); content placement never names it.
2. **Retirement mapping:** the interior-hole producer collapses into `[E_STALE_RANGE]` (identical remedy) and the boundary `throwUnverified` producer becomes `[E_UNVERIFIED_RANGE]`. The tombstoned-boundary check keeps its rows, drops its retry hint, and serves the fresh-read heading (`cause: tombstone`).
3. **`details.cause`** (user-facing diagnosis, never a model remedy): every range-family producer emits it with a `CONTEXT.md` glossary value — `retirement`, `tombstone`, `never-served`, `served-range staleness`, `anchor staleness`, `served span` — so the field cannot rot into a second phantom promise.
4. **Prompt contract:** a `[MODEL]` line presenting rows as a fresh read (`Current range (fresh read):`) is not a blind retry — decide from those rows (`prompts/edit-guidelines.md`, byte-equal `EDIT_GUIDELINES` mirror).
5. **Oracle** (`test/arch/rejection-payload-region.test.ts`): the derivable-rows matrix covers survivor live+unshifted, both stale, shifted survivor, collapsed window, tombstone producer, and interior hole, with `expectedCode` per case and per-code shape (fresh heading and no retry hint for unverified; rows and retry hint otherwise). Negative controls plant rows on target-lost, a retry hint on unverified, a stale heading on unverified, and a shifted survivor still serving, and each fails the check.

## Consequences

- **`CONTEXT.md`:** `served-range staleness` and `never-served` describe the four-code family; new `unverified range` entry; `reject-and-serve` scoped to range-matched serves plus leased fresh reads; `target-lost rejection`, `retirement`, `orphaned serve` and `model-facing signal` updated. No new cause term was needed — all values already exist in the glossary.
- **`README.md`:** the `[E_UNSERVED_RANGE]` row is retired (including its `details.unservedKind` phantom promise), the `[E_UNVERIFIED_RANGE]` row is added, and the `[E_STALE_ANCHOR]` row names the lease instead of the anchor drop.
- **Living specs** (`docs/spec/content-addressed-line-identity-mvcc.md`, `stale-identity-reject-and-serve.md`, `served-state-range-verification.md`, `session-keyed-served-state.md`) name the new codes. Accepted ADRs, the audit, the handoff analysis and the article keep their original codes as intentional historical quotes.
- **Downstream consumers** see one new literal (`[E_UNVERIFIED_RANGE]`) and one removed literal (`[E_UNSERVED_RANGE]`); the `test/core/error-codes.test.ts` README parity gate pins both sides.
- **Cost:** none new. The fresh-read rows cost the same serve a retry would have carried, and they lease, so deciding from them terminates.
