# refactor(snapshot-store): split the module and drop unconfigured vacuum options

> **Archived from pre-migration issue #102.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T16:13:41Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## Findings
1. **Divergent change** - `src/snapshot-store.ts` is a ~907-line module doing five jobs: CAS snapshot storage, `line_id_counters` atomic allocation, diff-pairing dispatch, LRU vacuum eviction policy, and legacy v6 schema migration.
2. **Speculative generality** - `VacuumOptions` (`src/snapshot-store.ts` L776-787) exposes eight optional budgeting/TTL fields (`globalBudget`, `perPathBudget`, ...) that no production call site configures; they exist only for test parameter injection.

## Remedy
1. Split the module into a directory module, per the review: `src/snapshot-store/{index.ts,vacuum.ts,migrate.ts}` - storage/allocation/pairing dispatch in `index.ts`, LRU eviction policy in `vacuum.ts`, legacy v6 migration in `migrate.ts`. The public import path `src/snapshot-store` must keep resolving for every existing consumer via `index.ts` re-exports.
2. Hardcode the production vacuum constants (global budget, per-path retention, retirement grace, lease TTL) as module-level constants in `vacuum.ts`. Audit every `VacuumOptions` field against actual test call sites and keep **only** the overrides a test genuinely exercises; delete the dead fields rather than leaving them for symmetry.

## Acceptance criteria
- `src/snapshot-store/` exists as a directory module with the three files above; no single file carries storage, eviction and migration responsibilities together.
- Every existing consumer still imports from `src/snapshot-store` and resolves unchanged; no consumer imports a sub-path unless it belongs to that concern.
- Production constants are module-level and not injectable; the surviving `VacuumOptions` fields each have a live test call site, and nothing else remains.
- Vacuum behaviour is unchanged: global budget, per-path retention and the pinning rules (active unswept lease, `file_undo` restore target, 1-hour retirement grace) all still hold, and existing vacuum tests keep their assertions.
- The 15 Stage-0 probes stay green.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:06Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
