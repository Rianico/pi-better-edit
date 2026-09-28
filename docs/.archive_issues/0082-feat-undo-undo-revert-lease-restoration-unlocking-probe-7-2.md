# feat(undo): undo revert lease restoration — unlocking Probe §7.2.9 (T4)

> **Archived from pre-migration issue #82.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-12T07:46:35Z · state CLOSED · labels: ready-for-agent

## Body

## Parent
#78

## What to build
Allows immediate editing after an `undo_last_edit` without an intermediate `read`. When reverting, `src/edit-undo.ts` queries `file_snapshots` for the pinned `file_undo.snapshot_hash` inside `BEGIN IMMEDIATE`, adopting the canonical `snapshot_id` and lineage with zero counter allocations, running the authoritative `retired_at` update, and upserting active leases into `served_leases`.

## Acceptance criteria
- [ ] Wire `src/edit-undo.ts` to query `file_snapshots` for `file_undo.snapshot_hash` inside `BEGIN IMMEDIATE`
- [ ] Adopt canonical `snapshot_id` and `line_lineage` directly on cache hit (zero allocations from `line_id_counters`)
- [ ] Execute authoritative `retired_at` update on lines removed by undo
- [ ] Upsert restored lines into `served_leases` with `retired_at = NULL` and `served_snapshot_hash = :hash`
- [ ] Remove `it.fails` from Probe §7.2.9 in `test/integration/p0-external-change-identity.test.ts`
- [ ] Verify `undo_last_edit` outputs anchors that immediately accept subsequent edits with 0 context retries
- [ ] `pnpm run lint && pnpm run typecheck && pnpm test` pass 100% green

## Blocked by
- #81

## Comments

### @Rianico — 2026-09-15T07:39:02Z

Implemented and shipped.

These landed on `dev/mvcc-line-identity` and are now part of `main` @ `bd3a8f2 feat(edit): adopt line-identity MVCC with leases` (with `bb049dc chore: refresh scaffold to current generation (#122)` on top).

Verified at delivery: the Stage-0 harness was green 15/15 (12 canonical probes A–N + 3 contract deliverables), with the four fail-closed probes (A, E, J, K) asserting **both** the rejection code and byte-identical file content.

Four post-implementation review rounds then found and fixed further issues (#88–#121); all of those findings are in the same `main` state. Closing — reopen if you want any part re-examined.
