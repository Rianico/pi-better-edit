# Arch C2: One apply-one-edit composition — execPipeline and processFile share a per-edit primitive

> **Archived from pre-migration issue #26.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-15T03:47:48Z · state CLOSED · labels: ready-for-agent

## Body

Part of #20

Blocked by: C1, C3, C6 tickets (C1: pure hashline + injected store; C3: `recordDiffServes` helper; C6: `buildToolDef` split so the composition refactor touches a smaller region of edit.ts).

## Goal
One "apply one edit" composition instead of two. The deepest, most-tested seam in the codebase — `execPipeline` in `src/edit.ts` (read → served → resolve → verify → apply → rehash → count → drift) — is NOT used by `batch-edit.ts`; `processFile` re-implements the identical sequence. Two implementations of "verify + apply one edit against current content and produce the next state" must be kept behaviorally in sync.

## Friction (why)
- `processFile` (src/batch-edit.ts ~lines 206-467) re-does: `readNormFile` → `loadServed` → per-item `resEdit` → `applyEdit` → `collectRemovedHashes` + `lineHashes` (with `lastApplied` threading) → `countLineChanges` → `scanDrift`, plus its own echo-on-reject serving and its own union-range drift computation.
- Leaf functions are shared (`collectRemovedHashes`, `countLineChanges`, `resolveMissingPath` imported from edit.ts), but the orchestration around them is duplicated.
- The noop-loop policy is written twice inline (edit.ts execute vs processFile) with *already-diverged* message text; the `recordEchoServes`-before-throw side effect is easy to forget in one of the two paths.

## Solution
- Extract a shared per-edit primitive — "apply one edit to content/hashes, produce next state" — returning content, hashes, range, noop, warnings, autoFixes. Both compositions call it.
- The batch's genuinely different semantics stay in batch-edit: all-or-nothing, per-file grouping, undo staging before any write, rollback, union range for the drift notice.
- Fold the noop-loop policy (warn at 2, reject at threshold, echo-and-serve before throw) into one place.
- Where C3's `recordDiffServes` exists, route post-apply serve updates through it.

## Files
`src/edit.ts` (execPipeline), `src/batch-edit.ts` (processFile), new shared module (e.g. `src/edit-pipeline.ts`), `src/noop-guard.ts` (policy), `src/edit-response.ts`.

## Acceptance
- Single-edit and batch behaviors unchanged: `test/tools/edit*.test.ts`, `test/tools/batch-edit*.test.ts`, `test/integration/*` pass.
- The per-edit algorithm exists once; grep shows one implementation of the read→verify→apply→rehash→drift sequence.
- Noop-loop policy written once (edit + batch share it); `test/tools/edit.noop-loop.test.ts`, `test/tools/edit.noop-warning.test.ts`, `test/tools/batch-edit.test.ts` pass.
- `npm run typecheck && npm run lint && npm test` green.

## Constraints
ADR-0001 (reject-and-serve inside the composition, only the tool's own serves count) and ADR-0002 (session-keyed) hold. All-or-nothing batch semantics are non-negotiable.


## Comments

### @Rianico — 2026-08-15T06:00:40Z

Done — merged to main as c0c4ee0 (wt merge, squash). New src/edit-pipeline.ts: loadEditFile + applyOneEdit shared by execPipeline (edit) and processFile (batch); runNoopPolicy folded into noop-guard.ts (single-vs-batch framing via flag); batch keeps all-or-nothing/undo staging/rollback/union-range drift. Net -77 lines. Verified: typecheck, lint, 997 tests, coverage 93.15/93.98/93.03/88.93.
