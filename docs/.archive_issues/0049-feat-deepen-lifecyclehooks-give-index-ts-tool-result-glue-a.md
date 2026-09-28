# feat: deepen LifecycleHooks — give index.ts tool_result glue a real seam (C4)

> **Archived from pre-migration issue #49.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-28T18:04:05Z · state CLOSED · labels: ready-for-agent

## Body

Part of architecture review 2026-08-28 (candidate 4 — Worth exploring). Follows #43, #45, #47.

> [!note] Context
> `index.ts` (130 LOC wiring) owns `tool_result` handlers for `write` and `edit/undo` — duplicates `try{ recordDiffServes }catch` for two paths, threads `toCwd`→`resolveTarget`→`valAccess` sequencing, builds preview via `fmtReadPreview`, and is untestable through any module's interface (needs real `ExtensionAPI`). No second adapter → hypothetical seam.

## Problem
Thin adapter with large interface — knows 10 internal modules (`read`, `served-state`, `snapshot-store`, `edit-undo`, `write-hook`, `paths`, `file-kind`, `file-reader`, `hash-store`, `edit-response`). ==Leakage== across the seam: `tool_result` callback's `write` path vs `edit` path duplicate serve-recording; recovery (`catch(console.error)`) scatters. Deletion test fails: deleting `index.ts` wiring inlines it into pi — no complexity concentrates.

## Solution
Deepen into `LifecycleHooks` — `port: onWrite(path) → Preview` / `onEdit(details) → {content, serves}` / `onToolResult(event, ctx) → dispatch` — hiding `toCwd`/`resolveTarget`/`valAccess` sequencing, `loadFileKindAndText`+`readNormFile`+`fmtReadPreview`+`recordDiffServes` choreography, and best-effort recovery ownership. Two adapters justify the seam: real `ExtensionAPI` (prod, `registerLifecycleHooks(pi)`) vs in-memory test harness calling same interface — keel #3/#4/#5 explicit writers and recovery.

> [!tip] Seam discipline
> `ports & adapters` — `index.ts` owns wiring only (thin by design), `LifecycleHooks` owns behaviour + recovery (swallow `record` failures, owned once). No new surface — existing `regRead`/`regEdit`/`registerWriteHook` remain.

## Acceptance
- [ ] New `src/lifecycle-hooks/*` (or equivalent) with port `LifecycleHooks` (`onWrite`, `onEdit`, `onToolResult` or equivalent) + adapters: `ExtensionAPI` vs test harness
- [ ] `index.ts` thinned to declarative wiring (`regRead`, `regEdit`, `regEditUndo`, `registerWriteHook`, `pi.on(session_start/tool_result)` delegates to `LifecycleHooks`) — no duplicated `recordDiffServes` blocks
- [ ] Best-effort recovery (`record` swallow) owned in one place, keel #3/#5 explicit
- [ ] `npm run typecheck && npm test` green; keep Obsidian `.md` flavour
- [ ] No ADR conflict

## Files
`index.ts` · `src/read.ts` · `src/served-state.ts`/`src/served-session/*` · `src/snapshot-store.ts` · `src/edit-undo.ts` · `src/write-hook.ts` · `src/hash-store.ts` · `src/edit-response.ts` · `src/paths.ts`

Closes-by: squash PR with `Closes #NN`.

