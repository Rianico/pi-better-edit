# ADR-0036 — Optional wire fields are declared nullable; amends ADR-0032's non-nullable schema

Date: 2026-10-10

## Status

accepted — adopted from `docs/spec/binary-selection-remediation.md` Option C (owner-approved
2026-10-10). Amends [ADR-0032](0032-flat-wire-item-contract.md): the flat wire, the
exactly-one-payload XOR, and every required field are unchanged. Only the served JSON Schema's
treatment of the five optional properties changes — `null` becomes a legal spelling of absent —
and the two XOR refusals are reframed as a binary field choice.

Amends [ADR-0032 — Flat wire item contract for the edit tool](0032-flat-wire-item-contract.md)

## Context

Admission learned to read `null` as absent in #67/#74 and extended it to the nested
`text_ref.file` in #77/#75: `isAbsentValue` (`src/payload-contract.ts`) plus `foldAbsentSlots`
delete `null`/`undefined` from the item's optional slots before the key-set gate runs, and root
`mode` is skipped by the same predicate. Behaviour is pinned legacy: see the
`Edit wire contract — null reads as absent (ticket-67)` and `… nested text_ref nulls (ticket-75)`
blocks in `test/tools/edit.wire-contract.test.ts`.

But the artifact we served the model disagreed. Every optional property was a bare
`Type.Optional(...)`: `text_ref.file` was `{"type":"string"}`, `text` was `{"type":"string"}`,
`at` was a literal union without `null`, root `mode` likewise, and `text_ref` was a plain
object. No `type` list and no `anyOf` admitted `null`, so a client-side validator reading the
schema concluded `null` was a type error while the engine silently folded it. Two sources of
truth — the debt this record retires.

The platform's own strict compiler already spells nullable the same way. `makeJsonSchemaNodeStrict`
(upstream `@earendil-works/pi-ai`; not an installed package in this checkout — the function is
vendored inside the `@earendil-works/pi-coding-agent` bundle) rewrites each non-required property
that does not already allow `null` to `{ anyOf: [property, { type: "null" }] }`. Nullability is
pi's own wire spelling of "absent".

## Decision

1. **The five optional properties are declared nullable in `src/payload-contract.ts`** using
   TypeBox's natural union-optional form, `Type.Optional(Type.Union([T, Type.Null()]))`:
   item `text`, item `text_ref`, item `at`, root `mode`, and `text_ref.file`.

2. **The four required-bearing fields stay non-nullable**: root `file`/`edits`, item
   `anchor_from`/`anchor_to`, and `text_ref.mode`. `null` there keeps being refused at
   admission, and the schema keeps rejecting it.

3. **`foldAbsentSlots` is unchanged** — still the single call before `analyzeItem`, still
   deleting folded keys rather than carrying them. It is now the runtime half of an agreed
   contract, not a hidden tolerance. Admission behaviour is byte-for-byte unchanged.

4. **The two XOR refusals name a binary field choice** (`analyzeItem`): the both-present arm
   offers `Choice A`/`Choice B` around the two required case patterns
   (`Keep "text" and delete "text_ref"` / `keep "text_ref" and delete "text"`); the
   neither-present arm keeps the `carries no payload` prefix and names
   `neither "text" nor "text_ref" fields`.

5. **The served-schema form is `anyOf`.** TypeBox serialises `Type.Union([T, Type.Null()])` as
   `{"anyOf":[<T>,{"type":"null"}]}`, never as a `type` list. Probe
   (`pnpm exec vitest run`, one-off): the served `edits[].text` property dumps verbatim as
   `{"anyOf":[{"type":"string","description":"Bare file content for the range; use \"\" to delete"},{"type":"null"}]}`
   and `Compile(editToolSchema).Check({file:"f",edits:[{anchor_from,anchor_to,text:"T",text_ref:null}]})`
   is `true`. Scalar `anyOf` is permitted by the strict compiler — ADR-0032 decision 9's
   transport note ("scalar `anyOf` is permitted; object/array unions throw") is the reason.

6. **The transport probe and its resolution.** Running pi's strict converter against the widened
   schema, `makeStrictJsonSchema(editToolSchema)` throws
   `UnsupportedStrictJsonSchemaError: object and array unions are unsupported` at `edits[].text_ref`:
   the object variant (`{type:"object",…}`) is a structured union member, and `type:["object","null"]`
   is refused too (`properties require type object`). The accepted resolution is to keep the
   object `anyOf` because **no live path runs the strict converter for this tool**:
   `resolveJsonSchemaStrictSampling` returns `undefined` unless the tool declares
   `constrainedSampling` (`chunk-AXIIZGTV.js`), and `buildToolDef` declares none. Every provider
   therefore calls `getJsonSchemaToolParameters(tool, false)` and serves the raw schema; the
   nullable raw schema is what the model receives and what runtime validation (`Value.Convert`
   + `Compile`) admits. The residual risk is recorded below.

## Consequences

- Schema, admission and types now agree: `null` in an optional slot is a legal spelling of
  absent everywhere it is decided, and a `null` in a required slot is refused everywhere.
- The `edit` description and guidelines gain one wording change only: "exactly one payload
  **field** per item" (and the binary-choice clause in the guidelines' batch bullet). The two
  `prompts/*.md` mirrors are regenerated from the same constants, so the parity tests
  (`test/extension/prompts.test.ts`) still pin one source.
- New pins: `test/tools/edit.wire-contract.test.ts` asserts each optional field admits `null`
  (raw served parameters) and each required field refuses it;
  `test/tools/replace-tool.test.ts` pins the serialised `anyOf` form of `edits[].text`.
- `EDIT_DESCRIPTION` stays under its 800-char ceiling
  (`test/core/gemma-tool-calling.test.ts`); measured `766` after this change.

## Residual risk

**A future `constrainedSampling: { type: "json_schema" }` opt-in would break on `text_ref`.**
`makeStrictJsonSchema` rejects the object union (probe above). If that opt-in is ever adopted,
the one-line fix is to revert `text_ref` to a plain `Type.Optional(textRefSchema)` and let pi's
strict wrapper supply the null variant; the other four nullable unions already pass the strict
compiler. This change chooses the truthful raw (live) schema over the dormant strict path, and
records the trade so the opt-in does not fail silently.

## Probe status

The model-facing text change is **unprobed**: no provider is reachable from the implementer
environment, so no A/B trial was run. The wording delta is a single noun ("payload field") plus
the guidelines' binary-choice clause; it is a hypothesis that it reduces null-filling, not a
measured finding (see `docs/agents/refining-tool-prompts.md`).
