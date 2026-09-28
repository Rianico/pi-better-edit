# feat(vacuum): global proportional LRU vacuum engine & ADR documentation (T8)

> **Archived from pre-migration issue #86.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-12T07:47:03Z · state CLOSED · labels: ready-for-agent

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

### @Rianico — 2026-09-15T07:39:16Z

Implemented and shipped.

These landed on `dev/mvcc-line-identity` and are now part of `main` @ `bd3a8f2 feat(edit): adopt line-identity MVCC with leases` (with `bb049dc chore: refresh scaffold to current generation (#122)` on top).

Verified at delivery: the Stage-0 harness was green 15/15 (12 canonical probes A–N + 3 contract deliverables), with the four fail-closed probes (A, E, J, K) asserting **both** the rejection code and byte-identical file content.

Four post-implementation review rounds then found and fixed further issues (#88–#121); all of those findings are in the same `main` state. Closing — reopen if you want any part re-examined.
