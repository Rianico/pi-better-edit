# ADR-0048 - Bash serve admission: display tails, context searches, and verified compound chains

Date: 2026-10-18

## Status

partially accepted — four-run corpus analysis (3,582 bash calls) and an independent design review.
D1 is accepted and implemented by #175 (PR #177); D4 is accepted and implemented by #185;
D2/D3/D5 are deferred with their tracking issues;
D6 is accepted as standing architecture guidance.
Extends [ADR-0033](0033-bash-view-interception.md) and [ADR-0039](0039-compound-bash-view-interception.md).
Narrowly amends ADR-0033 D5 for display-only transforms; extends D9 with a second invariant.
ADR-0033 D7's multi-file **view** non-goal remains in force (see D5).

| decision | subject | status |
|---|---|---|
| D1 | two-sided serve invariant: prediction **and** attribution | accepted — implemented by #175 (PR #177) |
| D2 | display-only tails (`cat -A`, `od -c`, `xxd`, `hexdump -C`) | deferred — #176 |
| D3 | context searches (`-A`/`-B`/`-C`) | deferred — #183 |
| D4 | verified compound chains with an inert count tail | accepted — implemented by #185 |
| D5 | multi-file views (defined safe subset only) | deferred — #183 |
| D6 | extend the rule table; do not build an optimizer | accepted |

Amended 2026-10-23 (Issue #175, PR #177, commit `8b6a0b8`): D1 landed and is enforced — the
two-sided serve invariant is implemented. D2–D5 are still deferred with the tracking issues
named above.

Amended 2026-10-26 (Issue #185, commit `8362f2f`): D4 landed — the inert count tail is admitted
only after the last verified block of a multi-block, statically glued compound; the verified
blocks keep their banners, anchors and per-block leases, and the tail's already-observed bytes
ride through raw, unleased and without an anchor or a block of its own. D3/D5 remain deferred.

## Context

The [bash interception gaps analysis](../analysis/bash-interception-gaps.md) replayed four 2.13.0 runs:
3,582 bash calls, 254 served (7.1%), 79% of calls compound, and only 2.8% of compounds served.
The safe, high-frequency gaps are: display-only tails (49 of 117 terminal calls newly servable),
context searches (3–8 calls), and verified compound chains (55–63 of ~80 all-safe compounds).
There are **zero standalone multi-file views**; the 55 calls previously labelled multi-file were
`cat FILE 2>&1 | head` compounds.

The review found that the predicted-stdout invariant is necessary, not sufficient: it constrains
the prediction, not attribution. This ADR keeps the closed set of admission rules and adds the
missing attribution invariant.

## Decision

### D1. Two-sided serve invariant

Before the first lease, two checks must pass:

1. **Prediction.** The observed stdout must equal the predicted stdout under ADR-0033 D9's
   normalization (LF/no-BOM; trailing-newline leniency only).
2. **Attribution.** Every served block must be byte-identical to its re-read file slice and must
   occupy a disjoint, ordered interval of observed stdout. The interval is derived from file
   lengths or line counts, never from content matching. For a display transform, the served block
   is the raw re-read slice and the observed interval must equal `transform(block)`.

If a boundary cannot be proven from lengths or counts — missing trailing newline, an
implementation-specific header, an ambiguous transform — the command passes through. This is the
review's "served ⊆ observed with a per-block boundary proof"; D9 alone is necessary, not sufficient.

### D2. Display-only tails (amends ADR-0033 D5)

Admit a **terminal** `cat -A`, `od -c`, `xxd`, or `hexdump -C` stage over an already-admitted view.
The transform output is never served and never leased: serve the raw re-read rows, and disclose the
drop with one line under the existing banner (for example `[cat -A rendering dropped; raw rows served]`).
The frozen banner literals do not change.

Guards: terminal stage only; no operand, redirect, or further pipeline; closed transform set; the
transform must reproduce observed stdout exactly; mismatch or over-cap → pass-through with zero
leases. This preserves ADR-0033 D5's reason — anchors never describe transform bytes — while
allowing the raw rows the model needs.

### D3. Context searches (extends ADR-0033 D10)

Admit `grep -A/-B/-C` and `--after-context/--before-context/--context N`, and `rg -C`, on the
existing search shapes. Parse match rows (`LINE:content`) and context rows (`LINE-content`), including
`--` group separators. Every row is re-read and byte-compared; context rows are served and leased
under the same `(session, path, anchor)` key. Add a total-row cap independent of
`SEARCH_MAX_MATCHES`; over-cap → pass-through, never truncation. Recursive context is excluded
(directory order); `-c`/`-o`/`-l` combinations remain refused.

### D4. Verified compound chains (extends ADR-0039 D10)

Keep the existing sequential peel and static-glue rules (ADR-0039 D1/D2/D4/D6). The only delta is
an inert count segment (`wc -l/-c`) after the last verified block, recomputable from the re-read
files. Multiple blocks still require static glue; each block is verified before the first lease; any
unverified, mutating, interpreter, `ls`/`find`, subshell, or redirect segment passes the whole
command through. This does **not** reopen ADR-0039 D10's second-block attribution guard.

### D5. Multi-file views: deferred, with a defined safe subset

A decorator-free multi-file view is **safe in principle** but not admitted now. The safe subset is:
`cat` (no flags), `cat -n`, `nl -ba`, and `sed -n` over two or more newline-terminated text files;
one block per file with a per-file header; offset-based boundary proof; a total row/file cap.
`head`/`tail` with multiple files are excluded because their `==> file <==` headers are not file
bytes and are implementation-dependent. Any non-newline-terminated file, non-text file, or
unprovable boundary passes through.

Admission waits for a follow-up ADR with the multi-block serve seam, per-file leases, and the
boundary tests. ADR-0033 D7's multi-file view non-goal remains in force until then. The corpus has
zero standalone multi-file views, so this decision claims no benchmark gain.

### D6. Architecture: extend the rule table; do not build an optimizer

The classifier stays pure and zero-filesystem; file resolution and byte verification stay at the
serve seam. The ordered `RULES` table is the single admission authority. Do not add a fixed point,
a scoring model, filesystem access in analysis, or command rewriting/re-execution. Caps
(`MAX_READ_WINDOWS`, `SEARCH_MAX_MATCHES`, chain and pipeline limits) decide serve versus
pass-through; they are predicates, not costs. The same command always runs; only the rendered
result changes.

## Alternatives considered

- **Rewrite the command to a canonical form, then execute it.** Rejected: side effects, shell
  expansion, and environment differences make equivalence unprovable. The original command must run.
- **Do nothing.** Rejected because the safe shapes are now specified and the review produced a
  falsifiable invariant; the release gate decides whether the gain justifies the surface.
- **Admit standalone multi-file views now.** Rejected: zero corpus coverage, a new multi-block
  seam, and boundary risk. The subset is recorded in D5 for a follow-up.

## Consequences

- **Closed `DeclineReason` additions:** `multi-file` for the deferred multi-operand view (replacing
  the coarse `unsupported-command:<prog>` for that shape), and `display-transform` for a display
  stage outside the closed set or not terminal. Existing reasons keep their meaning; reasons remain
  internal codes, never model-rendered (ADR-0033 D6).
- **Amended clauses:** ADR-0033 D5 (display tails), ADR-0033 D9 (two-sided invariant), ADR-0039
  D10 (inert-tail extension). ADR-0033 D7's multi-file view non-goal is narrowed to "deferred," not
  removed.
- **Witness tests:** `test/tools/bash-classifier.test.ts` (admission of the three shapes; refusal of
  non-terminal transforms and context-plus-count combinations);
  `test/tools/bash-conversion-rules.test.ts` (rule precedence and new reasons);
  `test/tools/bash-view-lifecycle.test.ts` (transform mismatch, raw-row leases, context geometry,
  per-block attribution, over-cap pass-through); `test/tools/bash-banner-freeze.test.ts` (banner
  literals unchanged; disclosure line only for display tails). Add a property test that every served
  row is byte-identical to its re-read slice and every block interval is disjoint and ordered.
- **Release gate:** replay the four `explicit-edit-2026-10-18` runs (3,582 bash calls) through the
  new rules. Require zero invariant mismatches, no regression in the 254 currently served calls,
  and a documented new-serve count. The corpus is external to this repo; the gate is release-time,
  not a CI test.
- **Environment gate:** run the replay with RTK search/read compaction disabled (or
  `pix-optimizer` not rewriting `grep`/`cat`/`head`/`tail`). In the real pi-lens session, 41 of 89
  admitted searches were unserved; 37 of the 41 were attributable to RTK 0.48.0, not pi-lens.
  Without this gate the replay measures RTK, not the new rules.
- **Expected gain:** 107–120 newly served calls (3.0–3.4% of bash), lifting the banner rate from
  7.1% to roughly 10%; the real benefit is fewer re-read round trips, not the banner rate. The
  shadow replay may reduce this. Multi-file contributes zero today.
- **Risks:** the disclosure line is a new model-facing surface; context rows increase leases and
  served bytes; an inert count can misattribute if it is not recomputable; display transforms can
  hide intent if the disclosure is missed. Each is covered by a fail-closed test above.

## Tracking

- **#175** — D1, two-sided serve invariant: landed and closed (PR #177).
- **#176** — D2, display-only tails: deferred; this record keeps the safe shape and its guards.
- **#183** — D3/D5, context searches and multi-file views: deferred, tracked in one follow-up.
- **#185** — D4, verified compound chains with an inert count tail: landed.

## Links

- [ADR-0033 — AST-guarded bash view interception](0033-bash-view-interception.md)
- [ADR-0039 — Compound bash view interception and sequential peeling](0039-compound-bash-view-interception.md)
- [Bash interception gaps analysis](../analysis/bash-interception-gaps.md)
