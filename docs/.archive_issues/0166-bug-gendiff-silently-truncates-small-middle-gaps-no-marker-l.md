# [bug] genDiff silently truncates small middle gaps — no " ..." marker, later anchors shifted

> **Archived from pre-migration issue #166.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @RX14 on 2026-09-24T20:07:18Z · state CLOSED · labels: bug, ready-for-agent, released

## Body

- [x] I have searched the existing issues

## Summary

2.2.0 — `genDiff` drops the unchanged rows of a small middle gap without emitting `" ..."`, and the line counters don't advance for the dropped rows, so later rows render with the wrong anchors (the applied edit is correct).

## Environment

- Version: pi-better-edit 2.2.0 (also master@00f8c34), Node 26.7.0
- Module: src/edit-diff.ts — `contextLinesToShow` / `genDiff`
- Command: `genDiff(oldContent, newContent, 4, _lineHashesPure(newContent))`

## Steps to Reproduce

1. Minimal input, pasted verbatim:

```ts
const gap = ["g1","g2","g3","g4","g5","g6"];
const oldContent = ["a","b",...gap,"c","d"].join("\n") + "\n";
const newContent = ["a","B",...gap,"C","d"].join("\n") + "\n";
```

2. Payload, pasted verbatim: `genDiff(oldContent, newContent, 4, _lineHashesPure(newContent))`

3. Run:

```ts
await initHasher();
const hashes = _lineHashesPure(newContent);
console.log(genDiff(oldContent, newContent, 4, hashes).diff);
// C's actual anchor is hashes[8] — "OZz" in the output below
```

## Expected behavior

The gap shows whole (6 rows ≤ 2 × context), and `C` carries its own anchor `OZz`:

```
 Wot│a
-   │b
+mV0│B
 H7N│g1
 2g2│g2
 q6Y│g3
 JNN│g4
 9ze│g5
 FBH│g6
-   │c
+OZz│C
 Rzv│d
```

## Actual behavior

```
 Wot│a
-   │b
+mV0│B
 H7N│g1
 2g2│g2
 q6Y│g3
 JNN│g4
-   │c
+9ze│C
 FBH│d
```

`g5`/`g6` are gone with no `" ..."` in their place; `+C` carries `9ze`, which is **g5's** anchor; `FBH` (**g6's**) sits next to `d`. Every row after the gap is off by the number of dropped rows.

## Impact & Trigger Conditions

Fires on any diff with an unchanged gap of `context+1 … 2×context` lines between two changes. The preview diff uses `context = 4`, so gaps of 5–8 lines — routine — hit it constantly. The model-facing diff uses `context = 1` and only misses 2-line gaps, which is why the applied-diff view looks fine and the preview looks broken. Impact is display-only: the applied edit is correct and the served rows are recomputed densely (`buildChanged`), so nothing wrong is persisted — but the preview is unreadable exactly where it matters, and the anchors it displays are wrong.

## Root Cause / Suggested Fixes (optional)

Hypothesis — `contextLinesToShow` (src/edit-diff.ts) has three cases and the last one is only correct for the trailing gap:

```ts
if (!lastWasChange) { /* leading: trim + " ..." via skipStart */ }
else if (nextPartIsChange && displayLines.length > contextLines * 2) { /* middle, large: head + ELLIPSIS_MARKER + tail, skipMiddle */ }
else if (linesToShow.length > contextLines) { linesToShow = linesToShow.slice(0, contextLines); }  // ←
```

A middle gap ≤ `2 × context` falls into the last branch: rows are sliced away without a marker, and since `skipMiddle` stays 0 the `newLineNum`/`oldLineNum` counters never advance for them — after the gap, `fmtDiffLine` indexes `effectiveNewHashes[newLineNum - 1]` against the wrong rows.

Alternatives, with tradeoffs:

- **Guard the trim branch to trailing gaps** (`!nextPartIsChange`) — small middle gaps show whole. Tradeoff: up to `2 × context` consecutive unchanged rows (8 at preview) instead of 4 + marker + 4; that's standard unified-diff behavior and keeps the counters exact. A patch implementing this (with `test/core/edit-diff.gap.test.ts`) passes the full test suite (1575 tests, 1 skipped). Happy to add it to this issue if useful.
- **Mark middle gaps at any size** (head + `" ..."` + tail below the threshold too). Tradeoff: the marker is consistent, but a 5-line gap renders as 4 + 1 + 4 = 9 lines for 5 real ones — noisier than showing it whole.
- **Keep the trim, only fix the counters** (skip accounting for dropped rows). Tradeoff: anchors become correct, but gaps still vanish without a marker — the confusion that made this visible stays.

## Comments

### @RX14 — 2026-09-24T20:08:06Z

One related design point, not a bug: one diff string serves both audiences — `finalizeResult` sends `details.diff` to the model as tool output (`context = 1`, `HASH│` anchor column), and `buildAppliedText` renders that same string for the user (`fmtResult` = coloring). So the post-approval view is token-shaped and carries the model's addressing, while the preview (`context = 4`) is the only display-tailored artifact — which is also why the bug above is visible there and nowhere else.

Built-in edit splits the two (`EditToolDetails`: `diff` display-oriented, `patch` machine); a display-side artifact here (the context-4 diff the preview already computes, say) would decouple the views. Design call, of course.

### @Rianico — 2026-09-26T08:24:26Z

thx for your feedback, this is a severe problem. A patch is welcome.

### @Rianico — 2026-09-26T08:25:51Z

> *This was generated by AI during triage.*

## Agent Brief

**Category:** bug
**Summary:** Diff gap-trimming silently drops middle rows and shifts later content anchors

**Current behavior:**
`genDiff(oldContent, newContent, contextLines, effectiveNewHashes)` collapses unchanged middle gaps for display. When a middle gap has more than `contextLines` but at most `2×contextLines` rows (e.g. 5–8 lines with context 4), the trimming path slices the row list without emitting a collapse marker and without advancing its internal old/new line counters. Result: dropped rows are invisible (no `...`), and every later row looks up `effectiveNewHashes` at a shifted index, so added lines display a wrong content anchor (e.g. `+C` shows g5-s anchor, g6-s anchor sits next to `d`).

**Desired behavior:**
- A middle gap collapses with a visible marker only when it genuinely exceeds what both sides need (larger than `2×contextLines`); gaps in the `contextLines+1 … 2×contextLines` window render fully (leading context + gap + trailing context).
- Whenever rows are hidden behind a marker, the old/new line counters still advance past the hidden rows, so all subsequent content-anchor lookups stay aligned with the true new-file line numbers.
- Behavior is generic in `contextLines` (the window scales with the caller-supplied context), covering both the context-4 preview and context-1 applied/model callers.

**Key interfaces:**
- `genDiff()` return contract: `diff` string plus served/anchor metadata must agree — every `HASH│content` row-s anchor must equal `effectiveNewHashes[trueNewLineNum - 1]` for its line, including rows after a collapsed gap.
- Gap-trimming helper (the `contextLinesToShow`-style collapse step inside the diff renderer): its contract is trim-only-trailing-or-genuinely-large middles + emit `skipMiddle`-style skip so counters advance.

**Acceptance criteria:**
- [x] Repro from the issue (two changes separated by a 6-line gap, context 4) renders all gap rows (`g1`–`g6`), `+C` carries the `C`-line anchor, `d` carries the `d`-line anchor.
- [x] Same repro shape at context 1 (gap of 2–3 lines) renders fully with stable anchors.
- [x] A large middle gap (>2×context) still collapses to a single `...` marker and later anchors stay aligned.
- [x] New regression test `test/core/edit-diff.gap.test.ts` pins the above; existing diff/preview suites stay green.

**Out of scope:**
- Display-diff vs machine-diff split (tracked in #169) — do not change the single-string contract, `finalizeResult`, or model retry context here.
- Changing default context sizes or preview-vs-applied context values.
- Applied-path dense recompute (already correct — display-only fix).


### @github-actions — 2026-09-27T13:09:27Z

:tada: This issue has been resolved in version 2.3.0 :tada:

The release is available on [GitHub release](https://github.com/Rianico/pi-better-edit/releases/tag/v2.3.0)

Your **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:
