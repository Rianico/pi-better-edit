# ADR-0042 — Retention runs only on fresh snapshot commits

Date: 2026-10-20

## Status

accepted — refines the trigger clause of
[ADR-0017](0017-lru-vacuum-supersedes-epoch-concurrency.md); the 50 MB budget, per-path
floor, 7-day TTL and 1-hour grace are unchanged. Complements the janitor in
[ADR-0037](0037-store-janitor-lifecycle-maintenance-model.md).

## Context

`materializeSnapshot` and `materializeBatch` ran `vacuumSnapshots` after every
authoritative materialization, including **adoption** of an already-committed
snapshot. Adoption is the read-path cache hit: it adds no row, so it cannot grow
the store's byte budget.

The vacuum's pin probe asks, per committed snapshot, "does this
`(path, snapshot_hash)` still have a lease or an undo target?". `served_leases`
holds one row per served line, so a hot path can hold thousands of leases.
`idx_leases_file_retired(file_path, retired_at)` could narrow the probe only to
the path, not to the snapshot hash; each snapshot therefore re-scanned that
path's whole lease set.

Measured on a `.backup` copy of a real 518 MB store (2,531 snapshots, 408k
active leases, 229k of them older than the 7-day pin TTL):

- cold `listPinned`: **2.2 s**, warm: **337 ms** before the index;
- warm after covering `(file_path, served_snapshot_hash)`: **35 ms**;
- read-path adoption: **0.1 ms** after both fixes;
- fresh insert + vacuum: **~36 ms** after both fixes;
- first open (index build + one vacuum): **2.6 s**, one-time.

Every `read` and `edit` paid the pin scan, so a large store made the tools feel
like the machine was stuck. This was diagnosed with `EXPLAIN QUERY PLAN` and
direct timings against a store copy, not a micro-benchmark: the hotspot was
SQLite, not TypeScript compilation.

## Decision

1. The schema owner creates a covering index:

   ```sql
   CREATE INDEX idx_leases_file_snapshot
   ON served_leases (file_path, served_snapshot_hash, retired_at, updated_at);
   ```

   The vacuum pin probe must keep the `served_snapshot_hash` equality; a
   path-only index is not sufficient. `HASH_STORE_VERSION` is bumped so an
   existing store rebuilds the index on its next open.

2. A materialization runs retention only when **that transaction inserted at
   least one fresh snapshot**. Adoption owes no sweep. Store open still runs
   `vacuumSnapshots`, so deferred reclamation eventually happens even in a
   read-only session.

3. A fresh commit still sweeps exactly once, after its transaction, and still
   protects every in-flight snapshot id. A conflict retry that inserts sweeps
   in the retry; a retry that adopts does not sweep. The just-inserted row and
   its leases remain protected.

The 50 MB global budget, 10 MB per-path budget, 2–10 version floor, 7-day lease
TTL, 1-hour retired-lease grace and soft-overflow warning are unchanged.

## Consequences

- Reads of unchanged content no longer pay an O(store) pin scan.
- The budget can be exceeded only by a fresh commit, which always sweeps, so
  the retention invariant is preserved exactly where it can be violated.
- Newly unpinned rows may wait until the next fresh commit or store open to be
  evicted. This only defers reclamation; it cannot grow the store.
- Old stores take a one-time open pause to build the index and re-stamp.
