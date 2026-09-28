# feat(pairing): decisive patience pairing engine with polynomial DP ⋂ LIS_minΔ (T5)

> **Archived from pre-migration issue #83.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-12T07:46:42Z · state CLOSED · labels: ready-for-agent

## Body

## Parent
#78

## What to build
The complete, isolated pairing engine (`src/hashline/patience-pairing.ts`). Implements `findUniquePins`, $O(m \log m)$ patience sort for minimal-displacement LIS, polynomial $O(m \log m)$ two-pass DP for unconditional intersection $\bigcap \mathcal{LIS}_{\min \Delta}$, progress-guaranteed leaf fall-through, rigid block shift preservation (Probe `N`), dynamic budget guards (`MAX(100k, 4*(p+c))`), and strict monotonicity assertions.

## Acceptance criteria
- [ ] Implement `src/hashline/patience-pairing.ts` with `pairSnapshots(prevLines, currLines)`
- [ ] Implement `findUniquePins` isolating Anchor Pins with unique canons in both intervals
- [ ] Implement minimal-displacement LIS tie-breaking ($\min \sum |p_i - c_i|$) via patience sorting in $O(m \log m)$
- [ ] Implement polynomial two-pass DP for unconditional intersection $\bigcap \mathcal{LIS}_{\min \Delta}$
- [ ] Implement rigid block shift (Probe `N`: equal counts, identical canons $\to$ zip)
- [ ] Implement progress-guaranteed leaf fall-through (no recursive infinite loops on identical bounds) and dynamic budget guard `MAX(100k, 4*(p+c))`
- [ ] Implement strict monotonicity verification ($curr_i > curr_{i-1}$)
- [ ] Create standalone unit test battery `test/hashline/patience-pairing.test.ts` covering all edge cases (`[H,A,B,T]`, symmetric swap `[A,B]`, `α3/β7` chains, budget guard, Probe `N` block shifts)
- [ ] `pnpm run lint && pnpm run typecheck && pnpm test` pass 100% green

## Blocked by
- #80

## Comments

### @Rianico — 2026-09-15T07:39:05Z

Implemented and shipped.

These landed on `dev/mvcc-line-identity` and are now part of `main` @ `bd3a8f2 feat(edit): adopt line-identity MVCC with leases` (with `bb049dc chore: refresh scaffold to current generation (#122)` on top).

Verified at delivery: the Stage-0 harness was green 15/15 (12 canonical probes A–N + 3 contract deliverables), with the four fail-closed probes (A, E, J, K) asserting **both** the rejection code and byte-identical file content.

Four post-implementation review rounds then found and fixed further issues (#88–#121); all of those findings are in the same `main` state. Closing — reopen if you want any part re-examined.
