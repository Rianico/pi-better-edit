# Proposal: Binary Selection Remediation & Merits Comparison (A vs C vs B)

**Ticket**: `ad-null-optional`  
**Status**: ADOPTED — Option C, owner-approved 2026-10-10; see [ADR-0036](../adr/0036-optional-wire-fields-declared-nullable.md).  
**Target Files (if approved)**: `src/payload-contract.ts`, `prompts/edit.md`, `prompts/edit-guidelines.md`, `test/tools/edit.wire-contract.test.ts`  
**Related Specs**: `docs/agents/refining-tool-prompts.md`, `AGENTS.md`

---

## 1. Architectural Merits Comparison: How Should `edit` Treat `null`?

Per the owner's standing instruction (*"it is acceptable to break the original design, code is cheap, historical debt is ever expensive"*), neither flatness nor the incumbent admission fold is taken as an unquestioned axiom. Below is an objective, merits-based evaluation of the three architectural options, leaving the decision to the owner.

### 1.1 Option A — Schema Wins (Refuse `null`, Teach Omission)
* **Mechanics**: The TypeBox schema declares optional fields as non-nullable (`Type.Optional(Type.String())`). Admission refuses `null` across all optional slots (`text: null`, `text_ref: null`, `text_ref.file: null`, `at: null`, root `mode: null`), with an actionable refusal message instructing the model to omit the key entirely.
* **Merits**:
  - **Single Source of Truth**: Schema, type checker, and admission agree completely. `null` is never conflated with key absence.
  - **Strict Tri-State Dictionary**: Absent means omitted; `null` is explicitly rejected as an invalid type; values are values.
  - **Clean TypeScript Model**: No normalization or key-stripping required at runtime; aligns naturally with `exactOptionalPropertyTypes`.
* **Costs & Risks**:
  - **Client Deadlocks**: A client harness that cannot omit a declared optional key has no way to satisfy a schema that refuses `null`, and can deadlock in a retry loop. Issue #67's environment is the `Obsidian Claudian plugin` (model `gpt-6-luna`, v2.7.0); the emitted shape that motivates this risk — `text_ref.file: null` for an omitted optional property — is documented in #75.
  - **Retry Penalties**: Every `text_ref: null` or `text_ref.file: null` costs an extra round-trip and token burn while the model learns to omit the key.

### 1.2 Option C — Schema Matches Runtime (Declare Optional Fields Explicitly Nullable)
* **Mechanics**: The TypeBox schema explicitly permits `null` on optional fields via `Type.Optional(Type.Union([T, Type.Null()]))`. Admission folds `null` to absent (via `foldAbsentSlots` / `delete`).
* **Merits**:
  - **Truthful Contract**: Eliminates the contradiction where the schema claims a property is non-nullable while admission and prompts permit `null`.
  - **Aligned with Platform Compiler**: Pi’s host compiler (`makeJsonSchemaNodeStrict`; upstream `@earendil-works/pi-ai`, which is not an installed package in this checkout — the function is vendored inside the `@earendil-works/pi-coding-agent` bundle) rewrites non-required properties to `{ anyOf: [property, { type: "null" }] }` when targeting strict sampling. In strict mode, `null` is the host platform's own canonical wire encoding for absent keys.
  - **Client Resiliency**: Safely tolerates auto-nulling client harnesses without triggering false type errors.
* **Costs & Risks**:
  - **Schema Overhead**: Marginally expands the TypeBox AST and serialized tool schema.
  - **Invitation to Null-Fill**: Explicitly documenting `null` in the schema may encourage models to emit `null` rather than omitting keys, though admission processes both identically.

### 1.3 Option B — Incumbent (Flat Schema + Admission Fold)
* **Mechanics**: The schema publishes non-nullable optional properties (`Type.Optional(T)`). Admission runs `foldAbsentSlots` before validation, deleting `null` and `undefined` keys so downstream validation only inspects post-folded keys.
* **Merits**:
  - **Minimalist Schema**: Keeps the published JSON Schema compact and free of union nodes.
  - **Native Pi Alignment**: Mirrors Pi’s built-in `normalizeOptionalNulls` (upstream `@earendil-works/pi-ai`, not an installed package in this checkout), which automatically deletes `null` in non-required properties before schema validation.
  - **Zero Regressions**: Preserves existing behavior for issues #67, #74, #75, and #77.
* **Costs & Risks**:
  - **Two Sources of Truth**: The schema artifact served to the model says `null` violates the type, but the engine tolerates it. Third-party client-side validators running ahead of admission could reject `null` prematurely.

---

## 2. Binary Selection Remediation (Orthogonal Improvement)

Regardless of which null-handling option (A, C, or B) the owner selects, the framing of XOR violations can be significantly clarified.

What #67 and #75 *reported* is mechanical, not causal: #67 shows a model emitting both payload fields and then retrying the same rejected call; #75 shows a strict caller emitting `text_ref.file: null` for an omitted optional property. Neither report measures *why* a model picks that shape, so the causal reading is stated below as the hypothesis this remediation is intended to test — not as fact.

> [!NOTE]
> **Behavioural Hypothesis (Unprobed)**:
> It is hypothesized that weak or distilled models confuse conceptual payload descriptions with JSON dictionary keys, occasionally treating `"text_ref"` as an inactive concept rather than an offending token. Until A/B provider probes are formally measured across model families, this is treated strictly as an engineering hypothesis.

To maximize structural clarity, remediation messages should explicitly present a **binary field choice** (`text` field vs `text_ref` field):

### 2.1 Both Fields Present (`hasText && hasRef`)
In [`src/payload-contract.ts:328-333`](file:///Users/zhengxk/development/ai/pi-better-edit/src/payload-contract.ts#L328-L333):

```ts
// Proposed formulation:
`edit[${index}] carries both "text" and "text_ref" fields: choose exactly one payload field per item (${ITEM_SHAPE}). ` +
`Choice A (literal content): Keep "text" and delete "text_ref" from the JSON object. ` +
`Choice B (copy/cut served span): keep "text_ref" and delete "text" from the JSON object.`
```

### 2.2 Neither Field Present (`!hasText && !hasRef`)
In [`src/payload-contract.ts:342-345`](file:///Users/zhengxk/development/ai/pi-better-edit/src/payload-contract.ts#L342-L345):

```ts
// Proposed formulation:
`edit[${index}] carries no payload (neither "text" nor "text_ref" fields): ${named}choose exactly one payload field per item (${ITEM_SHAPE}) — ` +
`supply the "text" field (authored content) OR the "text_ref" field (served span).`
```
*(Retaining `"carries no payload"` avoids breaking existing test pins across both test sites).*

---

## 3. Prompt Surfaces & Exact Character Budget

Per [`docs/agents/refining-tool-prompts.md`](file:///Users/zhengxk/development/ai/pi-better-edit/docs/agents/refining-tool-prompts.md), prompt modifications must be measured directly in the runtime environment rather than estimated.

### 3.1 Measured Runtime Length for `EDIT_DESCRIPTION`
The description is capped at **800 characters** by `test/core/gemma-tool-calling.test.ts:39`.

Measured runtime string lengths (evaluated with `HASH_LEN = 4`):
- **Current Baseline**: **760 characters** (40 characters margin below ceiling).
- **Draft Candidate 1** (verbose `never both fields`): **792 characters** (only 8 characters margin — dangerously tight).
- **Recommended Candidate 2**:
  ```ts
  export const EDIT_DESCRIPTION = `Edit a range of lines in a text file via \`edit\`: \`{ "file": file, "edits": [{ "anchor_from": a, "anchor_to": b, "text": text }, ...] }\` (one top-level file per call). For text files seen via \`read\`/diff. \`anchor_from\`/\`anchor_to\` are bare ${HASH_LEN}-char HASH anchors — copy the ${HASH_LEN} chars before \`│\` in this file's served rows (lease (session, file, anchor)), never \`│\` or content. Exactly one payload field per item: \`text\` (\`\\n\` joins lines, \`""\` deletes) or \`text_ref\` \`{anchor_from, anchor_to, mode (required), file?}\` — a served span's bytes (\`mode\` \`"copy"\`|\`"cut"\`; \`file\`=another served file, where \`cut\` retires the span there too); \`at\`: "in-place" (default), "before", "after". A null optional field reads as absent. \`[MODEL]\` in \`content\` is your retry instruction.`;
  ```
  - **Measured Runtime Length**: **766 characters**.
  - **Headroom**: **34 characters margin** below the 800-character ceiling.

### 3.2 Guidelines Polish (`EDIT_GUIDELINES`)
In [`src/payload-contract.ts:186`](file:///Users/zhengxk/development/ai/pi-better-edit/src/payload-contract.ts#L186):
```ts
`edit: give each item two anchors and exactly one payload: \`{ "file": file, "edits": [{ "anchor_from": a, "anchor_to": b, "text": text }, ...] }\` — \`file\` is the text file (never a directory); one item is a single edit, and several items are batched to that one file; choose exactly one payload field per item: the "text" field OR the "text_ref" field, plus optional \`at\`; providing both fields or omitting both fields is refused (a null in an optional field — \`text\`, \`text_ref\`, \`at\`, the top-level \`mode\`, \`text_ref.file\` — reads as absent; a null in a required one — \`file\`, \`edits\`, any anchor, or \`text_ref.mode\` — is refused).`,
```

---

## 4. Test Pin Audit & Blast Radius

Auditing all assertions that inspect these strings reveals:

### 4.1 Case-Sensitive Pin Invariant
`expectBadPayload` in `test/tools/edit.wire-contract.test.ts:94-96` runs `expect(refusal).toContain(clause)`, which is **strictly case-sensitive**:
- Line 95 requires: `'Keep "text" and delete "text_ref"'` (Capital **K**).
- Line 96 requires: `'keep "text_ref" and delete "text"'` (Lowercase **k**).

The proposed message in §2.1 intentionally preserves these exact case patterns (`Keep "text" and delete "text_ref"` and `keep "text_ref" and delete "text"`). If the phrasing is modified to use lowercase `keep` for both, the test pin on line 95 **must be explicitly updated**.

### 4.2 Complete Blast Radius for "Carries No Payload"
A grep audit reveals that `"carries no payload"` is asserted at **two** distinct test sites:
1. `test/tools/edit.wire-contract.test.ts:103`:
   ```ts
   expectBadPayload(req([{ anchor_from: "a1B", anchor_to: "c2D" }]), "carries no payload: exactly one payload per item");
   ```
2. `test/tools/edit.wire-contract.test.ts:1047`:
   ```ts
   expectBadPayload(req([{ anchor_from: "a1B", anchor_to: "c2D", text: null }]), "carries no payload");
   ```

By retaining the prefix `"carries no payload"` in the proposed message (§2.2), both test sites remain green without requiring test rewrites. If the prefix is removed in favor of a bare `"carries neither..."`, **both lines 103 and 1047 must be updated simultaneously**.

### 4.3 Prompt Parity Pins
Because `edit` follows a constant-as-source architecture (`docs/agents/refining-tool-prompts.md`), any update to `EDIT_DESCRIPTION` or `EDIT_GUIDELINES` in `src/payload-contract.ts` requires updating the mirror files:
- `prompts/edit.md`
- `prompts/edit-guidelines.md`

Failing to update mirrors triggers failures in `test/extension/prompts.test.ts:35-36, 206`.

---

## 5. Next Steps

This document is submitted as a proposal awaiting owner decision:
1. **Decision Gate**: The owner selects Option A, C, or B.
2. **Implementation Gate**: Upon owner approval, an implementer ticket will be dispatched to apply the chosen null strategy along with the binary remediation text.
