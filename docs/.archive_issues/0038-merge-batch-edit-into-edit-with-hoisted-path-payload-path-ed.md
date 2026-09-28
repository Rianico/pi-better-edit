# Merge batch_edit into edit with hoisted-path payload ({path, edits})

> **Archived from pre-migration issue #38.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-18T14:45:37Z · state CLOSED · labels: ready-for-agent

## Body

Implements [ADR-0007](https://github.com/Rianico/pi-hashline-edit-lsz/blob/main/docs/adr/0007-merged-edit-payload-hoisted-path.md) and the [merged edit payload spec](https://github.com/Rianico/pi-hashline-edit-lsz/blob/main/docs/spec/merged-edit-payload.md).

## Context / why

The ADR-0006 tuple payload broke `edit` in two ways:
1. `958d9d3` used a bare tuple as `parameters` — OpenAI-compatible transports reject it (400: "schema must be a JSON Schema of 'type: object"', got 'type: array'").
2. The object-wrapped `{ "edit": [...] }` (c68a040) dropped top-level `path` — any `tool_call` hook on the `edit` tool that reads `event.input.path` (pi-permission-lsz) crashes with `path.isAbsolute(undefined)` → `ERR_INVALID_ARG_TYPE: The "path" argument must be of type string`.

## Contract (single mutation tool `edit`)

```json
{ "path": "/src/file.ts", "edits": [["aB3", "cD4", "replacement"], ["xY9", "xY9", ""]] }
```

- `path`: string or `null` (anchor-based inference); the ONLY file target — cross-file batches are dropped.
- `edits`: non-empty array of fixed 3-tuples `[remove_from, remove_to, replacement_text]`; arity = length; atomic all-or-nothing per call.

## Implementation tasks

1. **Schema + normalize** (`src/edit.ts`, `src/edit-normalize.ts`): `editToolSchema = Type.Object({ path: string|null, edits: Type.Array(Type.Tuple([String, String, String])) }, { additionalProperties: false })`. `prepareEditArguments` + `normReq` accept `{path, edits}` and normalize each tuple into the existing `remove_from`/`remove_to`/`replacement_text` internal representation. Remove the `{edit: [...]}` and bare-tuple shims. `path: null` resolution via existing `resolveMissingPath`.
2. **Execute merge** (`src/edit.ts`): `execute` preflights all items against one file, applies in order, rolls back on any failure — reuse `applyOneEdit`/`loadEditFile` from `src/edit-pipeline.ts` (already shared with batch_edit). Preserve per-item served-range verification, reject-and-serve, noop policy, drift notices, persisted undo. Single diff output spanning all items.
3. **Remove `batch_edit`** (`src/batch-edit.ts`, `index.ts`): delete the tool registration and the separate `tool_result` branch; merge its renderer/prompt/handler logic into `edit`. `index.ts` `tool_result` handler: read `event.input.path` directly for served-row recording (no `event.input.edit` unwrap).
4. **Renderer + preview** (`src/edit-render.ts`): `getPreviewInput` and `fmtCall`/`fmtResultMd` handle the multi-item payload; noop/error renders unchanged.
5. **Prompts** (`prompts/edit.md`, `edit-snippet.md`, `edit-guidelines.md`): document `{path, edits}`; remove `batch-edit-*.md`; keep one-edit-per-call guidance with batched-same-file allowance.

## Acceptance

- `npm run typecheck`, `npm run lint`, `npm test` all green.
- Unit tests: valid single + multi-item apply; `null` path inference; malformed tuple/arity/path rejects before mutation; empty `edits` rejects; old `{edit: [...]}` and bare-tuple payloads rejected; atomicity (one bad item → nothing written); noop policy per item.
- Manual smoke (headless pi, deepseek provider): read → `edit` with `{path, edits: [...]}` applies; chained edits keep fresh anchors; second stale anchor rejects with reject-and-serve.


## Comments

### @Rianico — 2026-08-18T15:28:57Z

Merged to main as baf6c3b (fast-forward). Verified on merged main: tsc clean, 1004 tests pass, coverage thresholds met. Combined e2e with the patched pi-permission-lsz (56cb62d) applies edits with no path TypeError.
