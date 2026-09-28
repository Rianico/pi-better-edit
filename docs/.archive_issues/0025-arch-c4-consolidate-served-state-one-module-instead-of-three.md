# Arch C4: Consolidate served state — one module instead of three with two names

> **Archived from pre-migration issue #25.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-15T03:47:45Z · state CLOSED · labels: ready-for-agent

## Body

Part of #20

Blocked by: C1 and C3 tickets (C1 moves `recordEchoServes` into the served-state surface and makes hashline pure; C3 adds the `recordDiffServes` helper — C4 consolidates the module they land in).

## Goal
Make served state one module instead of three with two names. Today a reader needs `served-state.ts` (public seam), `served-store.ts` (sync core), and `hashline/served.ts` (domain logic: verify, echo, policy) to understand "served state", and `served-state` / `served-store` are near-synonyms.

## Friction (why)
- `src/served-state.ts` (66 lines) re-exports `served-store.ts` wholesale and adds pure geometry (`servedPositionsOf`, `nearestSurvivingPosition`, `currentPositionOfDrifted`) — the re-export surface is as wide as the implementation.
- The async adapters (`loadServed`, `recordServed`, `recordServedTruncated`, `driftReported`, `markDriftReported`, `clearDriftReported`, `wipeServedState`) each duplicate `loadHashStore + catch` boilerplate; the sync core is already injectable and well-tested.
- `upsertServed` and `recordServesTruncated` re-implement the same position-patch loop (~20 lines): validate position/hash, extend with nulls, assign, pop trailing nulls.
- Pure geometry lives beside I/O, so `drift.ts` and `hashline/served.ts` import the async store layer just to get two pure array functions.

## Solution
- One served-state module owning the concept: the sync core, its async adapters, and the geometry in one place.
- One position-patch primitive shared by `upsertServed` and `recordServesTruncated` (truncate/clearFrom prefix stays in the caller).
- Drop the wholesale re-export so each name means exactly one module.
- After C1, `recordEchoServes` and (after C3) `recordDiffServes` live here too.

## Files
`src/served-state.ts`, `src/served-store.ts`, `src/hashline/served.ts` (verify/echo stays; policy + persistence move), `src/drift.ts` (imports), `index.ts`, `src/edit.ts`, `src/batch-edit.ts`, `src/read.ts`.

## Acceptance
- No module re-exports another module wholesale under these names.
- One patch primitive; `upsertServed` and `recordServesTruncated` share it.
- `test/core/served-state.test.ts`, `test/core/served-store.test.ts`, `test/core/drift.test.ts`, `test/core/reject-and-serve-seam.test.ts` pass.
- `npm run typecheck && npm run lint && npm test` green.

## Constraints
ADR-0001: verify semantics, reject-and-serve, echo counting as serves — unchanged. ADR-0002: session keying — unchanged.


## Comments

### @Rianico — 2026-08-15T05:20:50Z

Done — merged to main as a550e07 (wt merge, squash). served-state.ts is now the single module owning served state (sync core + async adapters + geometry + policy); one patchServed primitive shared by upsertServed/recordServesTruncated; served-store.ts is a narrow temporary bridge awaiting the C5 facade removal. Verified: typecheck, lint, 997 tests, coverage 93.8/93.0/92.8/88.5.
