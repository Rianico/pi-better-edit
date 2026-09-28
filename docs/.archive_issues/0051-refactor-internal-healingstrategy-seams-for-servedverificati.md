# refactor: internal HealingStrategy seams for ServedVerification (C5, ADR-0008)

> **Archived from pre-migration issue #51.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-28T18:12:41Z · state CLOSED · labels: ready-for-agent

## Body

Part of architecture review 2026-08-28 (candidate 5 — Speculative). Follows #43, #45, #47, #49. Touches ADR-0008 — flagged, worth reopening.

> [!note] ADR-0008 note
> ADR-0008 (2026-08-26, C1) deliberately collapsed 280 LOC of healing into one deep `ServedVerification` module *without touching other seams* — the right incremental step. This candidate keeps the external seam (`verify`/`verifyOrThrow`) and adds *internal* seams private to the implementation — no interface churn, pure locality repair. Low risk of re-scattering.

## Problem
`src/hashline/served-verification.ts` (719 LOC, 19 private methods, Cplx 14, fanout 8) is deep externally (`verify`/`verifyOrThrow` — small interface) but flat internally — seven healing branches (`tryHealOrphanedSpan`, `trySingleCandidateCanonHeal`, `tryBoundaryCanonHeal`, `validateHealedSpan`, `validateNonHealedSpan`, `isLengthHealedViaCanon`, `resolveServedSpan`, `enumerateExactCandidates`) are private methods on one class. ==Locality failure inside the deep module== — fixing `BoundaryCanonHeal` requires reading 500 LOC to isolate. `The interface is the test surface` forces integration tests to craft exact hash/position collisions via the outer API.

Deletion test: deleting one private heal method folds its 40 LOC back into `verifyOrThrow`'s switch — no leverage.

## Solution
Keep external depth, add internal seams: `port HealingStrategy` (private to the module) with three adapters (`OrphanHeal`, `SingleCanonHeal`, `BoundaryHeal`) plus shared `validateHealed`/`validateNonHealed` helpers, composed privately inside `ServedVerification`. Not exported — not widening the seam. Tests target strategies via the module's internal test seam (co-located spec file) without exposing them, so one heal path refactors without touching the others.

> [!tip] Seam discipline
> `in-process` — internal port only. One external adapter (today) → deep module; three internal adapters are justified because they isolate 3 materially distinct healing heuristics (orphan vs canon vs boundary).

## Acceptance
- [ ] `src/hashline/served-verification.ts` (and/or `src/hashline/healing/*`) introduces private `HealingStrategy` port + `OrphanHeal`/`SingleCanonHeal`/`BoundaryHeal` adapters composed inside `ServedVerification` — external interface `verify`/`verifyOrThrow` unchanged (zero caller churn)
- [ ] Each strategy testable with focused fixture (no collision crafting through outer interface); shared validators reused, not duplicated
- [ ] `npm run typecheck && npm test` green; keep Obsidian `.md` flavour
- [ ] ADR-0008 callout preserved in PR body — explains why internal split is safe

## Files
`src/hashline/served-verification.ts` (719 LOC) · `src/hashline/hash.ts` · `src/hashline/served.ts` · `src/hashline/hash-identity.ts`

Closes-by: squash PR with `Closes #NN`.

