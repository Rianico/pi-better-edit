# 0004. Model-Tool Boundary, Fail-Closed Verification, and Error/Warning Protocol

Date: 2026-10-30

## Status

Accepted

## Context

In agentic code editing, reliability depends on a strict division of responsibility: the model owns intent, while the tool runtime owns verification and state integrity. Traditional tools violate this boundary in two ways:
1. **Heuristic Auto-Fixes**: Earlier tools attempted to "help" models by silently trimming boundary lines from replacement text that appeared to duplicate surrounding code. This caused irreversible silent corruptions, such as dropping closing braces or breaking indentation blocks.
2. **Uninformative Rejections**: When an edit conflicted with disk state, conventional tools emitted generic errors without current state. This forced the model into defensive full-file re-reads, burning context and multiplying latency. Conversely, emitting speculative single directives biased models into speculative retry loops.
3. **Ad-hoc Error Diagnostics**: Unstructured error messages and mixed error/warning conventions made automated agent parsing fragile across different model providers ([`docs/.archive_adrs/0014-user-model-audience.md`](../.archive_adrs/0014-user-model-audience.md), [`docs/.archive_adrs/0021-unified-error-and-warning-contract.md`](../.archive_adrs/0021-unified-error-and-warning-contract.md)).

## Decision

We will enforce a pure edit contract (`range = hash_bounds, replacement = text`) with zero heuristic rewriting, fail-closed verification, reject-and-serve recovery, and a unified diagnostic protocol.

1. **Pure Edit Invariant**: The tool replaces exactly the resolved span with the exact `text` payload submitted. No boundary deduplication or automatic line stripping is ever performed. If replacement text duplicates surrounding lines, the result is written verbatim and made visible in the post-edit diff for the model to inspect.
2. **Fail-Closed Verification & Reject-and-Serve**:
   - `[E_STALE_RANGE]`: A line within the targeted span changed on disk. Rejects fail-closed and immediately serves current disk rows under the header `Current range (fresh read):` with fresh, valid leases. The model recovers in exactly 1 turn without calling `read`.
   - `[E_UNVERIFIED_RANGE]`: One boundary lease retired while the surviving bound is live and unshifted. Serves current rows under `Current range (fresh read):` ([`docs/.archive_adrs/0020-unverified-range-replaces-unserved-range-boundary-rule-for-retired-identities.md`](../.archive_adrs/0020-unverified-range-replaces-unserved-range-boundary-rule-for-retired-identities.md)).
   - `[E_STALE_ANCHOR]`: A boundary anchor's content changed since it was served. Serves current rows for the window under the header `Current range:` ([`docs/.archive_adrs/0035-estaleanchor-remedy-status-supersedes-adr-0022-remedy.md`](../.archive_adrs/0035-estaleanchor-remedy-status-supersedes-adr-0022-remedy.md)).
   - `[E_TARGET_LOST]`: Target line identity deleted or reordered without stable bounds. Rejects rowless; recovery requires a fresh read.
   - `[E_UNKNOWN_ANCHOR]` / `[E_FOREIGN_ANCHOR]`: Submitted anchor has no lease in this session or belongs to another file. Rejects rowless.
   - `[E_SUSPICIOUS_TEXT]`: Replacement line reproduces an exact served row (`HASH│content`). Bounded served hash echo detection rejects fail-closed unless the caller supplies `mode: "literal"`.
   - `[E_NOOP_LOOP]`: Stateful rejection when the exact same identical no-op edit payload is submitted 3 consecutive times (`NOOP_LOOP_THRESHOLD = 3`), breaking infinite loops.
3. **Unified Error & Warning Protocol**:
   - `[E_*]` denotes rejections where nothing was written.
   - `[W_*]` denotes applied warnings where the mutation succeeded (`W_NEVER_SERVED_SHAPE`, `W_SERVED_PREFIX_MISMATCH`, `W_REVERSED_ANCHORS`, `W_UNICODE_LITERAL`, `W_LITERAL_BYPASS`, `W_NOOP`, `W_NOOP_INSERT`).
   - Audience prefixes distinguish machine-actionable signals (`[MODEL]`, plain text) from human notifications (`[USER]`, dimmed in TUI).
4. **Refusal-Scoped Neutral Remediation**:
   - Error messages state neutral facts. When actionable choices exist (`E_SUSPICIOUS_TEXT`, `E_BATCH_ABORT`, `E_UNDO_UNAVAILABLE`), the tool provides a curated `Options:` list containing two or more neutral moves without speculative directives ([`docs/.archive_adrs/0047-remediation-options-are-refusal-scoped-and-neutral.md`](../.archive_adrs/0047-remediation-options-are-refusal-scoped-and-neutral.md), tested in [`test/arch/remedy-eligibility.test.ts`](../../test/arch/remedy-eligibility.test.ts)).

### Considered Options

- **Boundary duplication auto-trimming** — rejected: silently alters model intent, frequently deleting needed closing braces or structure.
- **Speculative single-directive suggestions** — rejected: directs the model down a single assumed fix path; neutral `Options:` preserve model agency.
- **Blind error rejection without rows** — rejected on the context-budget boundary: forces a redundant follow-up `read` turn, doubling latency and token consumption.

## Consequences

- Stale span conflicts recover in exactly 1 turn with zero auxiliary `read` calls.
- Pure edits prevent silent syntax corruption.
- Structured, machine-actionable errors and warnings enable predictable model behavior across frontier LLMs.
