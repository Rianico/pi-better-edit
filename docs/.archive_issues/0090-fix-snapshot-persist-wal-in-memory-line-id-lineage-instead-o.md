# fix(snapshot): persist WAL in-memory line_id lineage instead of re-pairing

> **Archived from pre-migration issue #90.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T08:03:05Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## Rule (spec Revision 22)
Spec section 3.2 step 2: "**Survivor Line ID Preservation**: Surviving unmodified lines preserve their exact `line_id`s from the working buffer map (0% diffing, 100% exact)." Section 4 seam map: "WAL Lineage Commit: writes `S_final` lineage directly from the in-memory map".

## Violation
`src/mutation-engine/pipeline.ts` L835 - post-write persistence delegates to `upsertSnapshotFor` (`src/snapshot-store.ts` L461), which re-runs patience diffing against `S_latest` via `pairAgainstLatest` (`src/snapshot-store.ts` L329) instead of persisting the working buffer's exact in-memory `line_id` map. The commit path therefore re-derives identities it already knows, which is precisely the mechanism the spec replaces.

## Remedy
Persist `S_final`'s `line_lineage` directly from the in-memory working-buffer map:
- surviving lines keep the `line_id` the working buffer assigned them - no `pairSnapshots`/`pairAgainstLatest` call on the edit commit path;
- newly inserted/replaced lines allocate exclusively through the universal counter upsert on `line_id_counters`, exactly `N_inserted` ids in one atomic statement;
- the `(path, C_final)` committed-snapshot cache guard still runs first (cache hit -> adopt canonical `snapshot_id` + lineage, zero allocations);
- the authoritative `retired_at` writer and the `served_leases` upsert still run.

## Acceptance criteria
- The edit commit path persists lineage from the in-memory map; a test demonstrates a batch in which re-pairing against `S_latest` would yield a different identity than the working buffer (for example a batch deleting the earlier of two identical canon lines) and asserts the working-buffer identity is preserved.
- Counter allocation remains the sole id source and stays strictly monotonic; the pre-allocation cache guard still prevents `UNIQUE (path, snapshot_hash)` violations and counter waste on a reversion.
- Probes I, M and N in the Stage-0 harness stay green, as do all 15 harness tests; read-path materialization still uses `pairSnapshots`.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:39:26Z

Delivered.

Merged into `dev/mvcc-line-identity` and squashed into `main` @ `bd3a8f2` (this remediation is included in that squash). Verified at delivery by the composite gate — `pnpm run lint` / `format` / `typecheck` / `test:coverage` (coverage ≥ 85% lines/statements/functions, ≥ 80% branches) — plus the 15-test Stage-0 harness with the four fail-closed probes keeping their byte-identity assertions.

Closing.
