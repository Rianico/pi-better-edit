# feat: deepen MutationEngine — collapse edit-pipeline monolith (C1)

> **Archived from pre-migration issue #43.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-28T17:03:34Z · state CLOSED · labels: ready-for-agent

## Body

Part of architecture review 2026-08-28 (candidate 1 — Strong).

> [!note] Context
> See `CONTEXT.md` vocabulary (hashline anchors, served state, payload contract) and ADRs 0001–0010. Hot spot: `src/edit-pipeline.ts` (`runMutations` — 244 LOC, fanout 25, complexity 32) dominates `git log --oneline --stat`.

## Problem
Mutation lifecycle (`load → parse → validate → verify → mutate → guard → persist → record`) lives in one shallow-but-tall module (`src/edit-pipeline.ts` — 787 LOC). `interface ≈ implementation`: `apply(req,cwd,opts)` + `previewEdits` thread the same six concerns via one 244-line function. ==Locality broken== — a drift/undo bug forces reading 400 LOC. `The interface is the test surface` violated: tests drive `apply()` through real `SQLite` + `xxhash`.

Deletion test: deleting `runMutations` scatters its 6 call sites — no complexity concentrates.

## Solution
Deepen into `MutationEngine` — `interface: execute(request,cwd) → Result` + `preview(request,cwd) → Result` — hiding `load→validate→verify→mutate→guard→persist→record` inside. Internal seams (`validate`, `verify`, `mutate`, `guard`, `persist`, `record`) stay private — not exported. Share one path for single + batch edits. Keep keel spine small: one new load-bearing seam.

> [!tip] Seam discipline
> Two adapters justify the seam: `SQLiteSnapshotStore` (prod) vs `MemorySnapshotStore` (already in `src/store.ts`) — `local-substitutable` per `[[codebase-design]]` deepening categories. Otherwise in-process.

## Acceptance
- [ ] `src/edit-pipeline.ts` replaced or thinned to a delegating facade; new `src/mutation-engine/*` (or equivalent) owns the lifecycle behind `execute`/`preview`
- [ ] Discriminated `Result = { ok:true, diff, servedRows } | { ok:false, code, echo }` replaces loose `any`/`isError` threading — exhaustive switch in callers
- [ ] `preview` and `apply` share one internal path (no duplicated branching)
- [ ] `npm run typecheck && npm test` green; coverage thresholds held
- [ ] Old pipeline unit tests replaced by tests at the deepened interface (`interface is the test surface` — replace, don't layer)

## Files
`src/edit-pipeline.ts` · `src/hashline/apply.ts` · `src/noop-guard.ts` · `src/drift.ts` · `src/edit-undo.ts` · `src/hashline/resolve.ts`

Closes-by: squash PR with `Closes #NN`.

