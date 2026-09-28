# feat: deepen ServedSession — collapse served-state grab-bag (C2)

> **Archived from pre-migration issue #45.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-28T17:37:43Z · state CLOSED · labels: ready-for-agent

## Body

Part of architecture review 2026-08-28 (candidate 2 — Strong). Follows #43 (MutationEngine).

> [!note] Context
> See `CONTEXT.md` (served state, hashline anchors) and ADRs 0002, 0008, 0010. Hot spot: `src/served-state.ts` (559 LOC, 25 exports) — fan-in 8, highest after `utils.ts`.

## Problem
Shallow grab-bag — 25 exported symbols, `interface ≈ implementation`. Every caller threads `sessionKey` + `HashStore` + SQLite truncation manually (`sessionKeyFor(ctx) → getServed(store,key,path)`). ==Leakage== across the seam: store batching, `patchServed` healing, reported-set, TTL sweep all escape to callers. Tests mock `HashStore` heavily to reach healing paths.

Deletion test: deleting `recordDiffServes` moves 3 lines elsewhere — no complexity concentrates. No depth.

## Solution
Deepen into `ServedSession` — `interface: session(path) → { getSpan, record, checkDrift }` (3 methods) hiding `sessionKey`, `HashStore`/`withStore`, `patchServed` healing, truncation, reported-set, TTL. External seam is the session handle; storage is an injected adapter.

> [!tip] Seam discipline
> Two adapters justify the seam: `SQLiteStore` (prod, `src/hash-store.ts`) vs `MemoryStore` (`src/store.ts:MemorySnapshotStore`, already exists) — `local-substitutable` per `[[codebase-design]]`. Internal seams (e.g. `patchServed` healing) stay private.

## Acceptance
- [ ] New `src/served-session/*` (or equivalent) with handle `ServedSession` exposing `getSpan(hashes) → span|null`, `record(diff, opts)`, `checkDrift(current)` — callers stop threading `sessionKey`
- [ ] `src/served-state.ts` thinned to facade re-exporting or retired; no widening of external interface
- [ ] Healing (`patchServed` orphan healing, `buildServedHashIndex`) reachable via memory adapter without real SQLite in tests
- [ ] All callers (`src/read.ts`, `src/edit.ts`, `src/mutation-engine/*`, `index.ts` auto-read, `src/drift.ts`) migrated to handle — no direct `getServed`/`upsertServed`/`recordServesTruncated` leakage
- [ ] `npm run typecheck && npm test` green; keel #3 fact authority (what this session saw) lives inside the module, not duplicated across 8 call sites
- [ ] No ADR conflict

## Files
`src/served-state.ts` (559 LOC) · `src/hash-store.ts` · `src/store.ts` · `src/drift.ts` · `src/read.ts` · `src/edit.ts` · `src/mutation-engine/*`

Closes-by: squash PR with `Closes #NN`.

