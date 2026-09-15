# ADR-0017 — Retired epoch concurrency and the bounded LRU snapshot vacuum

Date: 2026-09-12

## Status

accepted; supersedes [ADR-0013](0013-pos-free-roundtrip-optimization.md) (pos-free round-trip optimization with concurrency fallback).

## Context

ADR-0013 answered "was this anchor's line edited by someone else?" with a per-session epoch: `served.snapshotId` compared against the current file identity, a `strictPos` fallback (`from === startLine - 1`) when the two differed, and a per-session `tombstone` of retired hashes to stop a freed anchor from rebinding. All three mechanisms turned out to be dead or harmful. `strictPos` never fired in production (`epochSnapshotId` stayed unpopulated), and where it would fire it is the wrong signal: Probe `E` deletes `f1` and renumbers the file so the target coordinate is *unchanged* (`1 === 1`) while the identity is gone — position equality cannot see it. Conversely an exterior formatter insert moves every coordinate without touching identity, so a position check would reject valid edits. The tombstone was a second, weaker identity store that had to be kept in sync with the hash allocation, and the epoch was per session, so a concurrent writer's re-numbering was invisible to a session that had not re-read.

A separate pressure compounded it: nothing bounded the store. Every materialized version of every touched path stayed in `file_snapshots` forever, so the file-identity epoch's snapshot table and the v7 normalized CAS table both grew without limit — and the counters behind them must never be rewound, so deleting rows casually would hand a live anchor's `line_id` to a different line.
## Decision

Identity replaces the epoch as the concurrency signal. A `line_id` is immutable, allocated only by the atomic `line_id_counters(path)` upsert, and written into `line_lineage(snapshot_id, line_number) -> (line_id, canon_hash, anchor)` for each materialized snapshot. An edit resolves its leased `line_id` through `line_lineage(C)` for the content actually on disk, so exterior shifts rebase silently and identity loss, contested reorders or interior tearing fail closed with `[E_STALE_RANGE]`; the edit pipeline never populates an epoch, so `strictPos` no longer gates anything, and the tombstone survives only as the hash-allocation guard it always was — not as a second identity authority that a lease has to agree with.

Retention is then safe to enforce, and it is enforced by a global LRU vacuum that `src/snapshot-store/vacuum.ts` owns and exports. The store budgets 50 MB of lineage bytes (`≈ 40 × line_count` per version) and `min(10, max(2, floor(10 MB / snapshot_lineage_bytes)))` versions per path; unpinned snapshots are evicted oldest-`created_at` first across all paths until both bounds hold. A snapshot is pinned, and therefore never evicted, while an active `served_leases` row can still resolve to it (within the 7-day session TTL), while `file_undo.snapshot_hash` names it as a restore target, or while a lease that points at it was retired inside the 1-hour grace. When every remaining candidate is pinned the vacuum defers and the store soft-overflows instead; that deferred state is reported (and is expected to lapse as leases expire) rather than resolved by evicting a pin. `pruneMissingAll` runs the same invariant from the other side: it purges a disk-deleted path's snapshots and lineage, and drops that path's `line_id_counters` row only when the path holds no snapshot and no lease.

### Ownership of the vacuum

Ownership follows the data that is deleted, not the caller that asks for the pass. `vacuumSnapshots` is defined and exported by `src/snapshot-store/vacuum.ts` — invoked by the store module (`src/snapshot-store/index.ts`) after an authoritative materialization, and by the session module at the store-open boundary — because the sweep is pure retention of the CAS snapshot tier: it reads `file_snapshots` rows, prices them from their `line_lineage`, and deletes both. Its budget constants and its `DELETE` statements therefore live with the store that owns those tables: the constants are module-level policy in `vacuum.ts`, not injectable call-site options. `served_leases` is consulted only to compute the pin set — an in-flight materialization names its own snapshot explicitly so the sweep cannot evict a row whose lease has not been granted yet. The session module keeps only session/lease concerns: it asks for a pass at its deterministic boundary (store open) and owns none of the retention policy.

Spec §6 Stage-3 "Seams" (spec L705-706) lists `src/served-session/session.ts` among the files that stage touched. That list is a plan-time roadmap of files to touch, not an ownership invariant, so relocating the sweep into the snapshot store does not contradict it; the boundary is enforced by `test/arch/c3-served-session-deepening.test.ts`. Review 3 finding (b)2 — revert the relocation — is declined by operator decision: reverting a reviewed, merged, guard-protected move would be ping-pong, and the Feature Envy that motivated the move (snapshot-store SQL prepared in the session module) would return.

## Considered Options

- **Keep the epoch as a concurrency signal and add leases alongside it** — rejected: two identity authorities drift, and the epoch's failure mode (position equality) is precisely the P0 it was meant to prevent.
- **Keep the per-session tombstone as a union with lease resolution** — rejected: a tombstone blocks a hash for a whole session; a lease resolution is per anchor and per served snapshot, so it retires exactly the identities that are gone.
- **Unbounded store ("storage is free")** — rejected: the CAS database is shared across sessions, worktrees and projects, and an unbounded shared store turns a free-runtime assumption into a disk and `stat` cost for every future session.
- **Hard 100 MB cap that evicts pinned snapshots when exceeded** — rejected: a pinned snapshot is the only copy of the lineage a live anchor resolves through; evicting it converts a slow store into a spurious `E_STALE_RANGE` retry loop, which is a model-context cost the spec ranks above storage.
- **Drop counters together with every pruned path** — rejected: a lease that survived the purge (or a race with a concurrent writer) would have its id space re-issued from `1`, so the counter is only released when the path holds neither snapshot nor lease.

## Consequences

- `src/snapshot-store/vacuum.ts` owns the vacuum: the pass runs after every authoritative materialization and at store open, and its failure is caught there so retention can never fail a read or edit that already committed. The session module only invokes that pass at the boundary it owns and holds no retention state of its own.
- ADR-0013's `served.snapshotId` / `served.retired` columns survive only as v6 compatibility shells; the live identity authority is `line_lineage` + `served_leases`.
- Eviction is observable: `VacuumResult` reports `totalBytes`, `pinnedBytes`, `deferredBytes` and `overSoftOverflow`, so a store that cannot converge (all pins) says so instead of silently growing.
