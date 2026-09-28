# fix(store): grant leases inside the materialization transaction on read and edit

> **Archived from pre-migration issue #116.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-15T02:38:44Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78. Review 5, spec finding (a): lease upsert is not inside the atomic materialization transaction.

## Spec

- **Materialization** (spec §3.1.2, lines 158-163): the transaction body is … `4. Authoritative Anchor Persistence` → `5. Authoritative Lease Upsert: Served lines are upserted into served_leases with retired_at = NULL.` → `6. COMMIT`. The upsert is *inside* the transaction, before commit.
- **Edit path** (spec §3.2.4 step 4, lines 239-243): after `writeAtomic`, $S_{final}$'s persistence runs `BEGIN IMMEDIATE` (with `withBusyRetry`) and `5. Authoritative Lease Upsert: Upsert newly served diff lines into served_leases with retired_at = NULL and served_snapshot_hash = :snapshot_hash`.

## Implementation (verified on `39f1076`)

`src/snapshot-store/index.ts:428-502` (`materializeSnapshot`) commits `file_snapshots` + `line_lineage` + lease retirement in one `BEGIN IMMEDIATE` / `withBusyRetry` transaction — but it grants leases **only when the caller passes `reServe`**, which today only the undo path does (`reServeRestoredLines` / `grantLeasesInTransaction` at `:405-415`, called at `:450` and `:500`).

- **Read path**: `src/read.ts:112-120` records serves through `session.recordEpoch(...)` *after* materialization — a second transaction.
- **Edit path**: `src/mutation-engine/pipeline.ts:1049-1070` materializes $S_{final}$ with `{ retireLeases: true }`, then `:1075-1095` records the diff serves (which grant the new leases) in a separate transaction.

So leases reach `served_leases` one transaction later than the spec mandates on both paths.

## Remedy

Generalize the existing in-transaction grant machinery — rename `reServe`/`ReServeGrant` to the general notion it already is ("leases to grant inside this materialization transaction"), and pass the served rows from the read path and the edit path. The undo path keeps working unchanged.

Constraints:
- **Do not regress §3.6.2**: on the edit path a store failure after `writeAtomic` must still report success for the bytes on disk plus `DEFERRED_STORE_SYNC_WARNING`, and must never roll back the file. Best-effort serve recording stays best-effort.
- **Pinning correctness**: ADR-0017 — an in-flight materialization names its own snapshot explicitly so the vacuum cannot evict a row whose lease has not been granted yet. Keep that guarantee with the merged grant.
- Retention/vacuum ordering and the `line_id_counters` monotonicity invariant are untouched.

## Acceptance criteria

- On both the read path and the edit path, the new leases are written inside the same `BEGIN IMMEDIATE` transaction as the snapshot + lineage commit — no third transaction remains on either path.
- **Atomicity test**: induce a failure inside the transaction and assert no partial state survives (no snapshot/lineage without its leases, and no leases without their lineage).
- **Binding test**: after a successful read and a successful edit, the served rows' `served_snapshot_hash` matches the snapshot committed in that transaction and `retired_at IS NULL`.
- Undo (`reServe`) behaviour unchanged; §3.6.2 deferred-sync semantics preserved with a test.
- All 15 Stage-0 probes stay green (four fail-closed probes keep byte-identical file assertions); the batch tests (`test/integration/batch-wal-commit.test.ts`, `batch-error-propagation.test.ts`) keep their assertions unweakened.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:54Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
