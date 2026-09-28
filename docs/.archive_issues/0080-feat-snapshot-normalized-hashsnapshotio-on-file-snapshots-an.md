# feat(snapshot): normalized HashSnapshotIO on file_snapshots and line_lineage (T2)

> **Archived from pre-migration issue #80.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-12T07:37:05Z · state CLOSED · labels: ready-for-agent

## Body

## Parent
#78

## What to build
Replaces legacy serialized JSON blobs with normalized CAS snapshot records. Re-implements `src/snapshot-store.ts` (`getSnapshot` / `upsertSnapshot`) backed directly by `file_snapshots` and `line_lineage` (ordered by `line_number ASC`), standardizes content checksums on `CANON_VERSION:xxh64`, and implements first-ever read materialization using strictly monotonic `line_id_counters` block allocation (`RETURNING (next_id - :N) AS start_id`).

## Acceptance criteria
- [ ] Standardize content checksum format to `CANON_VERSION:xxh64(content)`
- [ ] Implement `HashSnapshotIO` in `src/snapshot-store.ts` backed by `file_snapshots` and `line_lineage`, eliminating serialized JSON blobs
- [ ] Ensure `getSnapshot` returns verbatim presentation anchors from `line_lineage.anchor` on cache hit
- [ ] Implement first-ever materialization allocating $N$ consecutive `line_id`s from `line_id_counters(path)` via atomic upsert (`RETURNING (next_id - :N) AS start_id`)
- [ ] Modernize raw SQL tests in `test/core/snapshot-store.test.ts:98,138`, `test/tools/preview-no-persist.test.ts:90,106`, and `test/core/whitespace-insensitive-canon.test.ts:119,135`
- [ ] `pnpm run lint && pnpm run typecheck && pnpm test` pass 100% green

## Blocked by
- #79

## Comments

### @Rianico — 2026-09-15T07:38:52Z

Implemented and shipped.

These landed on `dev/mvcc-line-identity` and are now part of `main` @ `bd3a8f2 feat(edit): adopt line-identity MVCC with leases` (with `bb049dc chore: refresh scaffold to current generation (#122)` on top).

Verified at delivery: the Stage-0 harness was green 15/15 (12 canonical probes A–N + 3 contract deliverables), with the four fail-closed probes (A, E, J, K) asserting **both** the rejection code and byte-identical file content.

Four post-implementation review rounds then found and fixed further issues (#88–#121); all of those findings are in the same `main` state. Closing — reopen if you want any part re-examined.
