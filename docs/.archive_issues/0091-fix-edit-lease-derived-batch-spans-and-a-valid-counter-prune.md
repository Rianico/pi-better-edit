# fix(edit): lease-derived batch spans and a valid counter prune guard

> **Archived from pre-migration issue #91.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T08:03:07Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

Two independent spec deviations in the batch/commit path.

## (a) Batch overlap detection uses a raw disk index instead of lease-derived spans
**Rule**: spec section 3.2.1 - "Each edit `e_k` first resolves its rebased baseline coordinate `s'_k` in `S_curr` via its immutable lease `line_id`"; section 3.2.3 - the whole batch is rejected when two spans overlap or nest.

**Violation**: `src/mutation-engine/pipeline.ts` L398-400 - `baselineSpans` uses `originalHashes.indexOf(...)` on disk presentation hashes. An anchor shifted externally yields `from < 0` and the `continue` silently skips the overlap check, and duplicate canons resolve to their first occurrence instead of the leased coordinate.

**Remedy**: resolve each span through the same lease-derived `s'_k` coordinates the apply path uses, and reject a batch whose spans overlap or nest before any mutation.

## (b) `pruneMissingAll` counter deletion guard is invalidated by delete-before-count
**Rule**: spec section 3.6.3 - "`line_id_counters` is strictly monotonic and **never reset or dropped** while any snapshot or lease for that path exists. `pruneMissingAll` drops counter rows only when a path has zero snapshots, zero leases, and is absent from disk."

**Violation**: `src/snapshot-store.ts` L569-578 - `pruneMissing` calls `deleteByPath` and `deleteServedByPath` before evaluating `countSnapshots(path) === 0 && countLeases(path) === 0`. Both counts therefore always read 0 and the counter row is wiped for every missing path, so an id block can restart and a surviving anchor's `line_id` could be re-issued.

**Remedy**: capture the pre-delete state (or evaluate the guard before deleting) so the counter row survives whenever the path had snapshots or leases; drop it only for a path that was already empty and is absent from disk.

## Acceptance criteria
- Overlap/nesting detection operates on lease-resolved baseline spans; a batch whose spans overlap after an external shift is rejected with `E_BATCH_ABORT` before any mutation, and no edit in that batch reaches the file.
- Duplicate canons in a batch resolve through the leased identity, never through `indexOf` first-match.
- A test proves `pruneMissing` preserves the `line_id_counters` row for a path that had snapshots or leases before pruning, and still drops it for a path that had none.
- The 15-test Stage-0 harness stays green (`test/integration/p0-drift-line-identity.test.ts`), including the byte-identity assertions of the fail-closed probes.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:39:29Z

Delivered.

Merged into `dev/mvcc-line-identity` and squashed into `main` @ `bd3a8f2` (this remediation is included in that squash). Verified at delivery by the composite gate — `pnpm run lint` / `format` / `typecheck` / `test:coverage` (coverage ≥ 85% lines/statements/functions, ≥ 80% branches) — plus the 15-test Stage-0 harness with the four fail-closed probes keeping their byte-identity assertions.

Closing.
