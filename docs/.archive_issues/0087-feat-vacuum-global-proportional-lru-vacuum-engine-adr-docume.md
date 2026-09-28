# feat(vacuum): global proportional LRU vacuum engine & ADR documentation (T8)

> **Archived from pre-migration issue #87.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-12T07:47:09Z · state CLOSED · labels: ready-for-agent

## Body

## Parent
#78

## What to build
Long-term store maintenance and formal architectural records. Implements global LRU vacuum in `src/served-session/session.ts` (50MB global cap, per-path retention 2–10, pinning active leases, `file_undo` targets, and 1-hr `retired_at` lines). Connects `src/lifecycle-hooks/index.ts` to prune missing paths. Documents formal supersession ADRs for ADR-0008 and ADR-0013.

## Acceptance criteria
- [ ] Implement global LRU vacuum in `src/served-session/session.ts` with 50MB budget and per-path retention $\min(10, \max(2, \lfloor 10\text{MB} / \text{snapshot\_lineage\_bytes} \rfloor))$
- [ ] Pin active `served_leases`, `file_undo.snapshot_hash`, and leases retired within 1 hour against eviction
- [ ] Wire `src/lifecycle-hooks/index.ts` (`pruneMissingAll`) to purge deleted file snapshots and counters
- [ ] Record ADR in `docs/adr/` formally superseding ADR-0008 (Retirement of Heuristic Canon Healing)
- [ ] Record ADR in `docs/adr/` formally superseding ADR-0013 (Disposal of Dead Epoch Concurrency)
- [ ] Verify test coverage meets thresholds: lines $\ge 85\%$, statements $\ge 85\%$, functions $\ge 85\%$, branches $\ge 80\%$
- [ ] `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` pass 100% green

## Blocked by
- #85

## Comments

### @Rianico — 2026-09-12T07:47:14Z

Duplicate of #86
