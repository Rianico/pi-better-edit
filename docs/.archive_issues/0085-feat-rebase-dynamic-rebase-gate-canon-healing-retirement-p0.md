# feat(rebase): dynamic rebase gate, canon healing retirement & P0 probes green (T7)

> **Archived from pre-migration issue #85.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-12T07:46:56Z · state CLOSED · labels: ready-for-agent

## Body

## Parent
#78

## What to build
Re-architects `src/hashline/resolve.ts` (`valEdit`) and `served-verification.ts` to resolve edits via leased `line_id`s and dynamic rebase against $S_{curr}$ lineage, while retiring legacy heuristic canon guessing.
- Deletes `src/hashline/healing/*` and `tryHealOrphanedSpan`.
- Retires `test/hashline/healing.test.ts` and `test/hashline/healing-policy.test.ts`.
- Updates `test/core/served-verification.test.ts:71` to fail-closed (`E_UNSERVED_RANGE`).
- Removes `it.fails` from all remaining Stage 0 tests in `test/integration/p0-external-change-identity.test.ts` (Probes `A, B, E, H, K`).

## Acceptance criteria
- [ ] Implement fast path qualification ($S_{from} === C \land S_{to} === C \land S_{from} === S_{to}$) in `src/hashline/resolve.ts`
- [ ] Implement dynamic rebase path: query `line_lineage(C)` for leased `line_id`s (materializing on-demand via `pairSnapshots` if needed)
- [ ] Enforce fail-closed rejection on deleted/retired `line_id` with `[MODEL] [E_STALE_RANGE]` (Probe E, Probe A)
- [ ] Enforce interior span contiguity in `served-verification.ts` with `[MODEL] [E_STALE_RANGE]` (Probe J)
- [ ] Delete `src/hashline/healing/*` and `tryHealOrphanedSpan` from `src/hashline/served-verification.ts`
- [ ] Delete `test/hashline/healing.test.ts` and `test/hashline/healing-policy.test.ts`
- [ ] Update `test/core/served-verification.test.ts:71` to assert fail-closed rejection (`ok: false, code: "E_UNSERVED_RANGE"`)
- [ ] Re-align integration test expectations in `test/integration/hash-heal-tdd.test.ts` and `test/integration/served-edge-cases.test.ts`
- [ ] Remove `it.fails` from all remaining tests in `test/integration/p0-external-change-identity.test.ts`
- [ ] All 15 tests in `test/integration/p0-external-change-identity.test.ts` pass 100% green
- [ ] `pnpm run lint && pnpm run typecheck && pnpm test` pass 100% green

## Blocked by
- #84

## Comments

### @Rianico — 2026-09-15T07:39:11Z

Implemented and shipped.

These landed on `dev/mvcc-line-identity` and are now part of `main` @ `bd3a8f2 feat(edit): adopt line-identity MVCC with leases` (with `bb049dc chore: refresh scaffold to current generation (#122)` on top).

Verified at delivery: the Stage-0 harness was green 15/15 (12 canonical probes A–N + 3 contract deliverables), with the four fail-closed probes (A, E, J, K) asserting **both** the rejection code and byte-identical file content.

Four post-implementation review rounds then found and fixed further issues (#88–#121); all of those findings are in the same `main` state. Closing — reopen if you want any part re-examined.
