# ADR-0034 — Message convergence supersedes ADR-0021 decisions 3 and 4

Date: 2026-10-07

## Status

accepted — supersedes [ADR-0021](0021-unified-error-and-warning-contract.md) decisions 3 and 4 in the four scoped claims below, and nothing else. No old ADR text was rewritten when this record was created (#58): the reciprocal line on ADR-0021 was deferred then and has since landed there as `Amended by [ADR-0034]`, so both records now declare the supersession (ADR-0019 keeps accepted prose as history).

Supersedes [ADR-0021 — Unified error and warning contract: the accepted record](0021-unified-error-and-warning-contract.md), decisions 3 and 4 (scoped).

## Context

The STE100 lane (#55) converged the model-facing diagnostic text. #56 (`cfb3dd8`) rewrote every `E_*` format in `src/domain-errors.ts`; #57 (`3e0c0c4`) converged the seven `W_*` formats and bullet-structured the multi-failure wrapper in `src/edit-response.ts`. One rule drove both: **the format states facts; the `remedy` field owns the action.** That is ADR-0021 decision 4's remedy-eligibility principle applied structurally, not a new principle.

Four consequences of that convergence contradict text ADR-0021 accepted, so they are recorded here rather than absorbed silently. The lane's redlines were operator-approved; this record is the supersede note for them, and the pin audit that follows it lists every test assertion the four claims superseded.

## Decision

### (a) The numeric-anchor note is deleted

ADR-0021 decision 4 kept the `E_UNKNOWN_ANCHOR` numeric note as declarative shape evidence. It is deleted, with `NUMERIC_ANCHOR_RE`, `numericAnchorNote` and every call site; `E_UNKNOWN_ANCHOR` renders facts only (`<path> has not served the anchor "x".`; plural form for several) and stays remedy-free by rule.

Reason: anchors mix letters and digits, so an all-digit token is not evidence that the model meant a line number — the note reasoned about intent the payload cannot know, which is the failure mode decision 4 forbids. The reading of `E_UNKNOWN_ANCHOR` itself (no lease in any file) is unchanged.

### (b) Remedy duplication is removed from every format

Formats no longer repeat the action the registry already owns. `E_STALE_ANCHOR` keeps its `Current range:` block but no retry-hint line; `E_SUSPICIOUS_TEXT` keeps the refusal headline plus the loop fact but not the omit/literal or re-read prose; `E_TARGET_LOST` keeps its first sentence; `E_LOSSY_TEXT`, `E_UNDO_UNAVAILABLE` and `E_UNDO_REVERT_FAILED` keep their facts and route the action to `remedy`. `TARGET_LOST_RECOVERY` and `RETRY_HINT` are no longer interpolated into any format (`TARGET_LOST_RECOVERY` remains exported for its other importers).

Reason: a fact stated twice — once as prose, once as the `remedy` field — drifts, and the format was the copy no test could keep honest. This supersedes the decision-4 reading that a format may carry its own remedy clause.

### (c) `E_FOREIGN_ANCHOR` states served-for facts

`inconsistent with <path>` judged a relationship without naming the anchor's home. The format is now `the anchor "x" was served for <homes>, not for <path>.`, with the no-homes arm `the anchor "x" was not served for <path>.`

Reason: decision 3's reading is unchanged (the anchor is leased for another file), but the payload now states the actionable fact — which file *did* serve it — instead of an adjective. The `E_FOREIGN_ANCHOR` / `E_UNKNOWN_ANCHOR` precedence order is untouched.

### (d) The `E_LARGE_FILE` remedy no longer routes back into the guard

The `use write` remedy sent the model to the same line-based admission path that had just refused the file. The remedy is now `Split the file or use a non-line-based approach for very large files.`, and the source-sized lecture left the format. Both arms keep their factual core: the lines arm names the observed count against the limit, the hash-space arm names the capacity fact.

Reason: a remedy that re-enters the refusing path is not a remedy. This corrects decision 4's remedy for this code only; the remedy-eligibility rule itself is unchanged.

## Consequences

- Registry invariants are unchanged: every `E_*` keeps a producing throw site, `E_*` stay errors and `W_*` stay warnings, audience routing is untouched, and `formatWarning` remains the sole `[W_*]` producer — all pinned by `test/arch/domain-error-registry.test.ts` and `test/arch/remedy-eligibility.test.ts`.
- `src/` is text-only: no behavior change, no new dependency, no public API change. `CONTEXT.md` and `README.md` are not touched by this record; the code tables still list the same 19 `E_*` and 6 `W_*` codes.
- The pin audit that follows this record updates the assertions encoding superseded text and deletes `test/hashline/numeric-anchor-diagnosis.test.ts`, which claim (a) supersedes wholly. `test/arch/terminology-synonyms.test.ts` strips the mandated capitalized `Served-echo check bypassed by literal declaration` phrase case-insensitively.
- **Load-bearing assumption (claim b).** The `remedy` field is now the only owner of action text, and no code path renders it: only the registry and its tests read `.remedy`. Any surface that must teach an action to the model has to render `remedy` itself. If none does, `E_SUSPICIOUS_TEXT`'s `mode: "literal"` escape hatch is no longer model-visible — a decision-6 exposure question that the operator should rule on rather than this record decide.

## Deferred

- **Collect-all-overlapping-pairs gate (GH #59).** `E_BATCH_ABORT` reports the first overlapping pair the span gate finds, as two bullets (one carrying the overlap annotation). Reporting every overlapping pair needs a `pairs[]` payload change; the #57 structured header and bullets make that extension additive. Not implemented here.
- **Wrapper-trailer tension.** `batchAbortForMany` renders the redline header (`N edits in <path> failed. The whole edit call was rejected and the file is unchanged.`) *and* keeps `BATCH_ATOMICITY_TRAILER`, so the atomicity fact appears twice and the trailer retains the `NOTHING was written` closer that #55's global redline drops elsewhere. The #57 body scoped the change to the `parts.join("; ")` replacement and the trailer carries the earlier-items-NOT-applied fact, so it was kept (Ruling B). The duplication and the global-vs-specific reading await an operator ruling.
- **Producer-side `Nothing was written` consolidation.** The closer still lives in producer-owned strings outside the registry: `src/hashline/parse.ts`, `src/hashline/resolve.ts`, `src/payload-contract.ts`, `src/mutation-engine/pipeline.ts`, `src/hashline/apply.ts`. #56's seam was `src/domain-errors.ts` only; consolidating them is a separate change.
- **Redline-literal quirks (kept intentionally).** `Identical edit (edit[0] (probe.ts))` nested parens (the redline's `(ref)`, where `ref` is already `edit[i] (path)`); `(submission 1 times)`; and `E_MALFORMED_ANCHOR`'s `<reason>.` producing a double period when the producer reason already ends in one.
