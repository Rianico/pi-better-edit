# Bash interception coverage — pi-better-edit 2.13.0

Read-only analysis of four completed benchmark runs (2026-10-18). No benchmark rerun, no source
changes, no commits. "Served" means a hashline banner was emitted:
`--- Bash view (hashline anchors) ---` or `--- Bash search (hashline anchors) ---`.
The file-list and auto-read banners were emitted zero times.

## Corpus and method

| run | model | trials | rounds | bash calls | served view/search |
|---|---|---|---|---|---|
| A `09-05-15` | muse-spark-1.3-contributor | 226 | 297 | 698 | 19 (2.7%) |
| B `09-47-11` | deepseek-v4.1-flash | 226 | 274 | 971 | 74 (7.6%) |
| C `10-28-43` | mimo-v2.6-flash | 226 | 288 | 730 | 56 (7.7%) |
| D `11-11-32` | qwen3.8-flash | 226 | 277 | 1,183 | 105 (8.9%) |
| **total** | | **904** | **1,136** | **3,582** | **254 (7.1%)** |

- Events were joined by `toolCallId` from `trials/*/rounds/*/agent/stdout.jsonl`; the banner in
  `tool_execution_end.result.content[].text` is the ground truth for served.
- Verdicts/reasons come from this worktree's `src/bash-classifier.ts`, bundled locally with the
  repo's own `esbuild` (no install). It admitted 265 calls; 254 were served, 11 (4% of admitted)
  produced no banner (empty output, zero-match search, or a serve-time gate).
- Shape is a deterministic syntactic classifier over the command text. Precedence: mutation >
  interpreter > oracle-hunting > search-with-context > search > multi-file view > single-file view >
  listing > compound > other. A leading `cd X &&` is attributed to the block that follows it.
- Limitations: the reason names the **first failing segment**, not the semantic cause; a compound can
  fail for several reasons; shape is not intent. `normalized/tool-calls.jsonl` agrees with the event
  parse (698/971/730/1,183 bash rows).

## 1. Frequency by shape

Cells are `calls/served`; served % is last. Pipeline/compound is cross-cutting (structural table below).

| shape | A | B | C | D | total | share | served |
|---|---|---|---|---|---|---|---|
| single-file view (`cat`, `head`, `tail`, `sed -n`, `nl`) | 54/4 | 150/12 | 65/5 | 156/21 | 425 | 11.9% | 9.9% |
| pattern search (`grep`, `rg`) | 66/14 | 280/53 | 261/51 | 358/84 | 965 | 26.9% | 20.9% |
| search with context (`-A`/`-B`/`-C`) | 0/0 | 5/0 | 2/0 | 1/0 | 8 | 0.2% | 0% |
| standalone multi-file view | 0/0 | 0/0 | 0/0 | 0/0 | 0 | 0% | — |
| mutation (`sed -i`, `perl -pi`, `tee`, `>`, `cp`/`mv`/`rm`) | 45/0 | 73/0 | 67/0 | 138/0 | 323 | 9.0% | 0% |
| interpreter (`python`, `node`, `awk`, `perl`, heredocs) | 327/0 | 159/1 | 86/0 | 246/0 | 818 | 22.8% | 0.1% |
| directory listing (`ls`, `find`, `tree`, `pwd`, `wc`) | 158/0 | 149/0 | 211/0 | 210/0 | 728 | 20.3% | 0% |
| verification/oracle hunting (`find /`, `/tmp/jiti`, `verif`, `expected`, `/scratch`, `/state`) | 44/1 | 128/8 | 29/0 | 37/0 | 238 | 6.6% | 3.8% |
| unclassified compound head | 4/0 | 20/0 | 8/0 | 32/0 | 64 | 1.8% | 0% |
| cd/env (`cd`/`export`/`set` with no block) | 0/0 | 0/0 | 0/0 | 0/0 | 0 | 0% | — |
| other | 0/0 | 7/0 | 1/0 | 5/0 | 13 | 0.4% | 0% |

| structure | calls | share | served | served % |
|---|---|---|---|---|
| simple (no top-level operator) | 768 | 21.4% | 174 | **22.7%** |
| pipeline (`\|`) | 215 | 6.0% | 9 | 4.2% |
| `&&`/`\|\|` chain | 315 | 8.8% | 28 | 8.9% |
| `;`/newline chain | 651 | 18.2% | 28 | 4.3% |
| mixed | 1,633 | 45.6% | 15 | 0.9% |

79% of calls are compound; those compound calls account for only 80 of the 254 serves (2.8%).
Simple search serves 85.0% and simple single-file view 68.3%; the gap is composition, not predicates.

## 2. What is admitted, what is refused, and why

Admitted decision kinds (`src/bash-conversion/decide.ts`, `src/bash-classifier.ts`):

| decision | admitted forms | caps |
|---|---|---|
| `pureView` | `cat`/`head`/`tail`/`sed -n`/`nl` on **one** file; numeric ranges merged; 2–4 stage pipelines of the view with `head`/`tail`/`sed -n`; content filters `grep PAT` (keep), `grep -v PAT` (drop), `rg -N PAT` (keep), `sort -u`, `uniq`; `wc -l` as a count; one pre-view `cd`; static `echo`/`printf` glue | `BASH_VIEW_MAX_PIPELINE_STAGES=4` |
| `pureSearch` | `grep`/`rg` over one or more files (≤10), recursive dirs, `-n` injected; allowlisted flags `-n -i -F -E -w -x -m N -e PAT --color=never`; `head`/`tail`/`sed -n` slice tail | `SEARCH_MAX_MATCHES=50`, `BASH_SEARCH_MAX_FILES=10` |
| `pureMultiSearch` / `pureRecursiveSearch` | file-prefixed triples; directory walk; non-text files skipped | same |
| `pureFilesList` | `rg --files [DIR]` (no anchors by design) | — |
| `pureCompound` | blocks separated by static glue / inert count; ≤8 chain segments; `&&` or silent `;` prefixes | `BASH_VIEW_MAX_CHAIN_SEGMENTS=8` |

Everything else is `passThrough { reason }`. Top reasons over 3,582 calls:

| reason | n | share | typical form |
|---|---|---|---|
| `unsupported-pipeline` | 809 | 22.6% | a non-view/filter stage: `sed -n … \| cat -A`, `ls \| head`, `grep … \| od` |
| `non-literal-command` | 630 | 17.6% | `$'…'`, `2>/dev/null`, `$(…)`, `<(…)`, `$VAR`, redirects |
| `multi-statement` | 484 | 13.5% | newline-separated script/heredoc body |
| `unsupported-command:ls` | 317 | 8.8% | `ls`, `ls -R`, `ls \| head` |
| `unsupported-command:python3` | 265 | 7.4% | inline Python, heredoc scripts |
| `unsupported-command:find` | 177 | 4.9% | `find .`, `find /` |
| `unsupported-command:grep` | 120 | 3.4% | `-c`, `-o`, `-l`, `-v`, `-A/-B/-C`, `-P` |
| `non-and-chain` | 101 | 2.8% | `;` chain with more than a silent prefix, `\|\|` |
| `unsupported-command:wc` | 78 | 2.2% | `wc -c`/`wc -l` as a source, not a filter |
| `chain-too-long` | 59 | 1.6% | >8 segments |
| `unsupported-command:sed` | 54 | 1.5% | `sed -n '20p;1028p' f` (multi-range without `-e`), `sed` hazards |
| `unsupported-command:cat` | 33 | 0.9% | `cat -A`, `cat a b` |
| internal throw (`…reading 'some'`) | 19 | 0.5% | loops/heredocs; caught by the hook's `try` → raw (fail closed) |

Other reasons: `cp/rm/mkdir/chmod` (writes), `echo`/`perl`/`compound-top`, `post-block-cd`,
`post-view-cd`, `multi-cd`, `multi-view`, `no-view`, `background`, `empty`, `parse-error`.

Serve-time gates, independent of classification:
- one text block per view segment; truncation flag, non-text file, empty or over-budget output → raw, zero leases;
- observed stdout must reproduce the re-read slice (line-ending/BOM normalization is explicit);
- numbered stdout must satisfy strict `1..L` geometry; numbers are display-only (line 212:
  "never used as a lease coordinate (leases come from re-read positions)");
- search rows are re-read and byte-compared; over-cap search passes through raw rather than truncate.

The reason is fail-closed but coarse: `cat a b` reports `unsupported-command:cat`, not "multi-file";
`sed -n '20p;1028p'` reports `unsupported-command:sed` even though `sed -n -e '20p' -e '1028p'` is
admitted. Counts below therefore use counterfactual re-classification, not the reason string.

## 3. Safety of the top refused shapes

Criteria: byte-faithful single-file read; no writes, redirects, or side effects; bounded output;
deterministic; no ambiguous expansion; anchors resolvable from served state.

| refused shape | calls | safe to intercept? | reason / extra guard |
|---|---|---|---|
| `grep -c` count-mode search | 223–363 | **No (anchorless)** | read-only and bounded, but output is a number: no line, no lease, no edit. A count banner would raise the served rate ~6–10 pp with zero conversion. |
| single-file view with a display tail (`\| cat -A`, `\| od -c`, `\| xxd`, `\| hexdump -C`) | 189 (117 terminal; 49 newly) | **Yes, with a transform gate** | the head is byte-faithful and bounded; the tail is display-only. Serve the **raw** re-read rows; check the transform reproduces observed stdout; terminal stage only, no operand/redirect; over-cap → raw. |
| compound search/view chains | 434 / 107 | **No as a class** | one unsafe segment (write, interpreter, `ls`/`find`, subshell) poisons the command. Only the strict algebra in §4 is safe. |
| context search (`-A/-B/-C`) | 8 | **Yes** | single/multi-file, read-only, deterministic. Needs `LINE:content` **and** `LINE-content` parsing, `--` group separators, a total-row cap independent of the 50-match cap, and byte verification + leases for context rows. |
| multi-file view (`cat a b`) | 0 standalone | **Yes, for a decorator-free subset** | the 55 apparent calls were `cat FILE 2>&1` compounds. unbash gives the operands; the refusal is `parseSourceStage`'s single-file predicate, not a parse limit. Serve one block per file after a full concatenation byte check; anchors are path-seeded, so a wrong-file edit fails closed. `head`/`tail` without `-q` add non-file headers (unsafe). |
| ANSI-C quoting (`$'…'`) | 168 contain it; 6 newly | **Yes, with a decoder** | bash ANSI-C quoting is deterministic (`\u`, `\x`, `\0`), but the decoder must emit the same bytes as bash; the row byte-gate catches pattern mistakes. `$VAR`/`$(…)`/backticks remain unsafe. |
| stderr redirect (`2>/dev/null`) | 750 contain it; 3 newly | **Yes, narrow** | stderr is not stdout and cannot corrupt the byte gate; ignore only `2>/dev/null`. `2>&1` merges into stdout (unsafe); `2>file` writes (unsafe). |
| `sed -n 'Ap;Bp'` multi-range | 4 newly | **Yes** | same file, numeric ranges; split/merge ranges before leasing; byte-gate as today. |
| directory listing (`ls`, `find`, `tree`) | 728 | **No** | order-dependent, unbounded, no line geometry. The file-list banner has no anchors and was never used. |
| interpreter (`python`, `node`, `awk`, `perl`) | 818 | **No** | arbitrary reads/writes/network; output is not attributable to file lines; non-deterministic. |
| mutation (`sed -i`, `perl -pi`, `tee`, `>`, `cp`/`mv`/`rm`) | 323 | **No** | writes; serving would hide the write and anchor stale coordinates. |
| oracle hunting (`find /`, `/tmp/jiti`, `/scratch`, `/state`) | 238 | **No** | outside the workspace, unbounded, and it is benchmark leakage, not editing. |

## 4. Ranked gaps (benchmark coverage × safety)

Coverage is *newly served calls* under the counterfactual, not raw shape frequency. Anchorless
modes (`grep -c`, `ls`, `wc`) are excluded from the ranking: they lift the banner rate but cannot
enable an edit.

| rank | gap | new calls | share of bash | safety | why it matters |
|---|---|---|---|---|---|
| 1 | ignore a terminal display filter on an admitted view/search head | 49 of 117 | 1.4% | high (raw rows only) | largest single-predicate safe win; the head is already byte-verified |
| 2 | context-line search (`-A/-B/-C`, parse + lease context rows) | 3–8 | 0.1–0.2% | high (bounded, byte-verified) | only gap that directly increases the anchorable window around a match |
| 3 | strict compound algebra (block + static glue + inert count, `&&`/silent `;`) | 55–63 of ~80 | 1.5–1.8% | medium | the structural ceiling; two-block serving exists, the gap is chain algebra |
| 4 | ANSI-C quoting decoder (`$'…'`) | 6 | 0.2% | medium (decoder must match bash bytes) | prerequisite for many patterns; `$'…'` is deterministic |
| 5 | `sed -n 'Ap;Bp'` multi-range | 4 | 0.1% | high | trivially safe; `-e` form already works |
| — | relaxed “one block + arbitrary read-only helpers” | up to 547 | 15.3% | **low** | all-safe analysis stops at 80; the loose 547 needs a new locate-and-verify seam and violates the bounded/deterministic bar |

### Top 3: predicate change and tests-first

**1. Display-filter tail.** In `parseFilterStage`/`parseViewSegment`, admit a terminal
`cat -A` / `od -c` / `xxd` / `hexdump -C` stage as a *display transform* over an already-admitted
view/search head. The transform is not served; the raw re-read rows are. Guard: terminal only, no
operand/redirect, closed transform set, observed stdout must equal `transform(re-read slice)`,
over-cap or mismatch → raw and zero leases.
Tests first (`test/tools/bash-classifier.test.ts`, `test/tools/bash-view-lifecycle.test.ts`):
`sed -n '1,5p' f | cat -A` → `pureView`; bare `cat -A f` → refused; `… | cat -A | head` → refused;
`… | cat -A > out` → refused; `… | cat -A other` → refused; `od/xxd/hexdump` variants; lifecycle
"serves raw rows when the observed stdout is the `cat -A` rendering", "fails closed when the
transform does not reproduce stdout", "leases only raw rows", "passes through over the byte budget".

**2. Context-line search.** Extend `parseSearchStage` to accept `-A/-B/-C`,
`--after-context/--before-context/--context N` for grep/rg. Parse `LINE:content` (match) and
`LINE-content` (context) plus `--` separators; reject ambiguous geometry (content beginning with
digits + `-`); add `SEARCH_MAX_TOTAL_ROWS` independent of `SEARCH_MAX_MATCHES`; byte-verify every
context row and lease it. Guard: no recursive context (directory order), all-or-nothing, over-cap
→ raw.
Tests first: classifier forms accepted/refused, context + `-c/-o/-l` refused, `--context=3`,
malformed `-A` refused; lifecycle "serves match and context rows", "leases context rows", "fails
closed when a context row no longer matches disk", "fails closed over the total-row cap", extending
the existing "serves a sparse match set and leases only the matched lines".

**3. Strict compound algebra.** Generalize `pureCompound` (which already serves two `cat` blocks
with static glue and per-file headers) to count/inert segments; separators `&&` or `;` only; ≤8
segments; at most one block per file unless ranges merge. Verify every block before the first
lease; one bad block → whole command raw, zero leases. Keep two seams: a multi-operand view
(`cat a b`) stays refused; a single view yielding multi-block stdout stays fail-closed.
Tests first: rules "admits a block plus an inert count", "declines `ls`/`find`/python between blocks",
"declines a redirect on a glue segment", "declines overlapping ranges on one file";
lifecycle "extends two-block serving with per-file leases", "one bad block leaves the command
byte-identical", "does not bleed anchors across files".

**Never intercept:** any write or redirect (`sed -i`, `perl -pi`, `tee`, `>`, `cp`/`mv`/`rm`) or a
compound containing one; multi-file views without per-file headers; interpreters, subshells, `||`;
`find`/`ls`/oracle probes. Serving these hides side effects or breaks the file-scoped anchor namespace.

**Metric trap:** `grep -c` is the single largest refused search subcase (223–363 calls) and `ls`
adds 317. Admitting them as anchorless banners would move the served rate from 7.1% to at least 13%
with no new editable rows. Do not optimize the banner rate alone.

## 5. Hypothesis check

**Served share 4–9%: confirmed.** 2.7%, 7.6%, 7.7%, 8.9%; 7.1% overall (254/3,582).

**Conversion after served view/search vs read.** "Edited next" = next tool call is `edit`;
`edit≤3` = an edit within the next three tool calls.

| model | served view/search n | next-edit | edit≤3 | read n | next-edit | edit≤3 |
|---|---|---|---|---|---|---|
| A | 19 | 0.0% | 31.6% | 277 | 35.0% | 46.9% |
| B | 74 | 8.1% | 44.6% | 207 | 52.2% | 61.4% |
| C | 56 | 26.8% | 55.4% | 240 | 53.8% | 62.1% |
| D | 105 | 11.4% | 38.1% | 231 | 36.8% | 48.1% |
| all | 254 | 13.0% | 43.3% | 955 | 43.9% | 54.1% |

The direction is confirmed, bands lower: next-edit 0–27% vs 35–54% (hypothesis 10–37% vs
37–64%); with `edit≤3` it is 32–55% vs 47–62%. Raw bash is worst (1.4% next-edit, 18.6% next-read).

**Served-search context and conversion.**

| search evidence | value |
|---|---|
| served searches | 206 |
| 0 / 1 / 2 / 3–5 / 6+ anchor rows | 11 / 63 / 30 / 30 / 72 |
| ≤3 anchor rows | 115 (55.8%) |
| next tool is `read` | 77 (37.4%); 40/77 (52%) read the same file |
| 1-anchor searches: next-read / next-edit / edit≤3 | 57.1% / 25.4% / 74.6% |
| 6+ anchor searches: next-read / next-edit / edit≤3 | 23.6% / 15.3% / 40.3% |
| searches that served **both** BEGIN and END markers | 35 (17.0%) |
| after both-marker search: next-edit / next-read / edit≤3 | 0 / 12 / 16 |
| edits immediately after a search | 27; 26 used the search's own anchors; **0 used `text_ref`** |
| edits immediately after a read | 419; 23 used `text_ref`; error rate 2.4% (search: 1/27) |

Anchoring is **not** the blocker: a block copy needs only the two boundary anchors, because the
edit path explicitly accepts never-served interior lines. From `src/hashline/lease-resolve.ts`:

> “An unread (never-served) interior line strictly between the anchors is accepted (ADR-0024): it
> carries no identity to verify, and the boundary leases plus the window-length gate pin the span;
> a never-served BOUNDARY row keeps the fail-closed diagnosis (`[E_STALE_RANGE]`, spec §5.3).”

So a search that serves both markers is already sufficient to anchor a 1,000-line `text_ref` copy;
the model re-reads anyway (12/35), consistent with verifying the block's content/size rather than
an anchor failure. Searches are *targeting*, reads are *data loading*: 0/27 edits after a search used
`text_ref`, vs 23/419 after a read. The 37% re-read rate is a workflow/confidence cost, not a
lease-capability gap.

> “Every named file must resolve INTO the admitted set …, every row's bytes must equal the disk
> line at that number, and the total row count must fit `SEARCH_MAX_MATCHES` — all verified BEFORE
> the first lease, so a refusal grants nothing (invariant 2) and an over-cap search passes through
> raw instead of truncating (invariant 3).” (`src/lifecycle-hooks/index.ts`)
>
> “a served anchor is never resolved by content” … “a missing lease is an unknown or foreign
> anchor” (`src/hashline/lease-resolve.ts`); a lease is “generation-gated AT USE TIME”
> (`src/hash-store.ts`); “a repeated (file, line) coordinate renders and leases ONCE”
> (`src/lifecycle-hooks/index.ts`).

**Would context-line or block expansion raise conversion?** Context lines would reduce the
verification re-read for small blocks (10–100 lines) and could raise immediate conversion modestly;
they cannot unlock anything for 1,000-line blocks, because two marker anchors already suffice.
"Block expansion" (serve the range between matched BEGIN/END) is task-specific semantic inference,
not a safe generic predicate; the faithful equivalent — a view of the range — is already admitted
(`sed -n 'a,bp'`) and is the step that actually loads the block. Measure *rounds to first
successful edit* and `text_ref` usage, not next-call edit rate: a search→read→edit round is not a
failed interception if the read is loading the copy source.

## Reproducibility

Shape/reason/conversion tables: throwaway scripts under `/tmp/bie-analysis` (event join, quote-aware segmentation, local classifier bundle, counterfactual re-classification).
No source, benchmark run, network, install, or commit was touched.
