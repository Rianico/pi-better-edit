# 0008. Read Expansion: Requested Window, Served Window, and Its Bounds

Date: 2026-10-31

## Status

Accepted

## Context

A model inspecting a file often needs two calls to understand one block. It asks `read` for a small window and receives exactly those lines. When the block continues past them, it sends a second `read` for the same file. The second call costs a whole turn: a fresh thinking block plus a re-sent prefix. That is more expensive than the lines it was trying to fetch.

The cost is measurable. Across the 400 newest local session transcripts, 700 of 3,751 `read` calls (18.7 %) are followed by another `read` of the same file. That second call lands within three tool calls, at a median gap of two.

The tool could not fix this before. Read expansion was a capability of another extension, which widens a small read to its enclosing AST block before the tool runs. It cannot fire for this tool: it rewrites a flat `offset`/`limit` pair, while this tool's payload is `{ file, windows: [{ offset, limit }] }`. Both prompt surfaces nevertheless advertised the widening and named a parameter the payload does not have. Those claims are removed.

Two further facts shaped the design:

- Dilation is expensive when unbounded. The same third-party path was measured widening a 6-line request to 96 lines, and its ceiling is 300 lines.
- Evidence supports structure selection as a representation change. Compact structural views match raw text on quality while being shorter, and one controlled head-to-head finds line-based selection at parity with syntax-aware selection. Structure buys navigation and costs little. It is not an accuracy claim.

## Decision

Read expansion becomes a built-in capability of `read`. The tool computes the structural block that encloses a requested window, serves that block in the same call, and states what it served.

1. **Terminology.** A read payload names **requested windows**. Expansion turns a requested window into a **served window**. These are distinct from the existing `served range`, which is the verification span between `anchor_from` and `anchor_to`. Glossary entries carry the split.
2. **Seam position.** Expansion runs after content load and before hashing and mode dispatch. It is a range computation, not a lease concern. It does not interact with `SERVED_MAX_LINES`, which governs anchor space rather than boundaries.
3. **Mode independence.** Expansion applies in `served` mode and in `verbatim` mode. In served mode the widened rows carry anchors and leases. In verbatim mode the widened range and content return with no lease recorded. `verbatim` means "no anchors added", not "exactly the requested range".
4. **Folding before trigger.** Overlapping or adjacent requested windows fold into one span before the trigger test. A 16-window read of 24 lines each is one large span and does not expand. This bounds cost by construction and removes the need for a per-call budget.
5. **Bounds.** Expansion triggers when the folded requested span is at most 24 lines. Caps are 80 lines of code, 80 lines of Markdown, and 40 lines of plain text. Each block is capped independently. There is no per-call total. A block above its cap is refused, never clamped. One exception: a Markdown section above its cap serves a cap-sized window that still contains the requested window. The window slides forward from the section start as needed, and the note reports the full section extent. A served window always contains its requested window, so expansion never removes information.
6. **Note channel.** A widened read carries one note line per window, placed before that window's first served row: `[widened <requested> -> <served>, <label>]`, for example `[widened 220-225 -> 210-240, arrow]`. The label is a member of one closed vocabulary: the block's kind, followed by its identifier when the block has one. The base of that vocabulary is the LSP 3.17 `SymbolKind` set, with six documented extensions for concepts the protocol cannot express honestly (`arrow`, `impl`, `trait`, `typeAlias`, `section`, `paragraph`). A grammar node type is never a label: a node the language table does not recognise declines and produces no note. The note uses the inline `[...]` chrome channel already declared in the read prompt. It can never be read as a served row or an anchor. A clamped Markdown section names both ranges: `[widened 100-104 -> 25-104, section "Language" (section 1-120)]`, where the ask sits past the first 80 lines of the section.
7. **Union serving.** Expanded windows are served as one ascending, non-overlapping, non-adjacent run, the normalization `served-spans.ts` already defines. Each row is served once, with one anchor and one lease.
8. **Silent refusals.** A refused expansion produces no note. The model receives the window it asked for. Refusals are visible in the audit log, which records one reason code plus the grammar language or block size where applicable.
9. **Audit sink.** Applied and refused expansions append to `read-expansion.log` in the extension state root, with size-based rotation beside the diagnostics sink. That sink records expansion attempts only, never a plain read. The first entry of a session records the resolved configuration rung. Later entries omit it.
10. **Boundaries come from syntax.** Other languages use tree-sitter through a wasm runtime with grammars fetched on first use and verified against a committed hash manifest. `session_start` pre-warms the grammars for the workspace's top-level extensions; a read still waits only its own budget, and a fetch that is still in flight is recorded as `cold_grammar`. Bash reuses the shell parser already in the dependency set, which exposes function nodes with byte offsets and reports parse errors instead of throwing. Markdown uses a fence-aware heading scan and plain text uses blank-line paragraphs. Neither adds a dependency.
11. **LSP contributes names only.** A language server participates only when one is already attached to the workspace. It may supply a qualified name. It never supplies a different span, never starts a process, and is never consulted to prove absence.
12. **Configuration.** `read.expansion` accepts `on` and `off` and resolves through the same ladder as `bash.view`: environment override, project file, global file, then the default `on`. The toggle gates provider work; `off` serves the exact window and records one `toggle_off` per session without touching a provider.
13. **Acceptance is measured.** A language is accepted when same-file re-reads for it fall by at least 20 % relative. The sample must hold at least 200 served-mode reads of that language's files. Below that sample the result is reported as insufficient, and adoption rests on the waste metric alone.

### Considered Options

- **Clamp every oversized block instead of refusing** — rejected. A clamped code block hides its own end, and the model then edits against a truncated view. Markdown keeps the clamp because a section is a document unit with a visible extent the note can report.
- **A per-call served-lines budget** — rejected. Folding already bounds the common case, and the remaining case needs many independent windows inside large blocks, which is rare. A total budget refused the ordinary two-probe read.
- **Carry the expansion record in payload details** — rejected. The audit needs every expansion and every refusal, including the ones the model must not pay for. A log carries both without spending context.
- **An LSP-first boundary path** — rejected. It would make a core read behaviour depend on a server being installed, trusted, and warm, and server answers can be stale or absent.
- **Bundling grammars in the package** — rejected. The full grammar set measured 8.7 MB against a 534 KB bundle.

## Consequences

- A read can return more lines than requested, in both modes. The glossary entry for `reference read` states this.
- Served rows grow: an expansion leases a wider span. Expansion can also close the gap between two windows. That turns a previously unread interior into a served run, so the staleness rule verifies real identities where it previously accepted an unverified interior.
- The prompt surfaces stay silent about expansion until Markdown and TypeScript boundaries land. At that point the architecture test that forbids third-party claims narrows to "no claims about another extension's behaviour".
- Language coverage grows per ticket, each with fixtures and a measured effect, rather than in one sweep.
- Failures stay quiet. An unparsable file, an unsupported language, an oversized block, or an absent grammar leaves the read behaving exactly as it did before.
