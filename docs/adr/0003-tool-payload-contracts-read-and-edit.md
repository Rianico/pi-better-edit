# 0003. Model-Facing Payload Contracts for Read and Edit Tools

Date: 2026-10-30

## Status

Accepted

## Context

Coding agents interact with the host environment through JSON tool calls validated against provider-specific schema validators (Anthropic, OpenAI, Google Gemini, DeepSeek). Early designs suffered from transport and integration incompatibilities:
1. **Positional Tuples**: A compact tuple schema (`[anchor_from, anchor_to, text]`, [`docs/.archive_adrs/0006-compact-json-edit-payload.md`](../.archive_adrs/0006-compact-json-edit-payload.md)) failed on OpenAI and Gemini API transports, which require parameter schemas to be of type `object`.
2. **Missing Hoisted Path**: Wrapping tuples in an object `{ "edit": [...] }` omitted the top-level `path`/`file` property, crashing permission hooks and audit sidecars (e.g., `pi-permission-lsz`) that expect a top-level file identifier.
3. **Tool Fragmentation**: Providing separate tools for single replacements versus batches (`replace` vs `batch_edit`) increased agent decision overhead and duplicated verification logic.
4. **Schema Rigidity**: Declaring optional wire fields strictly non-nullable ([`docs/.archive_adrs/0032-flat-wire-item-contract.md`](../.archive_adrs/0032-flat-wire-item-contract.md)) caused frequent validation rejections when models explicitly emitted `"at": null` or `"text_ref": null` ([`docs/.archive_adrs/0036-optional-wire-fields-declared-nullable.md`](../.archive_adrs/0036-optional-wire-fields-declared-nullable.md)).

## Decision

We will standardize on two primary tool schemas featuring hoisted file targets, object roots, flat wire items, and nullable optional edit fields.

1. **The `read` Tool Contract**:
   ```json
   {
     "file": "path/to/file.ts",
     "windows": [
       { "offset": 10, "limit": 20 }
     ],
     "mode": "served"
   }
   ```
   Windows can also be specified as anchor-centered slices: `[{ "around_anchor": "aB3d", "radius": 5 }]`.
   - `file`: The target file path hoisted to the payload root.
   - `windows`: Optional array of window objects (maximum `MAX_READ_WINDOWS = 16`). Each window specifies either `{ offset?, limit? }` (1-indexed lines) or `{ around_anchor, radius }`.
   - `mode`: Defaults to `"served"`, which assigns 4-character hashes, outputs `HASH│content` rows, and records session leases. `"verbatim"` performs raw reference reads without anchoring, bypassing the 200,000-line admission ceiling.

2. **The `edit` Tool Contract**:
   ```json
   {
     "file": "<string>",
     "edits": [
       {
         "anchor_from": "<string>",
         "anchor_to": "<string>",
         "text": "<string | null>",
         "text_ref": {
           "anchor_from": "<string>",
           "anchor_to": "<string>",
           "file": "<string | null>",
           "mode": "copy | cut"
         },
         "at": "in-place | before | after | null"
       }
     ],
     "mode": "general | literal | null"
   }
   ```
   - Arity: Length 1 is a single edit; length > 1 is an atomic batch (maximum `EDITS_MAX_ITEMS = 32`), applied in memory with cumulative preceding-delta shifts.
   - Content: Exactly one of `text` (literal payload) XOR `text_ref` (span reference).
   - Cross-File Operations: `text_ref.file` allows referencing spans across files for atomic cut operations.
   - Placement: Optional `at` defaults to `"in-place"` when omitted or `null`.
   - Nullability: Optional edit fields (`at`, `text`, `text_ref`, `text_ref.file`, root `mode`) accept `null` to accommodate model emission patterns.
   - Durability: Multi-file cut operations are supported via correlated transaction commits with CAS undo snapshots.

### Considered Options

- **Positional tuple arrays (`[from, to, text]`, [`docs/.archive_adrs/0006-compact-json-edit-payload.md`](../.archive_adrs/0006-compact-json-edit-payload.md))** — rejected: OpenAI and Gemini transports refuse array-root parameter schemas; drops top-level file parameter required by permission systems.
- **Separate `replace` and `batch_edit` tools** — rejected: causes agent decision friction; arity is naturally expressed by the `edits` array length in a single tool.
- **Tuple window arrays `[[start, end]]` ([`docs/.archive_adrs/0040-read-payload-single-shape.md`](../.archive_adrs/0040-read-payload-single-shape.md))** — rejected: replaced by object windows `{ offset, limit }` and `{ around_anchor, radius }` in [`docs/.archive_adrs/0041-read-payload-flat-file-target-with-windows-and-top-level-mode.md`](../.archive_adrs/0041-read-payload-flat-file-target-with-windows-and-top-level-mode.md) to support anchor-centered inspection.
- **Strict non-nullable optional fields ([`docs/.archive_adrs/0032-flat-wire-item-contract.md`](../.archive_adrs/0032-flat-wire-item-contract.md))** — rejected: frontier LLMs frequently emit explicit `null` values for unset options; declaring them nullable prevents spurious schema validation errors.

## Consequences

- The object-root shape validates against OpenAI, Anthropic, Gemini, and DeepSeek strict-schema transports ([`docs/.archive_adrs/0006-compact-json-edit-payload.md`](../.archive_adrs/0006-compact-json-edit-payload.md), [`docs/.archive_adrs/0032-flat-wire-item-contract.md`](../.archive_adrs/0032-flat-wire-item-contract.md)).
- Hoisted `file` parameter ensures full compatibility with pi event hooks and security policies.
- Batched edits execute atomically under a single write lock, eliminating intermediate disk states.
- Clean separation between editing workflows (`mode: "served"`) and passive reference inspection (`mode: "verbatim"`).
