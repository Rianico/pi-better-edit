# ADR-0033 — AST-guarded bash view interception for Issue #28

Date: 2026-10-06

## Status

accepted — council consensus (`feat/28-bash-view-anchors`), operator grill Q1–Q4,
ast-research corpus review R1–R5 (verdict: sound, cleared with four guards, all
four recorded below as D5). Implements the read-side half of Issue #28; the
mutation half (`sed -i` and friends) is Issue #53 and explicitly out of scope.

Amended 2026-10-09 (commit `7b78278`, P3.1 of the search-and-read evolution
spec, `docs/spec/search-and-read-evolution.md`): D1 is amended to admit
`;`-separated silent-prefix chains, D9 is amended to normalize CRLF/BOM
symmetrically instead of failing closed, and D7 pins newline-separated
multi-statement scripts as pass-through pending P3.2 corpus telemetry.

Amended 2026-10-10 (Issue #82, commit `60d56a1`): admitted grep/rg flag shapes
expanded for Tier 1 to include boundary matching (`-w`, `-x`), match limit
(`-m N` separate arg, `--max-count=N` attached long form), color suppression
(`--color=never`, `--colour=never`), bundled short flags (`-nw`, `-nm 3`), and
flags placed at any position before `--`.

Amended 2026-10-13 (bash view config option): interception is now operator-gated.
The `bash.view` key of the shared config file defaults to `on` and resolves per key
through env `PI_BETTER_EDIT_BASH_VIEW` over project file over global file over the
default, with rung-source reporting beside the other settings. Effective `off`
passes both the view and the search branches through byte-identical at the hook
entry; effective `on` keeps every D-gate above unchanged. The switch is writable via
`/pi-better-edit bash-view [on|off|status] [project|global]` (alias `bash`), with a
five-option picker on headed hosts and the combined status text on headless ones.
The first successful interception of each session warns once — naming the round trip
saved and the off-ramp — tracked per session key and re-armed by `session_start`;
later interceptions stay silent.

Amended 2026-10-14 (Issue #82 Tier 3, commits `1507182`, `48dd802`, item 11):
D10 admits the Tier-3 interception surface — `grep`/`rg` as downstream content
filters, an unnumbered search source translated into a `keep` filter (so no
command is ever rewritten for a pipeline), multi-file `[PATTERN, FILE...]` and
`grep -r`/`rg` directory searches served from `FILE:LINE:content` triples under
retained per-file leases, the anchorless existence-checked `rg --files` list, and
the `sort -u` / `uniq` / `wc -l` line-set consumers. D7's search-output and
multi-file non-goals are superseded for the search class by D10; the numbered
view shapes (`cat -n` / `nl -ba`) and a numbered search source still compose with
nothing downstream.

## Context

Issue #28 (adoption gap): in the explicit-edit benchmark (904 trials, 5,102 bash
calls) 19% of trials never invoked `read`, viewing files through `cat`/`head`/
`sed`/`grep` instead (~1.5 file-viewing bash calls per task). Bash output is
unanchored, so the following `edit` fails `E_UNKNOWN_ANCHOR` and wastes a
re-read round trip. Issue #28's recorded non-goal stands unchanged: anchors only
from canonical disk bytes — this record never anchors bash stdout.

Corpus evidence (ast-research, 5,102 calls; all figures re-derivable from the
benchmark corpus, not this repo):
- Bare single-file views: 52 (1.02%). `cd <literal> && <view>`: 62 (1.22%) —
  bare-only would forfeit over half of all valid views, so `cd`-awareness is
  mandatory, not an extension.
- `cd`-prefixed chains overall: 1,137 (22.28%), of which 62 mix views with
  search or output builtins — these must fail closed (see D1 purity rule).
- Pure single-pipe `cat file | head/tail`: 17 (0.33%); other view pipelines
  (`xxd`, `od`, `cat -A`): 288 (5.64%) — transform stages are never views.
- Compound ceiling: 814 calls (15.95%) batch diagnostics with `;`/newline.
- Flag forms: `head -N` bare shorthand 679 (71.6%, mandatory); `head -n` 254;
  `head -c` 42 (must fail closed); `tail -c` 204 (33.3%, EOF inspection);
  `tail -N` 210; `tail -n` 71; `tail -n +N` 3; `sed -n` range/single prints 250+.
- `cat -A` 606 occurrences (control-character inspection — replacing its output
  would hide intent and emit anchors that fail to match disk).
- Silent-prefix census in `&&` chains: `cd` 212 (>99% of genuinely silent
  prefixes); the stdout-emitting print builtin holds 202 (never silent); `true`/`:`/`export`/
  `set -e`/`mkdir`/`touch` 0.

Prior art in this repo: `handleWrite` appends an auto-read; `handleEdit`
replaces `event.content` wholesale (the replacement precedent). The pi runtime
assigns a returned `content` over the tool output (`emitToolResult`,
`@earendil-works/pi-coding-agent`), and `tool_call` can only block (error) or
mutate same-tool input — so post-execution replacement is the only
zero-bloat interception point. `ToolResultEventBase` carries no origin field:
interception is uniform across model and human bash by construction, not choice.
`fmtReadPreview` already serves `offset`/`limit`/`windows` (`ReadWindow` is
1-indexed: `src/file-content/preview.ts` maps `window.offset - 1` to the
0-indexed start; `MAX_READ_WINDOWS = 16`, `src/constants.ts:28`), so
slice-accurate serve needs no new serve infrastructure.

## Decision

1. **Span kinds + `&&` purity rule.** Every top-level segment is `silent` |
   `view` | `unsafe`; undetermined is `unsafe`. `silent` = provably zero stdout
   on success and no effect on the viewed file; v1 set is exactly `cd
   <literal-path>`, `true`, `:` (R3: nothing else earned membership).
   Replacement applies iff the top level is `&&`-only, contains exactly one
   `view` segment, and all others are `silent` — then whole-output ≡ view-output
   is provable. Any `unsafe` (including `;`, `||`, `|&`, backgrounding,
   subshells, assignments, redirections, heredocs, substitutions, expansions,
   globs) fails closed to pass-through. Per-segment byte-splicing is rejected as
   unsound (shared stdout is unattributable). A single `cd` placed before the view
   re-bases relative resolution (fallback `ctx.cwd` when no `cd` is present): bash
   applies that `cd` to the session directory and then resolves the view target
   against the result, which is exactly what the hook replays. Anything else fails
   closed — a `cd` after the view ran too late to affect it (`cat f && cd sub`
   viewed `./f`, not `sub/f`), and chained `cd`s compose (`cd a && cd b` lands in
   `a/b`, not `b`), so applying one of them out of order would lease a path never
   viewed (`post-view-cd` / `multi-cd` pass-through reasons).

   **D1 amended 2026-10-09 (`7b78278`).** A `;`-separated statement chain is
   admitted under the same rule. `unbash` reports `;` and a newline as the same
   statement boundary, so the separator *text* decides: every boundary between
   adjacent statements must be an unconditional `;` (`isSemicolonStatementChain`
   requires the separator span between adjacent statements to match a
   whitespace-wrapped semicolon). Every statement before the terminal one must
   itself be a silent prefix (a view in a prefix statement fails closed), so the
   view is the last statement and the sequencing before it is deterministic. A
   pre-view literal `cd <dir>;` re-bases relative resolution exactly as the `&&`
   form does. Because the gate is position-sensitive, `pwd` with no arguments
   joins the silent set in prefix position only; D9 still byte-checks stdout,
   whose directory line therefore never matches the slice.
2. **Slice-view algebra.** One literal source file; stages are `cat` source or
   file-direct `head`/`tail`/`sed -n`, followed by pure line-window filters
   (`head -n`/`tail -n` incl. bare `-N` and GNU `+N`/`-N` line forms;
   `sed -n` numeric print `^\d+(,\d+)?p$`, stream-relative in pipes).
   Composition is interval arithmetic over `[1..L]` (L from the disk re-read),
   pipeline depth ≤ 4, `&&` segments ≤ 8. Byte mode (`-c`), `grep`/`awk`/
   `sort`/`uniq`/`cut`/`tr`/`tac`/`nl`, `sed` any other program, multi-source,
   and anything unparseable are not views.
3. **Strictly slice-accurate or pass-through (grill Q1).** An undetermined slice
   returns the original bash output — never full-file fallback, never append.
   Empty slice (`head -n 0`, out-of-range) serves nothing: pass-through.
4. **Interception mechanics.** `bash` `tool_result` only: exit 0, no
   `details.truncation`, existing text/binary/size gates, `valAccess` parity;
   then canonical `readNormFile` re-read → `fmtReadPreview` with the computed
   intervals as `windows` → plain-mode `recordDiffServes` (no
   `resultLineCount`/`firstChangedLine`: truncated mode belongs to diffs and
   would corrupt the mirror) with `contentHash = snapshotHashFor(normalized)`
   under `sessionKeyFor(ctx)` → `notifyServedSpans` `source: "auto-read"` with
   spans from `servedRowsToSpans(preview.served)` → FULL `content` replacement
   headed `--- Bash view (hashline anchors) ---`. No `notifyMutatedFile`
   (a read grants no authorship), no `tool_call` handler. `readNormFile`
   materializes the snapshot (`retireLeases: true`); the grant then leases
   exactly the served rows — unserved lines stay unleased (least privilege by
   construction, verified against `grantLeasesInTransaction`'s per-row lookup).
5. **The four adversarial guards (R4, mandatory).** `cat` takes zero flags
   (any leading-`-` operand, `-u` included, fails closed — as do `-A`/`-n`/`-v`/etc.).
   (prints `$OLDPWD`, breaks purity). `head`/`tail` accept bare `-N` and `-n N`
   (line mode only); `-f`/`-F`/`-c`/`-z` fail closed. `sed -n` script must
   match `^\d+(,\d+)?p$` exactly (locks out `w`/`e`/`r`/`s`/`;`/`{}`/`/`).
   Unquoted glob metachars (`*?[`), leading unquoted `~`, and non-fully-quoted
   words fail closed (unbash exposes globs/tilde as plain `Word`: `parse("cat
   *.txt")` yields `suffix: [{type: "Word", value: "*.txt"}]` with no parts).
6. **Frozen strings** (pinned by literal per house rule): the replacement
   header `--- Bash view (hashline anchors) ---`; the classifier's
   `passThrough` reasons are internal codes, never model-rendered.
7. **Non-goals confirmed:** multi-file views (atomic lease invariant
   `(SessionKey, Path) -> SnapshotHash`; parallel calls subsume batching);
   search output (match metadata, not content); Issue #53 mutations;
   `||` chains; and newline-separated multi-statement scripts — D7 as amended
   2026-10-09 (`7b78278`) — which `unbash` reports with the same parse shape as
   `;`. Bare `;` chains are no longer a flat non-goal: they are admitted only
   under D1's silent-prefix-and-terminal-view rule. The newline form stays
   pass-through pending P3.2 corpus telemetry.
8. **Transparent wrapper (amendment 2026-10-07).** A leading `rtk` around a view
   command (`rtk cat f`, `rtk head -n 3 f`, …) unwraps to the inner view shape in
   source positions (bare, `&&` segments, pipeline stage zero) and around pipe
   filters (`... | rtk tail -n 4` — the field prefixes every stage). Single unwrap
   only, view commands only, never around silent commands; anything else stays
   `unsafe`.
   `rtk` provably proxies the view class byte-identically today, but reputation is not the
   safety story: D9 re-checks every replacement, so a future filtering `rtk`
   subcommand fails closed. Production evidence: the field model issues
   `rtk`-prefixed views in the majority of turns; without this rule the feature
   is silent for exactly the population it was built for.
9. **Stdout verification (amendment 2026-10-07).** Before serving, the observed
   stdout (exactly one text block) must byte-match the re-read slice —
   `joined` or `joined + "\n"`, trailing-newline leniency only. This converts
   wrapper transparency from an assumption into a check: filtering/numbering
   wrappers, TOCTOU drift between exec and re-read, and skew the re-read does
   not normalize (undecodable bytes, a reordered row, an edited line) all still
   fail closed to pass-through. It also backstops
   the truncation guard on runtimes that report truncation elsewhere.

   **D9 amended 2026-10-09 (`7b78278`).** Line-ending and BOM skew is
   normalized instead of rejected: the observed stdout is compared as
   `toLF(stripBOM(stdoutText).text)` against `joinedSlice`, symmetric with the
   normalized LF/no-BOM text the anchors describe — comparing raw stdout bytes
   would drop anchors on exactly the CRLF and BOM files the model views through
   bash.

10. **Tier-3 search surface (amendment 2026-10-14, Issue #82).** The search
    class is a tagged family — single-file, multi-file, recursive and `rg --files`
    — each with its own stdout geometry and serve seam:
    - **Content filters.** Downstream `grep PATTERN` (keep), `grep -v PATTERN`
      (drop) and `rg -N PATTERN` (keep) are admitted in exact shapes only. A
      file-led pipeline folds them left over `(true line, text)` pairs and serves
      the survivors row by row (the same `fmtServedRows` renderer and
      `SEARCH_MAX_MATCHES` bound the search seam uses), gated by a whole-stdout
      byte comparison against the disk-derived fold. Literal-substring matching is
      deliberate: a regex pattern, or `-i`/`-w`/`-x`/`-E`/`-F` whose fold diverges
      from what bash printed, fails that gate and passes through raw.
    - **Unnumbered search source.** `grep PAT f | head -5` translates the source
      into one `keep` filter, so the model's command is never rewritten; a
      NUMBERED source (`grep -n PAT f | head -5`) composes with nothing downstream
      (the `cat -n`/`nl -ba` rule) because its injected `LINE:` column is data a
      downstream stage would inspect. `withSearchLineNumbers` keeps splicing bare
      single/multi/recursive searches only, never a pipeline.
    - **Multi-file.** `[PATTERN, FILE...]` (2..`BASH_SEARCH_MAX_FILES`) is served
      from `FILE:LINE:content` triples: every named file must resolve into the
      operand set, every row's bytes must equal the disk line, and all of it is
      verified before the first lease. Per-file leases ride the existing
      `(session, file_path, anchor)` key — no new identity scheme. A repeated
      `(file, line)` coordinate renders and leases once (the coordinate set is a
      set). `SEARCH_MAX_MATCHES` is the TOTAL matched-line budget across files.
    - **Recursive.** `grep -r|-R|--recursive|--dereference-recursive PATTERN DIR`
      walks one explicit root; `rg PATTERN DIR` (rg recurses by default) is the
      single-file shape whose directory operand the lifecycle upgrades to the same
      walk, while a `grep` directory operand stays raw. The walk is bounded by
      `BASH_SEARCH_WALK_MAX_FILES` (files visited AND directories queued);
      descent never enters a hidden directory (this covers `.git`) or
      `node_modules`, and no symlink is ever followed INSIDE the walk (a
      `Dirent` that is a symlink is never a member); the operand itself is
      resolved by the shared target resolver — the path authority every other
      seam uses — so a symlinked operand is walked as its target. The exclusions gate DESCENT only: an explicitly named
      excluded root is honored.
    - **`rg --files [DIR]`.** An anchorless, existence-checked path list rendered
      under `--- Bash file list (no anchors) ---`, bounded by the same
      distinct-file constant and leasing NOTHING. It is deliberately not routed
      through `valAccess`/`loadFileKindAndText`: no bytes are read, so there is
      nothing to witness and nothing to anchor — and because it leases nothing,
      the anchor-budget rationale behind that constant does not apply, so a
      repository-wide listing usually passes through raw.
    - **Line-set consumers.** `sort -u` (dedupe by text, first occurrence's line
      travels, rows ordered by raw bytes — the C/POSIX collation `sort` uses under
      `LC_ALL=C`; a host whose locale collation reorders the set folds differently,
      fails the byte gate and passes through raw), `uniq` (adjacent-only, run-head
      anchors) and `wc -l` (terminal: the observed count must equal the folded
      survivor count and ALL counted rows are leased in file order, so the number
      is checkable by editing a row). These break the monotone-subsequence property
      on purpose: coordinates stay file-true, but render order is not disk order.
      The header names the order (`sorted`, `adjacent-dedup`, `count: N`). Bare
      `sort`, `sort -o`, `sed -i`, `head/tail -c`, `tee` and `tac` stay raw.
    - **Bounds and refusals.** Beyond any bound (file count, line count, walk
      files or walk directories) the WHOLE output passes through raw — never a
      truncated render; a mismatched or unwitnessed row fails the whole serve with
      zero leases. Accepted boundary: multi-range `sed -n -e A -e B` is COMPOSED,
      not unioned, by the interval algebra, so it selects nothing and passes
      through raw.

## Consequences

- New pure module `src/bash-classifier.ts` (span kinds, interval algebra, all
  D2/D5 rules); `unbash@5.0.0` becomes a runtime dependency (pinned exact) and
  joins `EXTERNALS` in `scripts/build-dist.mjs` (runtime deps stay unbundled
  per that file's contract); `lifecycle-hooks` reaches the classifier only through a
  dynamic `import()` inside the bash handler so the source entry pays no parser cost
  up front. Load-shape record: esbuild bundles the relative specifier into the entry
  and hoists the external `unbash` import to a top-level static import in the shipped
  artifact — so the artifact is NOT lazy, only the source entry is (verified in a
  fresh `build-dist` output). Measured cost is negligible (`unbash` 52 KB parser, no
  transitive deps, cold import ~0.01–0.03 ms, one parse ~0.09 ms), and a resolve/eval
  failure of the lazily imported classifier still fails closed to pass-through. In the
  shipped artifact the hoisted top-level `unbash` import is instead fatal at entry
  (same class as the other entry imports), bounded by `verify-dist`'s specifier check
  (`measure-import --max-ratio 0.75` still guards the source entry).
- `LifecycleDeps.fmtReadPreview` opts widen from `Record<string, never>` to the
  real `{ offset?; limit?; windows?: Array<{ offset: number; limit: number }> }`
  (1-indexed, mirroring `ReadWindow`).
- Witnesses: `test/tools/bash-classifier.test.ts` (span matrix, algebra cases,
  all four R4 guards, corpus spot shapes, `post-view-cd`/`multi-cd` rejections) +
  `test/tools/bash-view-lifecycle.test.ts`
  (replace-on-pure-view incl. `cd` chain and `cat|head|tail`; pass-through on
  `cat -A`, `cd -`, `grep`, `sed -i`, multi-file, truncation, error; preview-budget
  truncation and `cd`-order witnesses) + `test/tools/bash-rtk-wrapper.test.ts`
  (single-unwrap discipline: view commands only, never around silent commands).
- Glossary: `pure view`, `slice view`, `pass-through (bash view)`, `silent
  segment`, `span kind`, `view replacement`, `interval algebra` (CONTEXT.md).
- CHANGELOG `[Unreleased]` entry on merge.
