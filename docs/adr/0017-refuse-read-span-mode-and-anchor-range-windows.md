# ADR-0017. Refuse Read Span Mode and Anchor-Range Windows

Date: 2026-11-16

## Status

Accepted

Relates to [0003. Model-Facing Payload Contracts for Read and Edit Tools](0003-tool-payload-contracts-read-and-edit.md), [0004. Model-Tool Boundary and Error Protocol](0004-model-tool-boundary-and-error-protocol.md), [0012. Serve a Selection-Range Note Instead of Widening the Read](0012-serve-a-selection-range-note-instead-of-widening-the-read.md), [0014. Anchor the Selection-Range Note on a Point, Not a Range](0014-anchor-the-selection-range-note-on-a-point-not-a-range.md), [0015. Reject naming both ends of a straddle](0015-reject-naming-both-ends-of-a-straddle.md) and [0016. Outline Mode Serves Declaration Lines as Leased Point Windows](0016-outline-mode-point-anchors.md)

## Context

The `read` payload is flat: `{ file, windows?, mode? }`, with `{ offset, limit }` and `{ around_anchor, radius }` windows. Outline mode serves declaration lines and names the enclosing span in its note, for example `(span 651-780, 130 lines)`. A proposal asked whether `read` should also accept an edit-like anchor pair (`anchor_from` / `anchor_to`) or a server-derived span mode (`mode: "span"`, `span: true`) to serve a whole function.

The mid-body measurement in [read-outline-mid-body-measurement.md](../analysis/read-outline-mid-body-measurement.md) tested six targets 20–130 lines inside functions above 100 lines. The decisive aggregates:

| arm | N | pass | tokens/trial | rounds/trial |
|---|---:|---:|---:|---:|
| control | 12 | 12/12 | 45,032 | 4.00 |
| span mode | 12 | 12/12 | 38,469 | 3.75 |
| anchor range | 12 | 12/12 | 39,652 | 3.67 |
| 150-line / 50-line prompt | 18 | 18/18 | 42,625 | 3.89 |
| **150-line / 60-line prompt** | **18** | **18/18** | **38,153** | **3.61** |

The prompt-only 150/60 rule is the best aggregate, with no code or schema change. It wins three deep-target tasks by 48,162 tokens and pays 6,888 tokens across three shallow tasks, a 7:1 leverage. A later live spot check reported 17,470 tokens and 3 rounds for `point-read-guide`, and 23,411 tokens and 4 rounds for `mid-load-edit-file`; those runs are not part of the committed N=18 table.

## Decision

We will keep `read` flat and bounded: `{ file, windows?: [{ offset, limit }] | [{ around_anchor, radius }], mode?: "served" | "verbatim" | "outline" }`. We will refuse both `anchor_from`/`anchor_to` and `mode: "span"`/`span: true`; the outline note remains the span-extent source and `{ offset, limit }` remains the primitive. We will ship the prompt-only 150/60 outline guideline in `prompts/read-guidelines.md`, and leave `prompts/read.md` and the tool schema unchanged.

### Considered Options

- **150-line / 60-line prompt rule** — chosen. For a function under 150 lines, read its span in one call via `{ offset, limit }`; for a larger function, read a 60-line window around the target; never read the whole file to verify. At N=18 it is 38,153 tokens (−15.3%), 3.61 rounds, 18/18. It beats span mode (38,469 / 3.75) and anchor range (39,652 / 3.67) on tokens.
- **Anchor range `{ anchor_from, anchor_to }`** — rejected. `edit` anchors verify an already-served mutation span; `read` acquires unserved content. The end anchor of an unserved body has no lease, so the caller cannot name it. Sibling declaration bookends fail on the last symbol, inner closures and inter-symbol trivia. Serving outline end lines was rejected by [ADR-0016](0016-outline-mode-point-anchors.md), and bash/grep hits are points with line numbers, so `{ offset, limit }` is already usable.
- **Root-level `anchor_from` / `anchor_to`** — rejected. It duplicates `windows`, adds precedence rules, and breaks the flat single-file payload.
- **Runtime `mode: "span"` or `span: true`** — rejected. Syntactic spans follow a power-law distribution. On the 170-line `verifyRebasedSpan`, span mode cost 42,583 tokens; the 60-line window cost 35,239 (+20.8% for the span). Syntax recovery during active editing can collapse large file regions into one ERROR node; non-AST files have no span; admission would depend on asynchronous AST resolution. The outline note already gives the extent.
- **Outline serves end lines** — rejected. [ADR-0016](0016-outline-mode-point-anchors.md) leases declaration lines only. Closing braces clutter the symbol map, grant leases on non-declarations, and break the fold-gate point discipline.
- **7th-bullet 40-line sequential chunk** — rejected by measurement. It eliminated whole-file reads (1 of 39) but cost 45,699 tokens and 5.25 rounds; the model scanned instead of reading one span.
- **100-line / 50-line prompt** — rejected. It scored 41,749 at N=12 and 42,625 at N=18. The 100-line threshold splits 130-line functions such as `buildStore`; 50 lines is too narrow for the 300-line `buildStmts` target.
- **150-line / 50-line prompt** — rejected at N=18: 42,625 tokens, 3.89 rounds. The 50-line window underperforms 60 lines on five of six tasks.

## Consequences

- The read schema stays one flat payload. No new union member, no new refusal surface, and no AST dependency in admission.
- The outline note is the only span source. The model composes `{ offset, limit }` from the named extent; the prompt rule bounds the read.
- The 150/60 rule reduces aggregate tokens and rounds, but it is not uniform. Three tasks regress by +1.3% to +11.6%; the 7:1 leverage is the ship argument. A future corpus that reverses the aggregate reopens the decision.
- `prompts/read.md` remains Tier-1 lean. Threshold policy belongs in the conditional guidelines, not the every-turn tool description.
- **Load-bearing assumption:** the model follows the 150/60 guideline and the 150-line threshold generalizes beyond this six-task suite. If a bounded AST slice primitive with a non-AST fallback appears, or a later corpus shows the aggregate reversal, reopen this record.
- The live spot checks are reported evidence; the committed N=18 measurement is the durable benchmark.
