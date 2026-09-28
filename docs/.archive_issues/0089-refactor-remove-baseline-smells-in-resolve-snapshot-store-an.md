# refactor: remove baseline smells in resolve, snapshot-store and patience-pairing

> **Archived from pre-migration issue #89.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T08:03:02Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

Three baseline smells reported by the post-implementation standards review. Behaviour must not change.

## 1. Duplicated code - `src/hashline/resolve.ts` L106-128
`uniqueAnchorLine` (L106) and `uniqueServedPosition` (L118) duplicate an identical single-occurrence scan:

```ts
for (let i = 0; i < arr.length; i++) {
  if (arr[i] !== anchor) continue;
  if (found !== undefined) return undefined;
  found = i + 1;
}
return found;
```

**Remedy**: extract one generic helper, e.g. `uniqueItemPosition<T>(arr: readonly T[], item: T): number | undefined`, and have both call sites use it.

## 2. Data clump - `src/snapshot-store.ts` L400-450
`(path, snapshotHash, lineCount, hashes, content)` travels together through `materializeSnapshot` (L358), `upsertSnapshot` (L438) and `upsertSnapshotFor` (L461).

**Remedy**: bundle them into a cohesive `SnapshotDescriptor` parameter object.

## 3. Mysterious name - `src/hashline/patience-pairing.ts` L69-74
Single-letter keys obscure coordinate semantics:

```ts
interface WeightedPin { p: number; c: number; displacement: number; }
const reversed: WeightedPin[] = weighted.map((pin) => ({ p: pin.p, c: -pin.c, displacement: pin.displacement }));
```

**Remedy**: rename `p` -> `prevLine` and `c` -> `currLine` (throughout the module, including the patience-sorting comparators).

## Acceptance criteria
- Behaviour-preserving refactor only: no change to pairing results, resolution outcomes, snapshot/pairing semantics or any error code.
- The three extractions above are in place; no duplicated scan loop and no single-letter pin coordinate keys remain.
- All existing tests stay green, including the 15-test Stage-0 harness `test/integration/p0-drift-line-identity.test.ts`.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green, coverage thresholds still cleared.


## Comments

### @Rianico — 2026-09-15T07:39:23Z

Delivered.

Merged into `dev/mvcc-line-identity` and squashed into `main` @ `bd3a8f2` (this remediation is included in that squash). Verified at delivery by the composite gate — `pnpm run lint` / `format` / `typecheck` / `test:coverage` (coverage ≥ 85% lines/statements/functions, ≥ 80% branches) — plus the 15-test Stage-0 harness with the four fail-closed probes keeping their byte-identity assertions.

Closing.
