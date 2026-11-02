# Invisible-Codepoint Disclosure in Read: Retirement Record

This record supersedes every earlier revision of this document, which described
an always-on served-rows notice. That notice shipped, was pinned, and was then
retired by operator decision (via the orchestrator): the record below states
what replaced it and why. Nothing in this file amends
`content-addressed-line-identity-mvcc.md` §9, which stays the sole normative
text for Revision 25.

## Problem Statement

A coding agent that reads a file through `read` gets rows whose invisible Unicode codepoints render as nothing or as ordinary whitespace — a zero-width space, a word joiner, a non-breaking space, a bidi control. The code point is present in the text and is tokenized as a distinct token; the model does not attend to it, and neither the read rows nor the edit's response (`#231`'s identical `-`/`+` rows) give it anything to notice.

Every in-scope codepoint is a distinct token under `cl100k`, `o200k` and DeepSeek-V3 — the model could see the code point and was not attending to it. Provenance: operator tokenizer probe, not reproducible in-repo.

## Every Substitution Applies

`verifyRebasedSpan` (`src/served-session/serve-render.ts`) verifies the served span and never inspects the replacement — its own comment reads `No canon data is consulted: identity comes from the mirror row's lease`. A substitution is never rejected on canon grounds; verification is a pre-image check that proves the anchored line is still the served line. The consequence per class: the edit applies; `canon_stripped` leaves the anchor digest unchanged, `canon_surviving` moves it. The cost lands on a later edit that reuses the old anchor, never on the edit that performed the substitution. Only an external rewrite between read and edit turns a stale anchor into a rejection — and that is not what a read-side warning attached to the model's own substitution could ever catch.

## The Honest Target Is Cost, Not Correctness

`docs/reference/benchmarks.md` reports, for `pi-better-edit@2.14.0`, DeepSeek at 95.1 % first attempt and 99.6 % after recovery, and Muse Spark at 94.7 % first attempt and 99.1 % after recovery. Neither metric counts tool calls, which is what #194 is actually about: the model recovers, but only after a long byte-inspection loop. So the honest target is the diff, not the read — the disclosure must answer the action (#231), not precede it.
## Solution

No served-rows footnote. Served rows carry no disclosure of any kind: no
control notice is composed here (that notice predates this lane and lives in
the read path unchanged), no invisible-codepoint block is appended, and the
page is exactly the anchored rows the formatter renders.

The disclosure moves to the edit path: issue #231 (edit diffs render an
invisible-code-point substitution as two identical lines). This record does
not design #231.

The classifier layer stays as the foundation that work consumes:
`src/file-content/invisible.ts` (frozen 21/16 code-point sets, the 37-name
table, `classifyCodepoint`, `invisibleName`, `scanInvisibleLine`, with the
control-set priority and the canon coupling), pinned by
`test/core/invisible-codepoints.test.ts` and the coupling assertion in
`test/core/canon-v3-disposition.test.ts`.

## Implementation Decisions

1. **Retirement.** The composed notice (`composeReadNotices` and its tests)
   is deleted. `fmtReadPreview` (`src/file-content/preview.ts`) renders only
   anchored rows again, and `prepareFile` (`src/file-content/index.ts`) keeps
   only the pre-existing non-UTF-8 decode notice. Both files are restored
   byte-identical to their pre-lane revision, which the commit proves with an
   empty diff.
2. **What is kept, verbatim.** The frozen classifier
   (`src/file-content/invisible.ts`), its tests, and the canon coupling: 21
   `canon_stripped` codepoints, 16 `canon_surviving` codepoints, the control
   priority at U+000B, U+000C and U+0085, the 37-name table, and the
   `classifyCodepoint` / `invisibleName` / `scanInvisibleLine` API. Nothing
   about the sets, the names, or the classification order changed in this
   lane's lifetime.
3. **The knip exemption is scoped, not silent.** With the notice gone, nothing
   in `src` imports the classifier yet, so the unused-file and unused-export
   findings are exempted for exactly `src/file-content/invisible.ts` and
   exactly those two issue types, beside the existing scoped exemption in
   `knip.jsonc`. The exemption names issue #231 and the two pinning tests, so
   it blinds no invariant.

## Testing Decisions

- The pre-existing read suite (goldens, verbatim, windows, multi-file) passes
  with no edits: the restoration is proved by the suite, not by inspection.
- The classifier keeps its full coverage: every class, the frozen lists, the
  overlap priority, the name-table coverage, the frozen-data discipline, and
  the canon↔classifier coupling assertion.
- The deleted notice, composition, serve-integration and read-contract tests
  are gone with the code they pinned. No test asserts on notice wording
  anymore.

## Out of Scope

- Designing or implementing issue #231 (edit-path disclosure).
- Issue #230 (canon stripping inside string literals, where formatters keep
  the bytes): a canonicalization question, not a disclosure question.
- Auto-correction, normalization, or stripping of invisible codepoints.
- Inline escaping or marker substitution inside served rows.
- New read payload fields, config keys, or `W_*` warning codes.
- Any change to the canonicalization itself.

## Further Notes

Origin issue: #194.

Two adjacent findings stand independently of this retirement and are tracked
where they belong:

- `docs/articles/formatter-whitespace-churn-js-ts.md` measured `in code
  position → single space` against `inside string literal → preserved`, so
  canon v3 strips codepoints where formatters keep them. That is issue #230,
  not a notice problem.
- The notice shipped a false claim (`canon_surviving` "fails loudly") that
  fifteen pinned assertions, a spec section and a glossary entry all repeated,
  because the suite pinned its *string*, not its *behaviour*. A surface that
  can be confidently wrong where its own tests cannot look is a liability.
  That is why the record for a retired notice must state the mechanism, not
  the wording — and why this file does.
