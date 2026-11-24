# Spec: Diagnostic rendering budget — one verdict, one echo, one owner

Status: proposed (2026-11-24). Extends [ADR-0004](../adr/0004-model-tool-boundary-and-error-protocol.md) and the [error and warning contract](../reference/error-and-warning-contract.md) with a **rendering budget** for the model-facing surface. The two-grade `E_*`/`W_*` split, the `Options:` rule ([ADR-0047](../.archive_adrs/0047-remediation-options-are-refusal-scoped-and-neutral.md)), the reject-and-serve contract, and `details.cause` routing are unchanged.

This spec carries three tickets. Each one is an independent landing unit.

| Ticket | Surface | Issue |
| :--- | :--- | :--- |
| **T1** — unify the batch-rejection grammar | `src/edit-response.ts`, `src/domain-errors.ts`, `src/mutation-engine/*` | #323 |
| **T2** — delete echoed content | `src/payload-contract.ts`, `src/domain-errors.ts`, `src/mutation-engine/pipeline.ts` | #327 |
| **T3** — align the served prompts with the emitted shapes | `src/payload-contract.ts`, `prompts/*` | #328 |

---

## 1. Context and evidence

Measured on `08ca7a9` (v2.20.0) by driving the real `edit` tool through the mutation engine. Token counts are `chars / 4` on the rendered message.

| Scenario | Render | chars | ≈tok |
| :--- | :--- | ---: | ---: |
| A — 2 items, item 1 stale | `[MODEL] edit[1] (s.txt) failed: [E_TARGET_LOST] …` + trailer | 252 | 63 |
| B — 2 items, both malformed | head + verdict + 2 bullets + trailer | 569 | 142 |
| C — overlapping spans | `[MODEL] [E_BATCH_ABORT] Overlapping spans …` + bullets + rows + `Options:` | 281 | 70 |
| D — 1 item, stale | bare `[MODEL] [E_TARGET_LOST] …` | 201 | 50 |
| E — `strict` hole, 2 items | `[MODEL] edit[1] (hole.txt) failed: [E_UNSERVED_RANGE] …` + trailer | 303 | 76 |

Four defects are live. Three that #323 reports are not.

| #323 claim | Verdict | Evidence |
| :--- | :--- | :--- |
| Duplicated rows under `Current on-disk range` | **fixed before this spec** | `rg "Current on-disk range" src/` → 0 hits. Recorded as a defect in [stale-identity-reject-and-serve.md](stale-identity-reject-and-serve.md) Appendix C; the inner error is now the only echo. |
| Repeated `[TO MODEL]` header | **no producer** | `rg "TO MODEL" src/` → 0 hits. `stripModelPrefix` (`src/edit-response.ts:391`) leaves one `[MODEL]`. |
| Atomicity as trailing prose | **confirmed** | `BATCH_ATOMICITY_TRAILER` appended at `src/edit-response.ts:430,455,492`. |
| No denominator | **confirmed** | `edit[i] (path) failed:` carries no total; the wrapper never receives it. |
| — | **new** | B states atomicity 3×: head (`:453`), bullet reason (`hashline/resolve.ts:437`), trailer. |
| — | **new** | B renders `retry..` — the reason ends `.`, the registry format appends `.`. |
| — | **new** | Continuation lines are unindented, so one failure spans several unmarked lines. |
| — | **unreachable example** | `1 of 1 edit failed` cannot occur: a 1-item call throws the bare error (`pipeline.ts:890`), and the span gate returns at `edits.length < 2`. |

---

## 2. Principle

A rejection has three owners. A fact may appear in exactly one of them.

| Owner | Renders | Never renders |
| :--- | :--- | :--- |
| **Verdict** (envelope) | how many items failed, and that nothing was written | rows, per-item diagnosis |
| **Bullet** (one failing item) | item index, path, code, diagnosis, options | the verdict's atomicity sentence |
| **Inner error** (range family) | the served rows, once, under its own heading | a second copy at the envelope |

Corollaries:

1. Every fact has one owner. "Nothing was written" belongs to the verdict, so no inner message may also say it **when it is rendered inside a bullet**.
2. Echo is not disclosure. Content the model already supplied (its own payload), content already served in the tool description (the canonical payload), and content the join already names (a repeated count) are deleted, not reworded.
3. One failure is one list entry. Continuation lines are indented, so the bullet list stays parseable.
4. A code appears once per diagnosis, on the line that owns the diagnosis.

---

## 3. Decisions

**D1 — the wrapper keeps the item's code.** `E_BATCH_ABORT` stays the overlap code. The verdict line carries no `[E_*]` token; each bullet carries its item's code. Rejected alternative: promoting the wrapper to `[E_BATCH_ABORT]`. Five tests pin the inner code ([`test/integration/batch-error-propagation.test.ts:51,81,114,145,182`](../../test/integration/batch-error-propagation.test.ts)), spec §3.4 requires the envelope to represent the failing item, and the served prompt promises that one `[E_*]` line is the complete retry instruction — a header code that disagrees with `details.code` would break that promise.

**D2 — one grammar for every batch rejection.** Single failure, many failures, overlap, and malformed-payload items all render through one formatter. An overlap is the **later** item's failure, code `E_BATCH_ABORT`, naming the earlier item as the reason.

**D3 — the denominator is `K of N`, always.** `N` is the call's item count and is in scope at every throw site: `items.length` at `pipeline.ts:480,484,485` (`parseEdits`), `pipeline.ts:891,933` (apply loop), `edits.length` at `batch-span-gate.ts:223,226`. No arm falls back to a bare count.

**D4 — atomicity lives once, in the verdict.** `BATCH_ATOMICITY_TRAILER` is deleted from `src/`. Its four clauses collapse to `nothing was written`. The two facts it also carried are already implied: the call is atomic by contract, and a rejected call leaves the file unchanged.

**D5 — a 1-item call keeps the bare error.** There is no batch to reject, so no verdict line. Its message stays `[MODEL] [E_CODE] <diagnosis>`.

---

## 4. The rendering contract

```text
[<AUDIENCE>] Batch rejected: <K> of <N> <edit|edits> failed; nothing was written.
- edit[<i>] (<path>) [<E_CODE>]: <diagnosis, first line>
  <diagnosis, each further line, two-space indented>
```

Rules:

1. `AUDIENCE` is the failing item's audience, read from its registry spec. T1 adds no new audience rule.
2. `<E_CODE>` is the item's own registry code. Strip `[MODEL] ` and `[E_CODE] ` from the item's rendered message before embedding; promote the code to the bullet token.
3. The item's `Options:` block renders indented under its bullet, exactly as today (`indentOptions`).
4. Range-family rows render inside the owning bullet only. No envelope-level re-render.
5. `<path>` is the call's `file` value as received. A `text_ref` item's second file is named in its own diagnosis, never in the bullet header.
6. `<K>` counts failing items. `<N>` is the call's item count.
7. `edit` is singular when `N === 1`, `edits` otherwise.

### Single failure, row-carrying inner

```text
[MODEL] Batch rejected: 1 of 2 edits failed; nothing was written.
- edit[1] (s.txt) [E_STALE_RANGE]: line 2 in s.txt no longer resolves to the line identity it was served with.
  Current range (fresh read):
  Wot│a
  mV0│B
  BkM│c
  Rzv│d
  These rows are the file's current anchors and were recorded as served — retry with them.
```

### Single failure, rowless inner

```text
[MODEL] Batch rejected: 1 of 2 edits failed; nothing was written.
- edit[1] (hole.txt) [E_UNSERVED_RANGE]: Strict span mode refused the edit to hole.txt: 1 of the 3 file lines it replaces was never served.
  Unserved file line: 2
```

### Multiple failures

```text
[MODEL] Batch rejected: 2 of 2 edits failed; nothing was written.
- edit[0] (m.txt) [E_MALFORMED_ANCHOR]: The anchor "gA3d│a" is not valid: anchor carries a "HASH│" prefix ("gA3d│a"). Copy only the 4 chars before │ and retry.
- edit[1] (m.txt) [E_MALFORMED_ANCHOR]: The anchor "0PkG│b" is not valid: anchor carries a "HASH│" prefix ("0PkG│b"). Copy only the 4 chars before │ and retry.
```

(T2 removes the in-bullet `Nothing was written;` and the doubled period these show today.)

### Overlapping spans, folded

```text
[MODEL] Batch rejected: 1 of 2 edits failed; nothing was written.
- edit[1] (o.txt) [E_BATCH_ABORT]: its span (lines 2-4) overlaps edit[0] (lines 1-3) at lines 2-3.
  Current range:
  uRY8│b
  gGb3│c
  CAjc│d
  Options: merge the overlapping items into one span; or split them across separate calls.
```

`code` stays `E_BATCH_ABORT`, so `toFailure` routing and the `Options:` eligibility (`test/arch/remedy-eligibility.test.ts`) are unchanged.

---

## 5. T1 — unify the batch-rejection grammar (#323)

**Intent.** One formatter renders every batch rejection: verdict line, one bullet per failure, indented continuation, atomicity stated once.

**Implementation shape.** Collapse `batchAbortFor`, `batchAbortForMany` and `wrapParseFailure` (`src/edit-response.ts:426,446,490`) into one exported formatter taking `{ failures, total, path }`. Single-failure sites pass a one-element array. Thread `total` from the five throw sites in D3. Rewrite the `E_BATCH_ABORT` registry format (`src/domain-errors.ts:448`) into the item voice of §4.4. Delete `BATCH_ATOMICITY_TRAILER`.

**Acceptance tests.**

1. Every batch rejection's first line matches `^\[MODEL\] Batch rejected: \d+ of \d+ edits? failed; nothing was written\.$`.
2. `N` equals `edits.length` for all four arms (parse failures, span gate, apply loop, overlap).
3. `rejection.code` equals the first failing item's domain code, and each bullet names that item's own code.
4. No line after `- edit[` starts at column 0 except another `- edit[` bullet.
5. `BATCH_ATOMICITY_TRAILER` and the literal `NOTHING was written` appear nowhere in `src/`.
6. Overlap: message equals the §4.4 fold and `code === "E_BATCH_ABORT"`.
7. A row-carrying failure renders its rows exactly once: the count of `HASH│` lines equals `servedRows.length`.
8. A 1-item call still throws the bare `[MODEL] [E_CODE]` error (D5).
9. The five existing `not.toContain("[E_BATCH_ABORT]")` pins stay green.

**Docs.** Update the `E_BATCH_ABORT` row of [`docs/reference/error-and-warning-contract.md`](../reference/error-and-warning-contract.md) to the folded shape, and the `E_BATCH_ABORT` entry of `GLOSSARY.md`.

**Measured target.** A 63 → ≈45 tok. B 142 → ≈80 tok.

---

## 6. T2 — delete echoed content

**Intent.** Remove facts the model already has. Delete only; no rewording except where noted.

| # | Item | Location | ≈tok saved | Why the model already has it |
| :--- | :--- | :--- | ---: | :--- |
| 1 | `describeReceived(input)` payload echo (up to 600 chars) | `src/payload-contract.ts:405,416,465` | ≤150 | The model sent the payload. The shape verdict on the same line already names the expected shape. |
| 2 | `EDIT_PAYLOAD_HINT` (795 chars) inlined into five refusal arms | `src/payload-contract.ts:405,424,432,439,445` | ≈200 | The identical contract is served in `EDIT_DESCRIPTION`/`EDIT_GUIDELINES` every session. Replace with one shape line: `Edit payload: { file, edits: [{ anchor_from, anchor_to, text \| text_ref[, at] }], mode? }`. |
| 3 | Second noop report | `src/mutation-engine/pipeline.ts:935-940` | ≈19/item | `W_NOOP` was pushed two lines earlier for the same item. |
| 4 | `suspiciousTail` repeat of the submission count | `src/domain-errors.ts:272-274` | ≈18 | The same count is rendered in the same sentence. |
| 5 | `The edit was not applied.` | `src/domain-errors.ts:505` | 6 | ADR-0004: `E_*` means nothing was written. |
| 6 | Doubled period at the reason join | `src/hashline/resolve.ts:433,435,437` | 0 (cosmetic) | The registry format appends the terminator. |

**Deferred.** Deleting ` in ${path}` from headline formats (`domain-errors.ts:407,505`). A 1-item call has no bullet header, so it is the only place that names the file. Revisit only if D5 ever changes.

**Acceptance tests.**

1. No refusal message contains `Received: `.
2. No refusal message contains more than one `Edit must be called` / canonical-payload sentence.
3. A warn-path noop pushes exactly one warning.
4. `E_SUSPICIOUS_TEXT` with `count = 3` renders the count once.
5. No model-facing string ends with `..`.
6. Every remaining message keeps its code, its rows, its `Options:` block, and its audience prefix (regression: the packet is unchanged, only the deleted fragments are gone).

**Measured target.** A malformed payload: ≈350 tok → ≈60 tok. Ticket: #327.

---

## 7. T3 — align the served prompts with the emitted shapes

**Intent.** The served text must not promise a shape the code no longer emits. These are prompt edits, not code edits.

| # | Promise | Reality | Fix |
| :--- | :--- | :--- | :--- |
| 1 | `payload-contract.ts:203` + `prompts/edit-guidelines.md:9`: `Current range (fresh read):` is *the* fresh-read heading | The code emits two headings: `Current range (fresh read):` for the range family, `Current range:` for `E_STALE_ANCHOR`, `E_BATCH_ABORT`, `E_NOOP_LOOP` (`domain-errors.ts:331,418,467,480`) | Name both, and say which tier carries fresh leases. |
| 2 | Same line: "A dimmed `[USER]` line in `details` is human info" | `[USER]` warnings are joined into model `content` by `warnBlock` (`edit-response.ts:96`, pinned by `test/tools/edit.noop-loop.test.ts:35`) | Say that `[USER]` lines appear in `content` and are informational, not refusals. Resolve the wording against #279, which owns the `W_NOOP` audience question. |
| 3 | `EDIT_DESCRIPTION`: "`[MODEL] [E_*]` is your retry instruction" | A batch bullet renders `- edit[1] (path) [E_CODE]:`, so the audience and the code are not adjacent | Say "a `[E_*]` token and the line it opens". |

**Acceptance tests.** One arch test that renders each documented shape from the code path and asserts the served prompt names it; and a manual read of the served description via `pnpm run prompts:show`. Ticket: #328.

---

## 8. Verification plan

Each ticket lands with `pnpm run verify` (changelog floor → lint → format → typecheck → test:coverage) and `pnpm run audit`. Each carries its own `## [Unreleased]` entry: T1 (`fix`), T2 (`perf`), T3 (`docs`, exempt from the PR-boundary floor).

The measurement harness for T1 and T2 is the five-scenario probe in §1, re-run and re-counted before and after.

---

## 9. Not touched

- Registry `code`, `details.cause`, and `toFailure` routing.
- Serve recording, leases, and the reject-and-serve contract.
- The `Options:` eligibility rule (three codes only).
- The `[USER]` / `[MODEL]` audience assignment.
- The read-tier warnings (`W_MIXED_EOL`, window warnings) and every surface listed as clean in the audit: `E_NOT_FOUND`, `E_EMPTY_RANGE`, `E_LOSSY_TEXT`, `E_UNDO_STALE`, `E_LARGE_FILE`, `E_UNSUPPORTED_FILE`, `E_ACCESS`, `E_INTERNAL_INVARIANT`, `E_UNKNOWN`, `W_EOL_REWRITTEN`, `W_REVERSED_ANCHORS`, `W_UNICODE_LITERAL`, `W_LITERAL_BYPASS`, janitor and bash-view banners.
