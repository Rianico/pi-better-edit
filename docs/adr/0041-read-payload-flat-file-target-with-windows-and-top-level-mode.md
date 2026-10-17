# ADR-0041 — Read payload: flat single-file target with windows and top-level mode

Date: 2026-10-17

## Status

Accepted. Supersedes [ADR-0040 — Read payload: one canonical shape, and the model-facing schema as a cheap surface](0040-read-payload-single-shape.md).

## Context

ADR-0040 collapsed the `read` tool's legacy aliases into a single canonical shape `{ files: [{ file, windows?, mode? }], mode? }`. While this eliminated legacy normalization, real-world agent runs revealed three distinct operational degradations caused by the nested array structure:

1. **Model Compliance Degradation on `mode: "verbatim"`**:
   In LLM tool calling, schema nesting directly degrades optional property adherence. When reading skill files or documentation (read-only goals), models frequently omitted `mode: "verbatim"` because the required array wrapper `{ files: [{ file: ... }] }` concentrated the model's structural generation attention.
2. **Dual-Placement Ambiguity**:
   `mode` existed in two places (both top-level and inside `files[i].mode`), creating confusion about where the flag belonged.
3. **Common-Case Penalty**:
   Empirically, >95% of agent read operations target a single file. Forcing the dominant single-file case to pay the nesting tax penalized common-case ergonomics for a multi-file capability that is rarely needed in a single tool call.
4. **TUI Component Divergence**:
   Pi's built-in TUI component natively models a single target `{ path, offset, limit }`. Presenting an array of files forced synthetic projection hacks (`projectReadRenderArgs`) that only displayed the first file and swallowed remaining targets from the call line.

Furthermore, multi-file inspection is already solved across two independent surfaces:
- **Parallel Tool Calling**: Modern agent harnesses (including Pi) execute parallel tool calls in a single turn. Reading multiple files is performed cleanly by emitting parallel `read` invocations in one step, each with its own honest TUI representation and error boundary.
- **Bash View**: Intercepted shell inspection (`cat f1 f2`, `grep pat f1 f2`) operates natively at the shell layer without involving the `read` tool.

## Decision

**D1 — The model-facing schema accepts a flat single-file target.**
The schema accepts `{ file: string, windows?: Window[], mode?: "served" | "verbatim" }`:
- `file`: Path to the file to read (relative or absolute). Required.
- `windows`: Array of line or anchor windows within this file. Optional (omitted or empty reads from line 1).
- `mode`: Global render mode (`"served"` default, `"verbatim"` for plain unanchored text). Optional.

The outer `files` array is removed from `readToolSchema`.

**D2 — Multi-window interval algebra and anchor resolution are fully retained.**
The core technical engine—interval merging, radius clamping, single-pass line walking, and `around_anchor` resolution—remains unchanged on the file's `windows` array.

**D3 — Exactly one `mode` property exists at top-level.**
There is no nested `mode`. `mode` sits as an immediate top-level sibling to `file`, maximizing model visibility and adherence when reading read-only documentation or skill files.

**D4 — 1:1 Honest TUI Mapping.**
`file` maps directly and honestly to `path` in `renderCall` and `renderResult`. A single simple `{ offset, limit }` window populates `offset`/`limit`; multi-window reads show the path with `(N windows)`; whole-file reads show the path cleanly.

**D5 — Render projection tolerates recorded history.**
The historical fallback in `projectReadRenderArgs` is preserved for archived transcripts: `args?.file ?? args?.path ?? args?.files?.[0]?.file`. Sessions recorded under ADR-0040 continue to render without error.

**D6 — Versioning: `feat`-class, MINOR, with a ledger entry.**
Per ADR-0040 D5, the model-facing schema is a cheap surface. This change is MINOR (no `!`).

## Consequences

- Reading skill files, docs, or whole source files is completely flat: `{ file: "SKILL.md", mode: "verbatim" }`. Adherence on `mode: "verbatim"` is restored.
- TUI call lines and results accurately display the target path for every read.
- Prompts (`prompts/read.md`, `prompts/read-snippet.md`, `prompts/read-guidelines.md`) are simplified to teach `{ file, windows?, mode? }`.
- Multi-file batching in a single JSON argument is replaced by standard parallel tool calling.
