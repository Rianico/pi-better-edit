# feat(storage): expand v7 CAS schema, v6 compatibility shells & isolated file_undo (T1)

> **Archived from pre-migration issue #79.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-12T07:36:51Z · state CLOSED · labels: ready-for-agent

## Body

## Parent
#78

## What to build
The storage and migration foundation for Content-Addressed Line-Identity MVCC. Bumps `HASH_STORE_VERSION = 7`, initializes normalized v7 tables (`file_snapshots`, `line_lineage`, `line_id_counters`, `served_leases`, `served_session_meta`, `file_undo`) with `PRAGMA foreign_keys = ON`, maintains complete v6 compatibility shells (`snapshots`, `served`, `undo` with `result_content`) to prevent cross-worktree flapping or drop-table wipes, and isolates undo history in `file_undo`.

## Acceptance criteria
- [ ] Bump `HASH_STORE_VERSION = 7` in `src/constants.ts`
- [ ] Initialize v7 schema (`file_snapshots`, `line_lineage`, `line_id_counters`, `served_leases`, `served_session_meta`, `file_undo`) and indexes in `src/hash-store.ts` with `PRAGMA foreign_keys = ON;`
- [ ] Maintain full v6 compatibility shells (`snapshots`, `served`, `undo` with `result_content`) in `src/hash-store.ts` to prevent syntax errors or table wipes during concurrent/un-restarted v6 sessions
- [ ] Ensure `buildStore` never drops tables on version change (idempotent initialization)
- [ ] Migrate `src/undo-store.ts` to persist in `file_undo` (with `snapshot_hash` column), structurally immune to legacy v6 drops
- [ ] Modernize `test/core/undo-store.test.ts` and `test/core/hash-store.test.ts` to test against `file_undo` and v7 tables
- [ ] `pnpm run lint && pnpm run typecheck && pnpm test` pass 100% green

## Blocked by
- None (can start immediately)

## Comments

### @Rianico — 2026-09-15T07:38:49Z

Implemented and shipped.

These landed on `dev/mvcc-line-identity` and are now part of `main` @ `bd3a8f2 feat(edit): adopt line-identity MVCC with leases` (with `bb049dc chore: refresh scaffold to current generation (#122)` on top).

Verified at delivery: the Stage-0 harness was green 15/15 (12 canonical probes A–N + 3 contract deliverables), with the four fail-closed probes (A, E, J, K) asserting **both** the rejection code and byte-identical file content.

Four post-implementation review rounds then found and fixed further issues (#88–#121); all of those findings are in the same `main` state. Closing — reopen if you want any part re-examined.
