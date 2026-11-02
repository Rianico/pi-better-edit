# 9. Invisible-Codepoint Disclosure Lives on the Edit Path

Date: 2026-11-02

## Status

Accepted

Relates to [0002. Tokenizer-Stable 4-Character Anchors, Canon v3 Whitespace Class, and File-Scoped Allocator](0002-tokenizer-stable-4-character-anchors-canon-v3.md)

Relates to [11. Read-Side Bidi Disclosure for Trojan Source](0011-read-side-bidi-disclosure-for-trojan-source.md)

## Context

On the Explicit Edit Benchmark for `pi-better-edit@2.14.0`, Unicode-family tasks produced 16 of 21 first-attempt misses, and every miss drove the model into a long bash byte-inspection loop (`od -c`, `cat -A`, Python codepoint counting) to re-derive what `read` had already served.

One case is worse than slow. Anchor identity derives from a canonicalized line, and the canon strips 22 non-ASCII whitespace and format code points before hashing ([ADR-0002](0002-tokenizer-stable-4-character-anchors-canon-v3.md)). An NBSP-to-space substitution therefore leaves the anchor digest unchanged, the lease verifies, and the edit applies with no other guard. Measured: VT, FF, NBSP, EN QUAD, ZWSP and SHY each substitute with zero errors, because `verifyRebasedSpan` (`src/served-session/serve-render.ts`) verifies the served span and never inspects the replacement text — its own comment reads `No canon data is consulted`.

A serve-side notice was built, gated green, and refuted by four measurements before it landed. Every in-scope code point is already a distinct token under `cl100k`, `o200k` and DeepSeek-V3, so the notice added attention rather than information. The benchmark cannot observe its effect: the model recovers (95.1% first attempt to 99.6% after recovery), and neither published metric counts tool calls, which is the quantity #194 is actually about. It shipped a false hazard claim that fifteen pinned tests could not catch, because they pinned the notice's string rather than its behaviour. And the store persists no served text — only canon digests and anchors — so any "before" comparison must come from the file at edit time.

## Decision

We will disclose invisible code points on the edit path, and we will not append a notice to served rows. At the edit seam the tool compares the replaced span's on-disk lines against the written lines and names every in-scope code point that left or arrived.

Content rows stay byte-faithful — nothing inside a row is escaped. The disclosure is a separate caret sub-row adjacent to the row it describes. It is plain text with no warning-code tier, and it is permissive: the edit always applies, because replacing irregular whitespace is often deliberate cleanup.

### Considered Options

- **The serve notice** — built, pinned, and retired. Rejected: it added attention rather than information; its effect is unobservable in the only available benchmark; and it shipped a false claim its own tests could not catch.
- **Escape the removed row in the diff** — rejected by counterexample. The file's line `a`+U+000B+`b` is 3 code points; the escaped row `a[U+000B]b` shows 10. A model that reuses that text writes the literal string into the file, so the disclosure would introduce the corruption it exists to prevent. It also shifts every column after the code point.
- **Persist served text so the comparison names what was served** — rejected on cost. Raw line storage costs 200–400% overhead, exhausts the 50 MB CAS budget at roughly 350,000 lines instead of 1.25M, and adds 10–50 ms of synchronous WAL I/O per read. The comparison is therefore current-disk against written, and the wording says "the replaced line", never "the served line".
- **Change the canon instead** — rejected: the canon is not the guard and cannot be. ZWSP is already un-stripped, its anchor moves, and its substitution still applies silently, because nothing on the edit path compares written bytes to served bytes. See [ADR-0010](0010-the-line-canon-stays-a-pure-function-of-one-line.md).
- **Gate the disclosure on an intent heuristic** (carets only for 1:1 edits above a token-overlap threshold, an aggregate notice for block rewrites) — rejected. The tool must not guess whether a removal was intentional, and the in-scope code points are roughly 0.015% of characters, so fatigue is not the risk it was argued to be.

## Consequences

Easier: the disclosure lands on the model's own action, where it cannot be ignored as a footnote can. There is no schema change, no migration, and no new persistence. Read output is byte-identical for every code point outside the bidi class, and unchanged entirely for a clean file.

Harder, and accepted: a read-only consumer gets no signal — an auditor or planning agent that never edits a file learns nothing from this mechanism. That gap is accepted rather than patched, because the only reader a bidi control can deceive is a human looking at rendered glyphs, and that belongs to the renderer ([ADR-0011](0011-read-side-bidi-disclosure-for-trojan-source.md) records the rejection). An insertion has no original span, so a code point newly introduced by an insertion is uninspected. The disclosure is a statement about on-disk text, not about what was served.

Load-bearing assumption, confidence medium: a model attends to a response to its own edit more than to a trailing read footnote. This is the same attention claim the benchmark cannot currently measure. If a tool-call-count metric appears, re-measure it — that measurement, not this record, decides whether the mechanism earns its keep.

Deep analysis: [`docs/spec/invisible-codepoint-disclosure.md`](../spec/invisible-codepoint-disclosure.md) (the retirement record). Issues #194, #230, #231, #232.
