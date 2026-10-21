# ADR-0045 — The 7-day TTL ends lease resolution (hard expiry)

Date: 2026-10-21

## Status

accepted — supersedes the TTL clause of
[ADR-0017](0017-lru-vacuum-supersedes-epoch-concurrency.md) that made the
session TTL affect **pin authority only**. Implements the human decision on
#159 (option A, hard expiry); the 1-hour retired-lease grace and the existing
dangling/foreign-generation sweeps are unchanged. Complements
[ADR-0037](0037-store-janitor-lifecycle-maintenance-model.md) (where the GC
runs) and [ADR-0042](0042-retention-runs-only-on-fresh-snapshot-commits.md)
(when retention runs).

## Context

`served_leases` holds one row per served line, and a hot store accumulates them:
the live copy referenced by #160 held **400k leases, ~229k of them active
(un-retired) but older than the 7-day session TTL**, about 1.2 GB. The vacuum's
pin probe asks, per committed snapshot, "is there a live lease for this
`(path, snapshot_hash)`?" — the TTL already excluded expired active rows from
that answer, so they granted nothing, resolved nothing anyone still needed, and
were never deleted. They simply inflated every lease index and made the probe
walk them on every fresh commit: serving 600–1200 rows paid 19–65 ms, and the
vacuum's p95 was ~39 ms on the issue's fixture.

Two authorities had drifted apart: the vacuum treated an expired active lease as
dead (no pin), while the read/edit grant path still resolved it (it trusted any
un-retired row). #159 asked which one is right; the decision is that the TTL is
a hard expiry for both.

## Decision

1. **An active lease past the TTL loses both authorities.** An un-retired
   `served_leases` row whose `updated_at < now - SERVED_TTL_MS` no longer pins its
   snapshot (this was already true) and no longer resolves: the read/edit grant
   path treats it as absent, exactly like an unknown anchor. It is also eligible
   for maintenance GC. A lease at or inside the boundary (`updated_at ===
   now - SERVED_TTL_MS`) still resolves.

2. **One boundary, three readers.** `servedLeaseExpiryCutoff(now)` in
   `src/hash-store.ts` is the single definition. Two SQL predicates —
   `EXPIRED_ACTIVE_LEASE_SQL` (the GC family) and `RESOLVABLE_LEASE_SQL` (the
   complement) — and the JS helper `isExpiredActiveLease` all derive from it:
   - the **grant path** (`leaseSpanSource`) drops an expired active lease before
     it can become a `LeaseIdentityView`;
   - the **janitor** deletes `EXPIRED_ACTIVE_LEASE_SQL` rows in bounded batches;
   - the **vacuum's pin probe** uses `RESOLVABLE_LEASE_SQL` for the active half
     of its two-table predicate, so pin and resolution cannot disagree again.

3. **Retirement is a different terminal state.** A retired lease is judged by its
   own `retired_at` grace (`VACUUM_RETIRED_PIN_MS`, 1 hour), never by the
   `updated_at` TTL — a retired row whose `updated_at` is ancient still resolves
   (with `retiredAt` set) inside its grace, and a retired row past the grace is
   GC-eligible regardless of `updated_at`.

4. **GC is off the tool path and bounded.** `collectGarbage` deletes the
   expired-active family with the janitor's existing `deleteInBatches` idiom
   (`rowid IN (SELECT ... LIMIT batchSize)`), after the foreign/dangling sweeps,
   on `session_start`/`session_shutdown` only. Read, edit, watch and the store
   open never prune leases. The delete is a full-table predicate; it runs once
   per maintenance pass, not per tool call.

5. **No guarantee past the TTL.** An anchor served more than 7 days ago may
   fail closed (`E_UNKNOWN_ANCHOR` on an edit, a "window omitted" warning on an
   `around_anchor` read) even when its snapshot still exists, because the lease
   no longer resolves. The remedy is a fresh read; this is the decided trade for
   a bounded lease table. The store's snapshots are unaffected — only the
   lease's authority lapses.

No schema change: the predicates use existing columns and indexes
(`idx_leases_file_snapshot` keeps the pin probe covered — the query plan still
shows `retired_at=? AND updated_at>?` on that index), so `HASH_STORE_VERSION`
stays 11.

## Consequences

Measured with `node scripts/bench-lease-gc.mjs` (200 paths × 5 versions × 2,000
leases = 400k rows, 57% expired active; same script at both commits; vacuum p50/p95
over 20 passes):

| measurement | before (2c83761) | after |
| --- | ---: | ---: |
| lease rows after one janitor pass | 400,000 | **172,000** (228,000 removed) |
| vacuum p50, before → after the pass | 22.4 → 22.1 ms | 20.1–22.4 → **2.6–3.0 ms** |
| vacuum p95, before → after the pass | 22.7 → 22.7 ms | 20.3–22.9 → **2.9–4.5 ms** |

The ranges are run-to-run variance of two captures each; the parent commit's
pass removes nothing, so its "after" equals its "before".

- The expired family is deleted once, off-path; every later fresh commit's pin
  probe walks only the rows a live session can still resolve. The absolute
  numbers track the fixture (the issue's 39 ms was a larger/real store; the 5x
  ratio is the invariant).
- A session that idles longer than the TTL loses its anchors on the next edit —
  fail-closed and recoverable by re-reading. Sessions that idle less than that
  are unaffected.
- The janitor's `expiredLeases` counter now covers both expiry families (active
  past TTL + retired past grace); the outcome shape is unchanged.
- Old stores need no migration: expired rows are deleted by the first
  maintenance pass, and until then they already behave as expired.
- A future change to the boundary must go through `servedLeaseExpiryCutoff`; the
  boundary tests (`test/core/lease-hard-expiry.test.ts`) pin exactly-TTL,
  just-inside, just-outside and the retired grace on all three readers.
