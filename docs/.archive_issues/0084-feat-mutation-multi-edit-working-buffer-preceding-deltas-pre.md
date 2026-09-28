# feat(mutation): multi-edit working buffer preceding deltas & pre-allocation WAL commit (T6)

> **Archived from pre-migration issue #84.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-12T07:46:48Z · state CLOSED · labels: ready-for-agent

## Body

## Parent
#78

## What to build
Crash-safe batch edit execution in `src/mutation-engine/pipeline.ts`. Working buffer tracks preceding coordinate shifts ($\Delta_k = \sum (|R_j| - \text{len}_j)$) and rejects overlapping spans (`[E_BATCH_ABORT]`). Implements the WAL commit protocol inside `BEGIN IMMEDIATE`: checks the pre-allocation snapshot cache guard to adopt canonical lineage on cyclical/revert edits (zero counter allocations), or allocates fresh `line_id`s from `line_id_counters` on novel content, commits lineage, and updates `retired_at`.

## Acceptance criteria
- [ ] Implement preceding coordinate shift rebase for multi-edit batches in `src/mutation-engine/pipeline.ts` ($\Delta_k = \sum_{j < k, s'_{end, j} < s'_{start, k}} (|R_j| - \text{len}_j)$)
- [ ] Implement overlapping batch rejection with `[MODEL] [E_BATCH_ABORT]`
- [ ] Implement pre-allocation cache guard in commit transaction: query `(path, C_final)` in `file_snapshots`
- [ ] On cache hit (reversion / cyclical edit): adopt canonical `snapshot_id` and lineage with zero allocations from `line_id_counters`
- [ ] On cache miss (novel content): preserve surviving `line_id`s, allocate $N_{inserted}$ fresh IDs from `line_id_counters(path)`, insert `file_snapshots` and `line_lineage`
- [ ] Execute authoritative `retired_at` update on `served_leases` for lines deleted by the batch
- [ ] Upsert newly served diff lines into `served_leases` with `retired_at = NULL`
- [ ] Verify Probes `I` (batch edits) and `M` (drift + batch edits) pass green
- [ ] `pnpm run lint && pnpm run typecheck && pnpm test` pass 100% green

## Blocked by
- #81
- #83

## Comments

### @Rianico — 2026-09-15T07:39:08Z

Implemented and shipped.

These landed on `dev/mvcc-line-identity` and are now part of `main` @ `bd3a8f2 feat(edit): adopt line-identity MVCC with leases` (with `bb049dc chore: refresh scaffold to current generation (#122)` on top).

Verified at delivery: the Stage-0 harness was green 15/15 (12 canonical probes A–N + 3 contract deliverables), with the four fail-closed probes (A, E, J, K) asserting **both** the rejection code and byte-identical file content.

Four post-implementation review rounds then found and fixed further issues (#88–#121); all of those findings are in the same `main` state. Closing — reopen if you want any part re-examined.
