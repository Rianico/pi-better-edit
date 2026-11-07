# ADR-0016. Outline Mode Serves Declaration Lines as Leased Point Windows

Date: 2026-11-07

## Status

Accepted

Relates to [0004. Model-Tool Boundary and Error Protocol](0004-model-tool-boundary-and-error-protocol.md), [0013. Anchor Identity Derives From Raw Bytes](0013-anchor-identity-derives-from-raw-bytes.md), [0014. Anchor the Selection-Range Note on a Point, Not a Range](0014-anchor-the-selection-range-note-on-a-point-not-a-range.md) and [0015. Reject naming both ends of a straddle](0015-reject-naming-both-ends-of-a-straddle.md)

## Context

A model that wants the shape of a file pays for the whole file. Every served read leases the lines it shows, so a full-file read that exists only to find where `Rectangle` is declared spends the context budget on bodies the model never asked for. What the model wants is a declaration map: one row per symbol, each row a live anchor it can target.

The read already serves leased point windows: an anchor names one line identity, and the edit resolves that identity through its lease. [ADR-0014](0014-anchor-the-selection-range-note-on-a-point-not-a-range.md) anchored the selection-range note on a point for the same reason — a point is what the model looks at first. Outline mode applies the same point discipline to the rows themselves: the coverage is one single-line window per declaration line, derived from the grammar, with caller windows ignored.

The vocabulary question is settled by the same source [ADR-0014](0014-anchor-the-selection-range-note-on-a-point-not-a-range.md) sanitizes: LSP 3.17 `SymbolKind` names. The tranche-1 outline keeps ten of them — containers, executable definitions, top-level constants and type parameters. `module` stays out: no tranche-1 table emits it, so no row can pin it, and the exclusion is recorded as evidence at the vocabulary site rather than as an open question. The per-language supplements (TypeScript top-level `const` declarators and type parameters, Go structs/interfaces and file constants, Rust structs/enums and file constants) are grounded against the pinned grammars; Python ships no supplement because its grammar has no `const` signal and every module assignment would qualify.

The row question is settled by [ADR-0013](0013-anchor-identity-derives-from-raw-bytes.md): an anchor is a function of its own line's raw bytes. An outline row therefore maps strictly to its scope node's own start row — the physical declaration line — never to the decorated span start, so leading documentation and decorators never move the row and no text beyond the name is pulled.

## Decision

We will serve `read` with `mode: "outline"` as leased single-line windows on declaration lines, and guard the unserved bodies between them with a recorded fold gate.

1. **The mode is admitted, and caller windows are ignored.** `RenderMode` gains `"outline"` (`src/file-content/admission.ts`), and the schema carries it as its own variant whose `windows` description states that caller windows are ignored. A non-empty caller list in outline mode is named in one `[Window warning: caller windows ignored in outline mode]` line — the anchor-miss shape, never silent. The caller-window count cap binds every mode except outline, because outline windows are server-derived rows, not caller fan-out.
2. **Coverage comes from the grammar seam only.** `AstSpanProvider.outline` lives off the shared `SpanProvider` contract: only the grammar provider can answer it, and the text, markdown and bash providers keep compiling unchanged. An empty outline is the anchor-omitted precedent — the file still prepares for its header counts but serves no rows, naming the miss in one `[No symbols found.]` line. A provider with no outline seam serves the same nothing.
3. **Leases cover declaration lines only.** Each symbol line becomes one `{ offset: line, limit: 1 }` window — deduped, sorted — rendered through the standard served pipeline (`derivedWindows: true`, normal snapshot materialization, mirror write and `recordEpoch`). Bodies between the rows are never served and never leased, so no lease exists for a line the model was never shown.
4. **The gaps are recorded where the session already keeps per-file state.** The intervals strictly between served declaration rows are stored as `outline_folds` in `served_session_meta`, beside the drift-notice column, each upsert naming only its own column. An outline that serves no folds records none (stored as NULL), so no stale refusal outlives it; a full non-outline read clears the whole session-meta row, so folds never outlive a full re-read.
5. **The fold gate refuses only the span that would silently erase a fold.** `verifyRebasedSpan` gains one clause: a multi-line replacement (`rebasedEnd > rebasedStart`) whose strict interior covers a recorded fold line that is still unserved (`served[line - 1] == null`) fails closed with `[E_STALE_RANGE]`, served as the current range under `Current range (fresh read):` with `details.cause: "served-range staleness"`. Single-line replacements and `before`/`after` point insertions have no interior and skip the gate, so they apply on declaration anchors exactly as before. A later served read that fills the folded lines disarms the gate through the mirror-null requirement — only a shifting edit can misalign the recorded coordinates, and a misaligned range still fails closed, never erases.
6. **Non-outline reads resolve exactly as before.** Absent or empty folds keep the gate inert, so the [ADR-0004](0004-model-tool-boundary-and-error-protocol.md) verification model — one gate over the whole served window on both the fast and the rebased path, interior acceptance for lines that carry no identity — is unchanged for every read that records no folds. The note clause is likewise untouched: it still names the one span enclosing the window's first line, per [ADR-0015](0015-reject-naming-both-ends-of-a-straddle.md).

### Considered Options

- **Lease whole symbol spans instead of declaration lines** — rejected. It would lease body lines the model was never shown, granting identity for bytes outside the served contract. A lease is evidence of what was served; a fold is the honest record of what was not.
- **Resolve an unleased boundary by content equality as a fallback** — rejected. [ADR-0004](0004-model-tool-boundary-and-error-protocol.md) is fail-closed: a boundary anchor with no lease is an unknown or foreign anchor, never a content question. The lease seam's invariant stands — a served anchor is never resolved by content.
- **Refuse single-line and point edits on outline leases** — rejected. The declaration anchor is a live lease on a served line, and a point has no interior to erase. Refusing it would tax the exact edit the mode exists to serve.
- **Keep folds in their own store** — rejected. The session-meta row already owns per-file state beside the drift-notice dedup, and each upsert names only its own column, so neither writer clobbers the other. A second table would split one fact across two lookups on the edit path.
- **Record folds in snapshot coordinates that rebase with edits** — rejected. The gate requires a mirror-null interior, so any edit that fills the folded lines disarms it and any edit that shifts them still fails closed. Rebasing would buy precision for a record whose only consumer is a fail-closed refusal.

## Consequences

- A model gets the file's shape at one row per symbol, each row a live point anchor it can retarget with a single-line replacement or a point insertion. Bodies stay unserved until a served read fetches them.
- A multi-line replacement that would silently erase a hidden body fails closed before any write: the file stays byte-identical and the model re-decides from the served current range instead of retrying blindly over the fold.
- The gate cannot strand a session. An empty outline clears the record, a full re-read clears it, and a served read of the folded lines disarms it. A missing row, a NULL column or unparsable JSON reads as no folds, so the gate stays inert instead of failing closed on a bookkeeping miss.
- **Load-bearing assumption:** that the physical declaration line is the right point anchor for every symbol — documentation and decorators are excluded by construction, so the row never drifts onto chrome. If a grammar moves a scope node's start row off its declaration, the row moves with it and this decision reopens.
- **Load-bearing assumption:** that a recorded fold stays aligned while it matters. Only a shifting edit can misalign it, and a misaligned range still fails closed rather than erase. If a future corpus shows the gate refusing spans whose folds were already served under shifted coordinates, the record needs rebasing, not removal.
- [ADR-0014](0014-anchor-the-selection-range-note-on-a-point-not-a-range.md) stands for the note's anchor and [ADR-0015](0015-reject-naming-both-ends-of-a-straddle.md) stands for its single-span form. This record changes which rows a read serves and what guards their gaps, and leaves both intact.
