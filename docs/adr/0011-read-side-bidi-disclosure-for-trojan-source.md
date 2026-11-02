# 11. Read-Side Bidi Disclosure for Trojan Source

Date: 2026-11-02

## Status

Rejected

Relates to [9. Invisible-Codepoint Disclosure Lives on the Edit Path](0009-invisible-codepoint-disclosure-lives-on-the-edit-path.md)

## Context

[ADR-0009](0009-invisible-codepoint-disclosure-lives-on-the-edit-path.md) retired the serve-side notice, so no read-side surface discloses invisible code points. Bidi controls were not covered by the pre-existing control notice either: `scanControlChars` (`src/file-content/detection.ts`) matches C0, DEL and C1, while bidi characters are `Cf` format characters.

That gap invited this record, and an earlier revision of it accepted a narrow read-side disclosure for the twelve bidi code points, with issue #232 filed to implement it. The premise was Trojan Source (CVE-2021-42574): a bidi control reorders how a line renders, so the code a reader sees is not the code the bytes contain.

The premise does not survive measurement, because it names the wrong reader. Trojan Source's threat model is a **human reviewing rendered glyphs**. A language model is not a renderer: it receives tokens in byte order, and nothing in this repository applies the Unicode Bidi Algorithm — every `reorder` in `src/` concerns line order (sorting, stream order), never rendering order. Measured, for `if (isAdmin) {` with U+202E inserted before `Admin`, the override arrives as a distinct token: a dedicated id (`152821`) under `o200k_base`, and three byte-fallback tokens under `cl100k_base`. The model holds the code point either way, in byte order.

The asymmetry decides it: **a human is render-sensitive and can be deceived; a model is token-sensitive and cannot.**

## Decision

We will not add a read-side disclosure for bidi controls. Served rows continue to carry the code points verbatim, and the read path discloses only the non-printable controls it already covers.

### Considered Options

- **Leave it to the renderer** — adopted. The reader who can be deceived is a human looking at rendered output, and the surface that can deceive them is the renderer. If a renderer applies the Bidi Algorithm to tool output, the fix is display-time escaping there, not a notice carried in the tool's data.
- **A narrow read-side bidi notice** — rejected. For a token-reading model its only contribution is attention, which is the argument that retired the 37-code-point notice ([ADR-0009](0009-invisible-codepoint-disclosure-lives-on-the-edit-path.md)). Exempting twelve code points from that argument is not defensible: if it holds for bidi, it holds for the rest.
- **Restore the full notice** — rejected by the same argument, and by the measurements recorded in ADR-0009.

## Consequences

Easier: the read path keeps one disclosure rather than two, and no model-facing surface exists for a hazard that cannot reach the model. Read output for a file containing bidi controls is byte-identical to today's.

Harder, and accepted: nothing in the tool warns the model that a file carries bidi controls. A model asked to audit for Trojan Source must find the tokens itself, and a human reading a rendered transcript depends on their renderer. That is a real gap, and it belongs to the renderer rather than to this tool's data.

Load-bearing assumption, confidence high: a model's input path does not apply the Unicode Bidi Algorithm, so rendered order and byte order cannot diverge for it. Revisit only if a serving path starts rendering rather than tokenizing.

Recording note: an earlier revision of this record marked it Accepted and asserted the disclosure was "justified independently of the attention argument that retired the notice". That assertion was wrong — for a token-reading model, attention is the only thing a notice adds — and it was corrected before the record landed. Issue #232 is closed as not planned. Related: [`docs/spec/invisible-codepoint-disclosure.md`](../spec/invisible-codepoint-disclosure.md).
