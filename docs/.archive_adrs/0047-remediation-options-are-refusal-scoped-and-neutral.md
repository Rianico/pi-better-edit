# ADR-0047 — Remediation is a refusal-scoped `Options:` list, never a per-code directive

Date: 2026-10-24

## Status

accepted — supersedes ADR-0021 decision 4's `remedy` field (its eligibility rule survives as the
curation gate) and completes ADR-0034's load-bearing assumption that the field is the only owner of
action text. Amends ADR-0035, whose subject sentence is no longer served. No other decision in those
records is rewritten.

Amends [ADR-0021 — Unified error and warning contract](0021-unified-error-and-warning-contract.md),
[ADR-0034 — Message convergence](0034-message-convergence-supersedes-adr-0021-decisions-3-and-4.md),
[ADR-0035 — E_STALE_ANCHOR remedy](0035-estaleanchor-remedy-status-supersedes-adr-0022-remedy.md)

## Context

ADR-0021 decision 4 introduced a `remedy` string on each `ERROR_REGISTRY` entry. ADR-0034 (b)
removed the action from every `format` and named `remedy` as its owner. But **no code path rendered
it**: `DomainError` composes `[AUDIENCE] [CODE] format(payload)` only, and the sole readers were the
registry tests. Fourteen codes carried action text the model never saw; the model received facts
only. Because nothing served the strings, nothing kept them honest. A full pass found six defects:

- `E_SUSPICIOUS_TEXT` told the model to omit anchors from **`text`**, but the `write` arm guards
  `content`.
- `E_LARGE_FILE` gave one action for two arms: read's line cap is avoidable with `mode: "verbatim"`,
  while hash-space exhaustion needs a split — and the payload names neither tool.
- `E_STALE_ANCHOR` said "Retry as it directs" where the rendered message contains no directive.
- `E_UNDO_REVERT_FAILED` said "the next run", undefined for a model that has no run model.
- `E_MALFORMED_ANCHOR` appended a period to producer reasons that already end in one.
- `E_SUSPICIOUS_TEXT` said `(submission 1 times)`.

The prior policy was also wrong in kind, not only in phrasing. A single directive per code
("Retry the edit", "Use write") presumes the model's intent, and an intent-guessing suggestion
biases the next call. The `W_*` tier never had this problem: warnings carry their text in `format`,
and a warning is only shown after the bytes were already applied.

## Decision

### (a) Facts are the default

Every rejection renders what happened. A code with no neutral remediation declares no options and
serves no action text; the one exception is the schema-shape text in (d). Producer messages for
fact-only codes are facts too: the six payload messages that said "Do not pass", "Use", "Provide",
"fix the field and retry" now state the shape ("multiple lines belong in one string", "an empty
string deletes the range").

### (b) Remediation is a list, served at the refusal

`CodeSpec.options?: readonly string[] | ((payload) => readonly string[])` is rendered as
`\nOptions: a; or b.` after the format, for `MODEL` audience only, only by the refusal that produced
the evidence. It is never prompt prose and never a success path. A servable list has:

1. **two or more** admissible moves — the model keeps the choice; no preference adverb;
2. **non-destructive** moves (the remedy-eligibility gate survives: helpful, unharmful,
   fail-closed, evidence-pinned);
3. **arm-correct** text: branch when the payload arm changes the field or the tool;
4. no fact already stated by `format`.

### (c) The curated set is three codes

- `E_SUSPICIOUS_TEXT` — omit the copied anchors (`text` for edit, `content` for write) and retry
  with the same anchors; **or** declare `mode: "literal"` to write the lines verbatim. The literal
  disclosure is evidence-gated by the refusal (ADR-0021 decision 6) and now lives once, in the
  option, not twice.
- `E_BATCH_ABORT` — merge the overlapping items into one span; or split them across separate calls.
- `E_UNDO_UNAVAILABLE` — retry the edit; or use write if the store stays unavailable.

Every other `E_*` code is fact-only. `E_LARGE_FILE` is deliberately deferred: read and edit need
different options and its payload names neither, so it stays fact-only until a `subject` lands.

### (d) Schema-shape remediation is a second, separate exception

`E_BAD_PAYLOAD` admission messages name the two valid wire shapes and the null rule: `Choice A …
Keep "text" and delete "text_ref"` / `Choice B … keep "text_ref" and delete "text"`, and `both
anchors are required, so null is not a value here`. These are not registry `options`: they describe
the call's shape, they offer mutually exclusive alternatives, and they are the owner-curated
weak-model remediation from ADR-0036's Option C. They stay in `analyzeItem` and are pinned by
`test/tools/edit.wire-contract.test.ts`, not by the producer scan below — the scan reads `message:`
literals at `new DomainError(...)` sites, and these are returned strings.


## Consequences

- The old `remedy` field is deleted. `ERROR_REGISTRY` exposes `options` only; `DomainError` renders
  it at construction, so the single cast path (`withPayloadSubject`, `attributePayloadSubject`) keeps
  one rendering without double-appending.
- Fact-only text is facts: the six producer messages that embedded imperatives now state the shape,
  the two foreign-reference headlines name the served-or-absent fact, and the batch trailers keep
  only the atomicity fact. A wrapper indents an item's `Options:` block under that item's bullet, so
  no option reads as another item's alternative.
- `test/arch/remedy-eligibility.test.ts` becomes the options-disclosure oracle: the curated set is
  pinned by name, every other code renders zero `Options:` lines and no imperative in every arm of
  its fixture list (multi-arm codes keep ordered arms, the #128 lesson), and negative controls fail
  a one-item list, a duplicate, a terminal period, a harmful verb, a preference adverb and a planted
  option on a real entry. A separate check pins that no `W_*` entry declares options.
- README's "Remedy / Agent Action" column becomes "Served options (refusal only)"; the eight
  invented actions and eleven deleted remedy cells are replaced by `—`.
- `E_SUSPICIOUS_TEXT` messages change: the plural is grammatical, the literal sentence moves into
  the option, and the write arm says `content`.
- No payload shape, code, audience or error/warning tier changes.

## Deferred

- **`E_LARGE_FILE` subject.** Add `subject?: "read" | "edit"` (or the tool name) to its payload,
  then serve read's verbatim option and edit's split option.
- **Warning-tier ownership.** `W_*` texts stay in `format`: a warning reports an applied mutation,
  so its text (and the dimmed notice) belongs to the same line. Three warnings are `MODEL`
  (`W_NEVER_SERVED_SHAPE`, `W_SERVED_PREFIX_MISMATCH`, `W_NOOP_INSERT`) and already carry their text
  there. An `options` field on a warning spec would be unrendered by `formatWarning`, so the oracle
  asserts no warning declares one.
