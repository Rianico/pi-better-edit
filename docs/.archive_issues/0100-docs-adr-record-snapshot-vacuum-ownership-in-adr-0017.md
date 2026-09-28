# docs(adr): record snapshot-vacuum ownership in ADR-0017

> **Archived from pre-migration issue #100.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T16:13:36Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## Findings
1. **ADR drift**: `docs/adr/0017-lru-vacuum-supersedes-epoch-concurrency.md` L18 and L30 state that `vacuumSnapshots` is owned by `src/served-session/session.ts`, but commit `9144f53` moved it to `src/snapshot-store.ts`.
2. **Review 3 (b)2** flags that relocation as scope creep against spec L705-706 ("Stage 3 ... Seams: `src/served-session/session.ts`, `src/lifecycle-hooks/index.ts`").

## Operator decision (review 3, Q2)
**Keep the code in `src/snapshot-store.ts` and fix ADR-0017.** The relocation stays:
- `vacuumSnapshots` operates entirely on the CAS storage tier (`file_snapshots`, `line_lineage`) and consults `served_leases` only for pinned snapshot ids, so the snapshot store is the cohesive owner and the Feature Envy review 2 raised is gone;
- spec L705-706 is a plan-time stage roadmap listing files to touch, not an ownership invariant forbidding later architectural cleanup, and reverting a reviewed, merged, arch-guard-protected move would be ping-pong;
- the boundary is already enforced by `test/arch/c3-served-session-deepening.test.ts`.

Review 3 finding (b)2 is therefore **declined by operator decision**; the ADR should record that rationale so the next review does not re-open it.

## Remedy
Update ADR-0017 so it cites `src/snapshot-store.ts` as the owner of `vacuumSnapshots`, and add a short note recording why ownership sits in the snapshot store (CAS-tier data ownership; `served_leases` consulted only for pinning) plus the explicit decision that the Stage-3 seam list is a roadmap, not an ownership constraint.

## Acceptance criteria
- No statement in ADR-0017 places `vacuumSnapshots` in `src/served-session/session.ts`; the cited owner matches `src/snapshot-store.ts`.
- The ownership rationale (CAS-tier data owner; lease consulted only for pinning; roadmap seam list is not an ownership invariant) is recorded in the ADR.
- The ADR's supersession content for ADR-0013/epoch concurrency is unchanged, and no other file is touched except a factual pointer that really is stale.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:39:59Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
