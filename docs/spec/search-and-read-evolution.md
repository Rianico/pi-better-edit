# Specification: Search & Read Evolution (`pi-better-edit`)

**Document**: `docs/spec/search-and-read-evolution.md`  
**Status**: Settled Specification (Approved by Reviewer)  
**Authors**: `gaps-orch` (settled from `gaps-reviewer` findings)  
**Date**: 2026-10-09  

---

## 1. Executive Summary & Intent (IDD)

Forensic evaluation of benchmark runs revealed high bash dominance (65–67%), driven primarily by unanchored inspection commands (`cat`, `sed`, `grep`, `head`) and fragmented search-then-read loops.

This specification unifies search and read into a cohesive, deterministic, line-identity MVCC pipeline:
1. **I1a (Intercepted `grep`/`rg`)**: Pre-execution argument injection via `tool_call` to ensure native `-n` line numbering, verified against disk bytes via a D9 gate, serving anchored rows with MVCC leases ($R=1$).
2. **I1b (Unified `read`)**: Clean-break hierarchical schema supporting multi-file reads and unified line/anchor windows (`files -> windows`), with file-level `mode` and tolerant runtime admission for legacy shapes.
3. **I4 (Post-Edit Diffs)**: Returning anchored unified diffs directly in `content[0].text` with synchronous lease registration.
4. **I2 (Byte View)**: Verbatim UTF-8 display by default with invisible/binary character warnings.
5. **P3.1 (ADR-0033 Amendment)**: Formally updating the architecture record to match implemented CRLF/BOM normalization and semicolon prefix chains.

---

## 2. P3.1 ADR-0033 Documentation Amendment

Before merging, `docs/adr/0033-bash-view-interception.md` will be amended to eliminate documentation drift:
- **Status Header**: Record amendment notice referencing commit `7b78278`.
- **Decision 1 (D1)**: Record semicolon-separated silent prefix chains (`isSemicolonStatementChain` with literal `;` separation and pre-view literal `cd <dir>;` re-basing).
- **Decision 9 (D9)**: Replace CRLF/BOM fail-closed wording with symmetric normalization (`toLF(stripBOM(stdoutText))` compared against `joinedSlice`).
- **Decision 7 (D7)**: Explicitly note that newline-separated multi-statement scripts remain pass-through pending corpus telemetry (P3.2).

---

## 3. I1a: Intercepted `grep` & `rg` in Bash View

### 3.1 Pre-Execution Argument Patching (`tool_call` Hook)
To prevent regular expression divergence between JavaScript `RegExp` and native POSIX/Rust engines (BRE/ERE/Rust regex), the system binary executes natively.

```
Model issues: { command: "grep 'function' src/app.ts" }
  │
  ▼
[tool_call Hook]
  ├─ Gate 1: Check AST allowlist
  ├─ If standalone search on single file missing -n:
  └─ Mutate in-place: event.input.command = "grep -n 'function' src/app.ts"
  │
  ▼
[Bash Executes Real Binary]
  └─ Native binary outputs: "42:function computeHash() {"
  │
  ▼
[tool_result Hook (handleBash)]
  ├─ Parses line 42 from stdout
  ├─ Verifies line 42 on disk matches stdout content byte-for-byte (D9 Gate)
  └─ Replaces stdout with:
       --- Bash search (hashline anchors) ---
       [src/app.ts (1 match)]
       a1b2│function computeHash() {
     (and admits lease a1b2 into servedRows)
```

### 3.2 Gate 1: AST & Flag Allowlist (Strict Default-Deny)
- **Target Command**: Strictly `grep` and `rg`.
- **Permitted Flags ONLY**:
  - Line numbers: `-n`, `--line-number`
  - Case folding: `-i`, `--ignore-case`
  - Literal strings: `-F`, `--fixed-strings`
  - Extended regex: `-E`, `--extended-regexp`
- **Default-Deny Principle**: Any flag not explicitly permitted **fails closed to raw bash**. This includes:
  - Output-altering: `-c/--count`, `-v/--invert-match`, `-o/--only-matching`, `-A/-B/-C` (context), `-l/-L` (file list), `--color`, `-m/--max-count`, `-q/-s` (silent), `-w/-x` (word/line match), `-b` (byte offset), `-H/-h/--with-filename/--no-filename`.
  - `rg`-specific: `--column`, `--heading/--no-heading`, `-N/--no-line-number`, `--json`, `--stats`, `--files`, `-r/--replace`, `-0/--null`, `--vimgrep`.
  - Structural: Pipelines (`|`), redirections (`>`), subshells, compounds (`&&`, `||`), background jobs (`&`).
  - Target operands: Must have exactly **one file operand**. No recursive directory flags (`-r`, `-R`), globs (`*`), tildes (`~`), or directories.

### 3.3 Flag Injection Rules (`tool_call` Hook)
- The rewrite function in `bash-classifier.ts` must be a pure, unit-tested function with zero filesystem dependencies.
- **Placement**: Inject `-n` (or `--line-number` for `rg`) immediately after the command name and **before any `--` option separator** (e.g. `grep -- -pat file` becomes `grep -n -- -pat file`).
- **No Cross-Hook Shared State**: `tool_result` re-parses the mutated `event.input.command` to identify the target file and options, avoiding session or concurrency leak hazards.

### 3.4 Gate 2: D9 Disk Witness Verification & Output
In `tool_result`:
1. **Exit Code Gate**: If process exit code $\ne 0$ (e.g. grep exit 1 when no matches are found), pass through raw bash untouched (no fake empty anchor block).
2. **Line Geometry Parsing**: Parse lines conforming to `^(\d+):(.*)$`. If any non-empty line cannot be parsed, fail closed to raw bash.
3. **Match Cap Gate**: If match count exceeds `SEARCH_MAX_MATCHES` (default 50), pass through raw bash directly without truncation or partial leases (raw bash output is complete and safer).
4. **Byte Equality Check**: Read disk lines via `readNormFile`. For every parsed match $L$, verify `diskLines[L - 1] === parsedContent`. Any mismatch fails closed.
5. **Frozen Header & Formatting**:
   ```text
   --- Bash search (hashline anchors) ---
   [src/app.ts (2 matches)]
   a1b2│function computeHash(input: string): string {
   c3d4│export function verifyHash(hash: string): boolean {
   ```
   Synchronously enroll served hashes into `servedRows`.

---

## 4. I1b: Unified `read` Tool Evolution

### 4.1 Schema Definition
```typescript
import { Type } from "typebox";

const OffsetWindowSchema = Type.Object({
  offset: Type.Integer({ minimum: 1, description: "Start line number (1-indexed)." }),
  limit: Type.Integer({ minimum: 1, description: "Number of lines to read." }),
});

const AnchorWindowSchema = Type.Object({
  around_anchor: Type.String({ minLength: 4, maxLength: 4, description: "4-character anchor hash." }),
  radius: Type.Optional(Type.Integer({ minimum: 1, default: 10, description: "Lines before and after anchor." })),
});

const WindowSchema = Type.Union([OffsetWindowSchema, AnchorWindowSchema]);

const FileTargetSchema = Type.Object({
  file: Type.String({ description: "Path to file (relative or absolute)." }),
  windows: Type.Optional(Type.Array(WindowSchema, { maxItems: 16, description: "One or more line ranges in this file." })),
  mode: Type.Optional(Type.Union([Type.Literal("served"), Type.Literal("verbatim")], {
    description: 'Render mode for this file: "served" (default) or "verbatim". Overrides top-level mode.',
  })),
});

export const ReadParamsSchema = Type.Object({
  files: Type.Array(FileTargetSchema, { minItems: 1, maxItems: 10, description: "List of files to read." }),
  mode: Type.Optional(Type.Union([Type.Literal("served"), Type.Literal("verbatim")], {
    default: "served",
    description: 'Global fallback render mode: "served" (default) returns HASH│content; "verbatim" returns plain text.',
  })),
});
```

### 4.2 Tolerant Runtime Admission & Limits
- **Prompt Pruning**: Documented schema in prompts publishes strictly `files: [...]`.
- **Runtime Tolerance**:
  ```typescript
  if ((params as any).file && !params.files) {
    const legacy = params as any;
    params.files = [{
      file: legacy.file ?? legacy.path,
      windows: legacy.offset !== undefined ? [{ offset: legacy.offset, limit: legacy.limit ?? 50 }] : legacy.windows,
    }];
  }
  ```
  Empty `windows: []` is treated as omitted (reads from line 1).
- **Cap Invariant**: At most 16 total windows across all files in a single call. Exceeding 16 throws `[E_BAD_PAYLOAD]`.
- **Global Budget**: All files draw against shared `SERVED_MAX_LINES = 200,000`.

### 4.3 Interval Algebra & Anchor Resolution
1. For each file in `files`:
   - `around_anchor` resolves against the target file's active lineage for the session.
   - If `around_anchor` is not found, expired, or foreign: emit inline warning `[Window warning: Anchor 'a1b2' not found; window omitted]`; remaining valid windows proceed.
   - Clamp `radius` to budget bounds (default 10).
   - Merge overlapping or contiguous `[start, end]` intervals into disjoint intervals.
   - Walk lines via single-pass `walkLines`.

### 4.4 Render UX & Verbatim Contract
- **Served File Header**: `[src/server.ts (120 lines total)]`
- **Window Sub-banners**: `=== Lines 1-15 of 120 ===`
- **Served Rows**: Strictly `HASH│content` (no row-level line numbers).
- **Verbatim File Header**: `[README.md (verbatim, 45 lines, no anchors)]` (rows render as plain text, no leases granted).
- **Pagination Footer**: `[src/app.ts lines 1-50 of 200. Use windows: [{ offset: 51, limit: 50 }] to continue.]`
- Diagnostic wordings for `offset > totalLines` and oversized lines (`[Line N is ... exceeds ...]`) remain byte-identical to preserve existing test pins.

---

## 5. I4: Post-Edit Feedback Optimization ($R=1$)

- `content[0].text` returns: `<summary_line>\n\n<anchored_diff_text>`.
- `details.diff` remains intact for UI presentation clients.
- Newly modified lines are already admitted synchronously in `servedRows` before returning to the model, ensuring zero-round-trip subsequent edits.
- Enforces the #174 collapse invariant (`DIFF_REMOVED_CAP`, `DIFF_REMOVED_EDGE`, deleted-span counting) to prevent token bloat.

---

## 6. I2: Byte View (Verbatim UTF-8 Default)

- Verbatim UTF-8 output remains the default.
- Escaped byte representations (`\x00`, `\t` as literal tab character) are NOT enabled by default to prevent tokenizer degradation and literal copy errors during edits.
- Warning notices are emitted when non-printable control characters or invalid UTF-8 sequences are encountered.
