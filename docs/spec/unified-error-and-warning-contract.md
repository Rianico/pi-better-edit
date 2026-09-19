# Spec: Unified Error, Warning, and Feedback Contract (Zero-Leakage Domain Model)

Status: proposed — amends [ADR-0014](../adr/0014-user-model-audience.md), [ADR-0018](../adr/0018-region-scoped-rejection-serves.md), [ADR-0019](../adr/0019-malformed-code-rename.md), and [ADR-0020](../adr/0020-unverified-range-replaces-unserved-range-boundary-rule-for-retired-identities.md).
Foundational references: Gunnar Morling (*"What's in a Good Error Message?"*), Keel Architecture Principles (Principles 1, 2, 3, 5, 6, 8).

---

## 1. Context & Motivation

In an agentic mutation engine, error and warning channels serve as the primary sensor feedback loop for the LLM. If feedback is ambiguous, dropped, leaked, or opinionated:
1. **Silent Miswrites occur** if the system serves speculative or historical rows when line identity is dead.
2. **Infinite retry loops occur** if fatal rejections lack audience markers (`[MODEL]`) or machine-readable codes.
3. **Loss of Recovery Context occurs** if batched operations drop diagnostic payloads (`servedBlock`, `servedRows`) across serialization seams.
4. **Model hallucination/confusion occurs** if successful operations emit error codes (`[E_*]`) or if warnings offer patronizing, opinionated advice (`"No action is required"`, `"run undo_last_edit"`).

Recent code reviews across `dev/mvcc-followups` (commits `d528c0f7c1124c75` through `9a84efb`) identified multiple operational gaps across error classes, payload forwarding, warning emissions, and feedback isolation. 

This specification establishes a **closed, type-safe Domain Error & Warning Model** (analogous to Rust's `thiserror` pattern) that enforces audience tagging, machine-readable warning codes (`W_*`), strict fail-closed reserved content rules, and lossless payload forwarding.

---

## 2. Review Findings & Seam Analysis (Gaps G1–G7)

| Gap | Seam / Location | Defect Description | Invariant Violated |
| :--- | :--- | :--- | :--- |
| **G1: Untagged Error Headers** | `src/hashline/apply.ts:261-266`, `src/read.ts:87,91,95` | `throw new AnchorMismatchError(message, ...)` emits raw string without `[MODEL] [E_*]` header. Read path directory/binary checks emit `[E_UNSUPPORTED_FILE]` without `[MODEL]`. | **ADR-0014**: All model-facing errors must start with `[MODEL] [E_*]`. |
| **G2: Dropped `servedBlock` in Batches** | `src/mutation-engine/pipeline.ts:543-558` (`batchAbortFor`) | Spreads `details`, `cause`, `code`, `servedRows`, but drops `servedBlock`. In `engine.ts:34`, `toFailure` degrades `servedBlock = error.servedBlock ?? ""` to empty string. | **Reject-and-Serve Contract**: Atomic batch aborts must preserve the failing edit's pre-rendered serve block. |
| **G3: Missing `details.cause` Consistency** | `src/mutation-engine/pipeline.ts:364-366` | Fallback rejection on missing hashes omits `details.cause`. `AnchorMismatchError` vs `ServedRejectionError` handle `cause` via divergent defaults. | **Keel Principle 6**: Diagnostic surfaces must be uniform and falsifiable across all rejection paths. |
| **G4: Diagnostic Loss in Unverified Anchors** | `src/hashline/served-verification.ts:780-792` (`throwUnverified`) | Hardcodes `UNVERIFIED_HEADLINE` even when `startPositions.length === 0` (anchor was never served for this session), discarding the specific diagnostic. | **Observation Precision**: A never-served anchor must report its true state, not masquerade as an unverified span. |
| **G5: Inactive Soft Hint on Undefined Served** | `src/hashline/apply.ts:375` | `findNeverServedAnchorShapes` is wrapped inside `if (served)`, skipping hints if the served tracker is missing or empty. | **Soft Hint Invariant (#146)**: Never-served anchor shape detection in replacement text is shape-only and pure. |
| **G6: Semantic Code Misuse on Success** | `src/hashline/resolve.ts:390` | Emits `[USER] [E_REVERSED_ANCHORS]` for an edit whose bounds were swapped, healed, and applied. | **Keel Principle 2 (Grade Every Surface)**: `E_*` denotes failure/rejection. Applied mutations must never emit `E_*`. |
| **G7: Uncoded & Opinionated Warnings** | `src/hashline/served-guard.ts:265-279, 190-196` | Soft hints lack machine-readable codes and include prescriptive prose (`"No action is required"`, `"run undo_last_edit and retry"`). | **Morling / LLM Boundary**: Machine-readable codes for programmatic parsing; neutral, factual descriptions without opinionated directives. |

---

## 3. Core Architectural Principles

### 3.1 Strict Two-Grade Surface: `E_*` (Failed Closed) vs `W_*` (Applied)

Every diagnostic output emitted by the engine falls strictly into one of two tiers:

1. **Negative Path (`[E_*]`) — Fail Closed**:
   - **Guarantee**: Zero bytes written to disk, zero mutations applied to working buffer, active leases untouched.
   - **Contract**: The operation was rejected.
   - **Format**: `[<AUDIENCE>] [<E_CODE>] <neutral-statement-of-failure>`

2. **Positive Path (`[W_*]`) — Applied / Committed**:
   - **Guarantee**: Mutation succeeded and was applied verbatim (or safely healed via deterministic rules like reversing inverted bounds).
   - **Contract**: The operation succeeded. The diagnostic is an observation attached to the response.
   - **Format**: `[<AUDIENCE>] [<W_CODE>] <neutral-statement-of-observation>`

> [!IMPORTANT]
> `[USER] [E_REVERSED_ANCHORS]` is retired. When reversed bounds are swapped and applied, it is strictly emitted as `[USER] [W_REVERSED_ANCHORS]`.

### 3.2 Fail-Closed Reserved Content Rules (Gunnar Morling Alignment)

A critical question in error design: **When should a rejection provide reserved content (`servedRows` / `servedBlock`) so an extra read can be skipped, and when must it fail closed with NO rows?**

| Scenario | Line Identity State | Code | Serve Reserved Rows? | Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **In-place drift** (file modified externally, line identity intact) | Live & unshifted | `E_STALE_RANGE` | **YES** (`Current range:`) | The tool has authoritative identity for the target lines. Serving rows allows 0-read recovery without miswrite risk. |
| **Unserved interior hole** (boundary live, gap inside) | Live boundaries | `E_STALE_RANGE` | **YES** (`Current range:`) | The boundary anchors identify the region; interior lines are safely leased on reject. |
| **One bound stale, other live & unshifted** | Boundary partially live | `E_UNVERIFIED_RANGE` | **YES** (`Current range (fresh read):`) | Region bounded by the live anchor; rows are served under explicit fresh read heading. |
| **Retired Line Identity** (line deleted/replaced externally) | Dead (`line_id ∉ lineage`) | `E_TARGET_LOST` | **NO** (`servedRows: []`, no serve block) | **Fail Closed**: Historical line numbers now point to unrelated content. Serving rows creates silent miswrites (ADR-0018). |
| **Malformed Anchor Syntax** | Invalid syntax | `E_MALFORMED_ANCHOR` | **NO** (`servedRows: []`) | Target cannot be located; cannot construct a trustworthy region. |
| **Reproduced Served Rows** | Exact echo of served row | `E_SUSPICIOUS_TEXT` | **NO** (`servedRows: []`) | Copy-paste defect in replacement text; not a range identification issue. |

### 3.3 Neutral Feedback & Elimination of Opinionated Directives

In accordance with agentic interface design:
- Error and warning prose **must not** issue prescriptive orders to the model (`"No action is required"`, `"Run undo_last_edit"`, `"You must call read"`).
- Models possess context on intent that the tool lacks. The tool provides **verifiable facts and coordinates**, allowing the model to determine whether fresh state suffices to re-apply decisions.

*Example Comparison:*
- **Old (Opinionated)**: `[MODEL] Edit applied with 1 anchor-shaped replacement line matching the tool's own row shape (HASH#content): an anchor never served for this session and file. No action is required. The bytes were written as-is with no rewrite.`
- **New (Neutral & Coded)**: `[MODEL] [W_NEVER_SERVED_SHAPE] 1 replacement line opens with an anchor-shaped token never served for this session and file. Applied verbatim.`

### 3.4 Batch Feedback Isolation

For atomic multi-edit batches:
1. When edit $i$ fails, execution aborts atomically (`batchAbortFor`).
2. The error envelope must represent **only** the failing item ($i$), retaining its exact `servedBlock`, `servedRows`, `code`, and `cause`.
3. Sibling items ($0 \dots i-1, i+1 \dots N$) must not pollute the diagnostic payload or overwrite the failed item's serve block.

---

## 4. TypeScript Tagged Domain Error & Warning Registry (Rust `thiserror` Pattern)

To eliminate ad-hoc string formatting, missing `[MODEL]` tags, dropped properties, and divergent `details.cause` fields, all domain errors and warnings are defined through a zero-dependency, type-safe registry in `src/domain-errors.ts`.

### 4.1 Schema Definition

```typescript
// src/domain-errors.ts

export type Audience = "MODEL" | "USER";

export type DomainErrorCode =
  | "E_TARGET_LOST"
  | "E_STALE_RANGE"
  | "E_UNVERIFIED_RANGE"
  | "E_STALE_ANCHOR"
  | "E_MALFORMED_ANCHOR"
  | "E_SUSPICIOUS_TEXT"
  | "E_BAD_PAYLOAD"
  | "E_EMPTY_RANGE"
  | "E_UNSUPPORTED_FILE"
  | "E_NOOP_LOOP"
  | "E_BATCH_ABORT"
  | "E_ACCESS"
  | "E_NOT_FOUND"
  | "E_UNDO_STALE"
  | "E_UNDO_UNAVAILABLE";

export type DomainWarningCode =
  | "W_NEVER_SERVED_SHAPE"
  | "W_SERVED_PREFIX_MISMATCH"
  | "W_REVERSED_ANCHORS"
  | "W_UNICODE_LITERAL"
  | "W_LITERAL_BYPASS";

export interface ErrorPayloadMap {
  E_TARGET_LOST: {
    servedLine: number;
    path: string;
  };
  E_STALE_RANGE: {
    startLine: number;
    endLine: number;
    cause: RangeCause;
    servedRows: ServedRow[];
    servedBlock: string;
  };
  E_UNVERIFIED_RANGE: {
    target: string;
    path: string;
    cause: RangeCause;
    servedRows: ServedRow[];
    servedBlock: string;
  };
  E_STALE_ANCHOR: {
    anchor: string;
    servedRows?: ServedRow[];
    servedBlock?: string;
  };
  E_MALFORMED_ANCHOR: {
    rawAnchor: string;
    reason: string;
  };
  E_SUSPICIOUS_TEXT: {
    line: number;
    offendingLine: string;
    count?: number;
  };
  E_BAD_PAYLOAD: {
    message: string;
  };
  E_EMPTY_RANGE: {
    path: string;
  };
  E_UNSUPPORTED_FILE: {
    path: string;
    reason: string;
  };
  E_NOOP_LOOP: {
    message: string;
  };
  E_BATCH_ABORT: {
    failedIndex: number;
    underlyingError: DomainError;
  };
  E_ACCESS: {
    path: string;
    reason: string;
  };
  E_NOT_FOUND: {
    path: string;
  };
  E_UNDO_STALE: {
    path: string;
  };
  E_UNDO_UNAVAILABLE: {
    path: string;
    reason: string;
  };
}

export interface WarningPayloadMap {
  W_NEVER_SERVED_SHAPE: {
    count: number;
  };
  W_SERVED_PREFIX_MISMATCH: {
    k: number;
    anchor: string;
    servedLine: number;
  };
  W_REVERSED_ANCHORS: {
    fromHash: string;
    toHash: string;
  };
  W_UNICODE_LITERAL: {
    line: number;
  };
  W_LITERAL_BYPASS: Record<string, never>;
}
```

### 4.2 Error Class & Registry Specification

```typescript
interface CodeSpec<P> {
  audience: Audience;
  format: (payload: P) => string;
}

export const ERROR_REGISTRY: { [K in DomainErrorCode]: CodeSpec<ErrorPayloadMap[K]> } = {
  E_TARGET_LOST: {
    audience: "MODEL",
    format: ({ servedLine, path }) =>
      `line ${servedLine} in ${path} no longer resolves to the line identity it was served with. The line you targeted was deleted or replaced; your anchors describe a version of this file that no longer exists. Read the file and re-target.`,
  },
  E_STALE_RANGE: {
    audience: "MODEL",
    format: ({ startLine, endLine, cause }) =>
      `lines ${startLine}-${endLine} no longer match the served state (${cause}).`,
  },
  E_UNVERIFIED_RANGE: {
    audience: "MODEL",
    format: ({ target, path }) =>
      `target anchor '${target}' in ${path} has not been verified in the active session lease.`,
  },
  E_MALFORMED_ANCHOR: {
    audience: "MODEL",
    format: ({ rawAnchor, reason }) =>
      `anchor '${rawAnchor}' is invalid: ${reason}. Expected 3-character alphanumeric hash.`,
  },
  E_SUSPICIOUS_TEXT: {
    audience: "MODEL",
    format: ({ line, offendingLine }) =>
      `replacement text at line ${line} reproduces served row '${offendingLine}'. Omit anchor prefixes or set mode: 'literal'.`,
  },
  // ... remaining specifications
};

export class DomainError<K extends DomainErrorCode = DomainErrorCode> extends Error {
  readonly code: K;
  readonly audience: Audience;
  readonly payload: ErrorPayloadMap[K];
  readonly servedRows: ServedRow[];
  readonly servedBlock: string;
  readonly cause?: RangeCause;
  readonly details: { cause?: RangeCause; code: K };

  constructor(code: K, payload: ErrorPayloadMap[K]) {
    const spec = ERROR_REGISTRY[code];
    const formatted = spec.format(payload);
    const header = `[${spec.audience}] [${code}] ${formatted}`;
    super(header);

    this.name = "DomainError";
    this.code = code;
    this.audience = spec.audience;
    this.payload = payload;

    const p = payload as any;
    this.servedRows = p.servedRows ?? [];
    this.servedBlock = p.servedBlock ?? "";
    this.cause = p.cause;
    this.details = { code, ...(p.cause ? { cause: p.cause } : {}) };
  }
}
```

---

## 5. Normative Decisions & Deliverables

### D1: Adopt `DomainError` and Retire Subclass Sprawl
- Retire separate ad-hoc error classes (`AnchorMismatchError`, `ServedRejectionError`, `ServedHashEchoError`).
- All negative-path throw sites instantiate `new DomainError(code, payload)`.
- Compile-time checking ensures that `[MODEL]` tags, `code`, and required diagnostics are present.

### D2: Fix `batchAbortFor` Lossless Payload Forwarding (G2 Fix)
- In `src/mutation-engine/pipeline.ts`, `batchAbortFor` explicitly preserves `servedBlock`:
  ```typescript
  return {
    code: "E_BATCH_ABORT",
    message: formatBatchAbortMessage(...),
    servedRows: error.servedRows ?? [],
    servedBlock: error.servedBlock ?? "",
    details: { ...error.details, code: "E_BATCH_ABORT" },
    cause: error.cause,
  };
  ```

### D3: Introduce `W_*` Warning Namespace and Formatters (G6, G7 Fix)
- Create `formatWarning<K extends DomainWarningCode>(code: K, payload: WarningPayloadMap[K]): string`.
- Standardize applied warnings:
  - `[MODEL] [W_NEVER_SERVED_SHAPE] <count> replacement line(s) match anchor shape but were never served. Applied verbatim.`
  - `[MODEL] [W_SERVED_PREFIX_MISMATCH] Line <k> begins with anchor <anchor> served for line <servedLine> but content differs. Applied verbatim.`
  - `[USER] [W_REVERSED_ANCHORS] anchor_from/anchor_to were reversed; healed and applied with range swapped.`
  - `[USER] [W_UNICODE_LITERAL] Literal \\uDDDD detected; applied verbatim.`
  - `[USER] [W_LITERAL_BYPASS] served-echo check bypassed by literal declaration.`

### D4: Neutralize Diagnostic Prose
- Strip opinionated phrases (`"No action is required"`, `"run undo_last_edit and retry"`) from model warnings and errors.
- Ensure all emitted text provides purely objective coordinates, byte state, and observable mismatches.

### D5: Fix `throwUnverified` Never-Served Anchor Diagnostic (G4 Fix)
- In `src/hashline/served-verification.ts`, if `startPositions.length === 0`, do not treat as generic range unverified:
  - Explicitly report that the boundary anchor was never served for the file in the active session.

### D6: Pure Execution of `findNeverServedAnchorShapes` (G5 Fix)
- In `src/hashline/apply.ts`, execute `findNeverServedAnchorShapes` even when `served` is empty/undefined, using an empty served set, ensuring soft hints fire consistently regardless of lease state.

---

## 6. Testing & Falsifiability Matrix

1. **Tag Completeness Oracle**:
   - Automated AST / regex scan asserting that 100% of thrown domain errors begin with `[MODEL] [E_*]` or `[USER] [E_*]`.
2. **Payload Preservation Test**:
   - Unit test simulating a multi-item batch where item 1 rejects with `servedBlock`. Assert that the resulting failure envelope from `pipeline.ts` preserves `servedBlock !== ""` and matches the item's rendered rows.
3. **No-Error-On-Success Test**:
   - Assert that no test or execution path where `appliedCount > 0` produces any warning containing `[E_*]`. Reversed anchor healing must emit `[USER] [W_REVERSED_ANCHORS]`.
4. **Prose Neutrality Linter**:
   - Architecture test scanning `src/` strings to ensure prohibited opinionated phrases (`"No action is required"`, `"run undo_last_edit"`) do not exist in model-facing outputs.
