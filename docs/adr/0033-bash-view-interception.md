# ADR-0033 — AST-guarded bash view interception for Issue #28

Date: 2026-10-06

## Status

accepted — council consensus (`feat/28-bash-view-anchors`), operator grill Q1–Q4,
ast-research corpus review R1–R5 (verdict: sound, cleared with four guards, all
four recorded below as D5). Implements the read-side half of Issue #28; the
mutation half (`sed -i` and friends) is Issue #53 and explicitly out of scope.

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
   unsound (shared stdout is unattributable). `cd` resolves the view target
   against the last literal `cd` (fallback `ctx.cwd`).
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
   (only `-u` tolerable; `-A`/`-n`/`-v`/etc. fail closed). `cd` rejects `-`
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
   `;`/`||` chains (the 814-call compound ceiling stays pass-through).
8. **Transparent wrapper (amendment 2026-10-07).** A leading `rtk` around a view
   command (`rtk cat f`, `rtk head -n 3 f`, …) unwraps to the inner view shape in
   source positions (bare, `&&` segments, pipeline stage zero) and around pipe
   filters (`... | rtk tail -n 4` — the field prefixes every stage). Single unwrap
   only, view commands only, never around silent commands; anything else stays
   `unsafe`.
   proxies the view class byte-identically today, but reputation is not the
   safety story: D9 re-checks every replacement, so a future filtering `rtk`
   subcommand fails closed. Production evidence: the field model issues
   `rtk`-prefixed views in the majority of turns; without this rule the feature
   is silent for exactly the population it was built for.
9. **Stdout verification (amendment 2026-10-07).** Before serving, the observed
   stdout (exactly one text block) must byte-match the re-read slice —
   `joined` or `joined + "\n"`, trailing-newline leniency only. This converts
   wrapper transparency from an assumption into a check: filtering/numbering
   wrappers, TOCTOU drift between exec and re-read, and encoding skew (CRLF,
   BOM, undecodable bytes) all fail closed to pass-through. It also backstops
   the truncation guard on runtimes that report truncation elsewhere.

## Consequences

- New pure module `src/bash-classifier.ts` (span kinds, interval algebra, all
  D2/D5 rules); `unbash@5.0.0` becomes a runtime dependency (pinned exact) and
  joins `EXTERNALS` in `scripts/build-dist.mjs` (runtime deps stay unbundled
  per that file's contract); `lifecycle-hooks` reaches it only through a
  dynamic `import()` inside the bash handler so entry import cost is unchanged
  (`measure-import --max-ratio 0.75`).
- `LifecycleDeps.fmtReadPreview` opts widen from `Record<string, never>` to the
  real `{ offset?; limit?; windows?: Array<{ offset: number; limit: number }> }`
  (1-indexed, mirroring `ReadWindow`).
- Witnesses: `test/tools/bash-classifier.test.ts` (span matrix, algebra cases,
  all four R4 guards, corpus spot shapes) + `test/tools/bash-view-lifecycle.test.ts`
  (replace-on-pure-view incl. `cd` chain and `cat|head|tail`; pass-through on
  `cat -A`, `cd -`, `grep`, `sed -i`, multi-file, truncation, error).
- Glossary: `pure view`, `slice view`, `pass-through (bash view)`, `silent
  segment`, `span kind`, `view replacement`, `interval algebra` (CONTEXT.md).
- CHANGELOG `[Unreleased]` entry on merge.
