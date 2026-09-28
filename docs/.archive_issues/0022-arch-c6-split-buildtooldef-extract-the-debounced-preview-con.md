# Arch C6: Split buildToolDef — extract the debounced-preview controller

> **Archived from pre-migration issue #22.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-15T03:47:37Z · state CLOSED · labels: ready-for-agent

## Body

Part of #20

## Goal
Split `buildToolDef` in `src/edit.ts` — a ~285-line closure (complexity 40) that mixes five unrelated concerns. Its interface (preview generations, args keys, invalidation) is nearly as complex as its implementation — a shallow module.

## Friction (why)
`buildToolDef` (src/edit.ts ~lines 418-703) mixes:
- the TypeBox schema + `prepareArguments`
- a debounced preview controller: `setTimeout`, `argsKey`, `previewGeneration`, `cancelPendingPreview`, `compPreview`, `context.state.preview` + `invalidate`
- the `withFileMutationQueue` execute callback (~140 lines: execPipeline → noop-loop check → saveUndo → writeAtomic → buildChanged)
- render helpers `reuseText` / `reuseMarkdown`

Understanding the preview behavior requires reading the whole tool definition; the controller's logic (debounce timing, generation matching, stale-result rejection) is untestable in isolation.

## Solution
Extract the debounced-preview controller as its own module (own interface: start/cancel/generation, or a small `DebouncedPreview` helper owning setTimeout + argsKey + previewGeneration + invalidation). `buildToolDef` becomes a thin shell: schema, prepareArguments, and two calls — the controller and `execPipeline`. No behavior change to preview semantics.

## Files
`src/edit.ts`, plus a new module for the preview controller (e.g. `src/preview-controller.ts` or similar).

## Acceptance
- Preview debounce/generation behavior unchanged — `test/tools/edit.preview.test.ts`, `test/tools/preview-no-persist.test.ts`, `test/integration/*` pass.
- `npm run typecheck && npm run lint && npm test` green.
- `buildToolDef` shrinks; the controller has its own module and unit tests.

## Constraints
Noop-loop behavior, mutation queue, and served recording are untouched (other tickets cover them). Respect ADR-0001/ADR-0002.


## Comments

### @Rianico — 2026-08-15T05:02:24Z

Done — commits 8937060/5de2db8 on main (extract debounced-preview controller from buildToolDef, issue #22).
