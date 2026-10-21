# ADR-0046 — Compaction runs after the maintenance sweep

Date: 2026-10-21

## Status

accepted — a step of the store janitor
([ADR-0037](0037-store-janitor-lifecycle-maintenance-model.md)), scheduled by
the same off-path lifecycle events and gated by the same throttle. Consumes the
free pages that hard-expiry GC creates
([ADR-0045](0045-ttl-ends-lease-resolution.md)). Supersedes nothing.

## Context

Deleting rows returns their pages to SQLite's **freelist**, not to the
filesystem: the database file keeps its high-water mark. After the #160 GC the
issue's store stayed at ~583 MB with ~296 MB of free pages; only `VACUUM`
rebuilt it to ~287 MB, and that rewrite took ~2.9 s. Without a reclaim step the
file never shrinks however many leases expire.

`VACUUM` has hard constraints that shape where it may run:

- it cannot run inside a transaction;
- it takes the store's write lock for the whole rebuild, so it must not be
  triggered by a read/edit tool call;
- once started it is not interruptible by this codebase (SQLite owns it), though
  it is transactional: a crash or kill leaves the previous database intact.

The janitor already owns the off-path maintenance boundary
(`session_start`/`session_shutdown`, throttled), and the GC that creates the
free pages runs there. Compaction belongs in the same pass.

## Decision

1. **Compaction is the last step of a maintenance pass.** `runJanitor` runs it
   after `collectGarbage`, in autocommit, only when the GC did not throw. Read,
   edit, watch and the store open never run it. No new event and no new timer —
   the existing janitor cadence decides when it may happen.

2. **It is gated on what it can reclaim.** A `VACUUM` costs a full file rewrite,
   so the pass compacts only when free pages are at least **25 % of the file**
   and at least **1 MB** of the file. Otherwise the outcome says
   `no-free-pages` or `below-threshold` and no statement is issued — the no-op
   pass is free.

3. **A contended store defers; it does not wait.** Starting the rewrite requires
   the write lock. The pass sets a **100 ms** busy budget for that acquisition
   (temporarily, restoring the store's own budget afterwards) and reports
   `reason: "busy"` when a rival writer holds the store; the next maintenance
   pass retries. A caller that hands in an open transaction gets
   `reason: "in-transaction"` instead of a thrown SQLite error.

4. **The outcome is the metric and the log.** `JanitorOutcome.compacted` carries
   `{ ran, reason?, freeBytesBefore, reclaimedBytes, error? }`. A successful
   rewrite logs `[store-janitor] compacted store: reclaimed N bytes
   (before -> after pages of size)`; a deferral logs its reason; a failure logs
   the error and returns `reason: "failed"` with the message. No failure is
   thrown out of a lifecycle hook.

5. **No schema change.** The policy is code; `HASH_STORE_VERSION` stays 11.

## Consequences

Measured with `node scripts/bench-compact.mjs` (the #160 fixture shape: 200 paths
× 5 versions × 2,000 leases, 57 % expired active; WAL checkpointed before every
size reading; same script at both commits):

| measurement | before (3ae75c4) | after |
| --- | ---: | ---: |
| leases removed by the pass | 228,000 | 228,000 |
| compaction step | absent | ran, **76.0 MB reclaimed** |
| file after the janitor pass | 126.3 MB | **50.3 MB** |
| file after an explicit VACUUM | 50.3 MB (323 ms) | 50.3 MB (389 ms) |
| janitor pass wall time | 1.5 s (GC only) | 1.9 s (GC + rewrite) |

The issue's 583 → 287 MB shape (≈half) is reproduced at fixture scale; the
absolute megabytes track the seed. The pass pays ~0.4 s of rewrite on top of the
GC to reclaim 60 % of the file, and a follow-up manual VACUUM finds nothing left.

- Operators no longer need a manual `VACUUM`; the file shrinks on the next
  maintenance pass after a large GC.
- A concurrent writer may wait up to the compaction's rewrite time (the store's
  own busy-retry budget covers it) and a contended *janitor* defers instead of
  blocking a session. Compaction never runs while this session is inside a tool
  call.
- A contended or failed compaction leaves the store exactly as it was and is
  retried on the next cadence; the free pages remain available for that retry.
- The 25 %/1 MB gate means small GCs do not rewrite large files; the reclaimable
  bytes wait until they are worth the rewrite.
