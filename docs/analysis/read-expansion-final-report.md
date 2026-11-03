# Read expansion: does it help?

Final report, 2026-11-02. Contract: ADR [0008](../adr/0008-read-expansion-requested-window-and-bounds.md), reversed by [0012](../adr/0012-serve-a-selection-range-note-instead-of-widening-the-read.md) on this evidence. Raw evidence: [read-expansion-benchmark-evidence.md](read-expansion-benchmark-evidence.md).

## Verdict

**Read expansion does not measurably help code development.** It is also not harmful at its shipped settings.

Five task suites and roughly 1,500 trials were run. No configuration produced a score improvement outside run-to-run noise. No configuration reduced the number of times an agent reads a file it has already read.

The mechanism explains why. In 76 observed widenings, the agent returned to that file in only 18. Of the 21 follow-up reads, 10 asked again for the range that had just been served. One widening in 76 was used at all.

Real sessions put a ceiling on the feature. I took 15,190 windowed probes from transcripts that predate it. In 39 % the agent never read that file again. In 33 % it read a different region, a median of 156 lines away. Only 12.6 % wanted more around the probe.

The sharpest single result is a bracketed pair on the suite built to exercise the feature. Two runs of the off arm scored 16 of 16 with zero timeouts. Two runs of a clamp configuration that widened 17 and 20 times scored 16 of 16 with zero timeouts. Tokens and wall time overlap. Twenty widenings per leg produced no measurable difference.

## What was measured

Five suites, one model (`opencode-go/muse-spark-1.3-contributor`), thinking low, Pi 1.4.0, one privileged Linux container per leg.

| suite | tasks | why it was chosen | windowed reads |
|---|---|---|---|
| `explicit-edit` | 226 | internal pair, 2.14.0 against 2.16.0 | not measured |
| EDIT-Bench | 72 | public, real edit requests, unit-test scored | 7–16 % |
| Aider polyglot | 118 | public, published cost baseline | 0.5–3 % |
| `micro-swe` | 16 | built to force windowed reads | **82 %** |
| `micro-swe` cap sweep | 16 × 7 | isolates the cap | 82 % |

The axes varied. Extension version, and the toggle on against off. Trigger at 12, 18, 24, 48, 96, 1000 and a block-proportional rule. Cap at 80, 160, 400, unlimited and file-proportional. Clamp against refuse.

## The mechanism

Expansion acts only when a read names a window (offset and limit) that is small relative to the enclosing block. Three gates must all pass: the trigger, the superset invariant, and the cap.

Measured behaviour of each gate:

- **Windowed reads are rare on public suites.** EDIT-Bench issues 14–33 windowed reads against 175–185 whole-file reads per leg. Aider issues 1–7 against 181–213. A whole-file read never enters the expansion path.
- **The trigger is not the limit.** Raising it from 24 to 1000 moved EDIT-Bench widening events from 0–3 to 6. Lowering it to 18 or 12 stopped the feature firing at all, because fewer requests qualify.
- **The cap is the limit, and it works as designed.**

  At trigger 1000 on `micro-swe`, 39 of 43 windowed reads sat inside a block above 80 lines and were refused. Raising the cap raised widenings from 3 to 11 to 14. The volume served rose from 51 to 1,658 to 9,314 extra lines.
- **Where it fires, the gain is small.** The six widenings observed across the public sweeps added a mean of 12.7 lines. One served exactly what was requested. The agent already sizes its window to the block.

## The result

No score improvement anywhere. Paired comparisons, per task:

| comparison | tasks | delta |
|---|---|---|
| `explicit-edit` 2.14.0 against 2.16.0 | 226 | both 226/226, tokens within ±1 % per first attempt |
| EDIT-Bench on against off | 72 | 53, 57, 56 against 47, **58, 58** |
| Aider on against off | 118 | 71, **93**, 75 against 71 |
| `micro-swe` off against clamp, bracketed | 16 | **16/16 and 16/16** against **16/16 and 16/16** |
| `micro-swe` off against cap 400 | 16 | 12/16 against 7/16, with 9 timeouts |

The off arm reached 58 of 72 on EDIT-Bench, above every expansion leg. Aider moved 71 to 93 on identical settings. On `micro-swe`, the off arm scored 16 of 16 twice once the provider was healthy.

**Repeated identical configurations move the score more than the feature does.** That is the controlling fact of this study.

## Cost

At shipped settings the cost is negligible: 0–3 widenings per leg and tens of extra lines.

At aggressive settings the cost is real and unbounded in practice. The unlimited cap served a median of 1,122 lines per widening, with a maximum of 1,317 lines for a single probe. That is half a 2,698-line file in answer to a 20-line request, a 50-fold dilation. The extra lines reached 9,314 per 16-task leg, and 13 of 16 trials then exceeded a 300 s budget.

## Why it does not help

Three reasons, each measured:

1. **The agent already reads the block.** When it probes 15 lines inside a 20-line function, the enclosing block is the window. Expansion adds a median of a few lines.
2. **Where the agent under-shoots, the block is large and the cap refuses it.** On `micro-swe`, 87 % of windowed reads died at the cap.
3. **Serving more does not remove a second read.**

   Across the clamp legs there were 76 widening events. In 58 of them (76 %) the trial never read that file again. Those widenings added lines for no possible saving.

   The other 18 events produced 21 follow-up read ranges. Ten of the 21 re-read the range that had just been served. Expansion had added lines above and below it, and the agent asked for the same lines again anyway. One concrete case: the request was 1455–1474, the serve was 1395–1474, and the later read was 1455–1474.

   Exactly one of the 76 events used a line that expansion had added. That is a hit rate of 1.3 %.

Point 3 is the decisive one. Expansion always serves more lines than were requested, so it cannot save anything in the read it fires on. Its only possible value is preventing a later read. In three events out of four the agent never comes back. When it does come back, it asks for the lines it already has.

## What real sessions show

The benchmark forced windowed reads. Real sessions do not. I measured the transcripts that predate the feature: 2,836 files, 33,694 read calls, 15,190 windowed probes across 1,168 sessions. No transcript contained expansion chrome, so every observation is un-widened.

For each probe, what did the next read of that same file do?

| the next read of the same file | share |
|---|---|
| **none** — never read that file again | **39.0 %** |
| **elsewhere** — a different region, median 156 lines away | **33.1 %** |
| **adjacent** — within 20 lines, not overlapping | 10.4 % |
| **extends** — reached past one side of the probe | 9.9 % |
| **contained** — re-read inside what the probe already served | 4.9 % |
| **superset** — covered the probe and more | 2.7 % |

Three facts follow.

**39 % of probes were already one-shot.** The agent never returned to that file. A wider serve had nothing to prevent.

**33 % returned for a different region**, a median of 156 lines away. Widening around the probe cannot serve a region that far away.

**12.6 % returned for more around the probe.** That is the whole addressable surface. Of those, the union of probe and follow-up fits inside an 80-line cap in 8.1 % of all probes. The median union is 55 lines.

The median follow-up asked for the same number of lines as the probe, shifted. The agent was not asking for more. It was asking for the same, moved.

## The range-hint alternative

Replacing the widened serve with a banner or trailer that names the enclosing block addresses the same 12.6 % ceiling. It costs bytes instead of lines, and it costs one call when the model acts on it. It is never worse in capability, because the model can still request the block.

Neither a widened serve nor a block-range hint reaches the dominant 33 % case, which wants a different region of the file. An outline — symbol names with their line ranges — would reach it. That is a different feature.

## Do agents use the tools that already exist?

The outline was deferred because pi-lens already offers analogous tools and agents rarely reach for them. That was an impression. A census puts numbers on it: 1,853 local session transcripts, 1.5 GiB, 106,086 tool results, and 1,253 sessions that used a tool at all.

| tool | calls | sessions | share of 1,253 tool-using sessions |
|---|---:|---:|---:|
| `bash` (baseline) | 70,563 | 1,029 | 82.1 % |
| `read` (baseline) | 17,532 | 996 | 79.5 % |
| `lens_diagnostics` | 256 | 155 | 12.4 % |
| `symbol_search` | 248 | 66 | 5.3 % |
| `module_report` | 94 | 38 | 3.0 % |
| `read_symbol` | 57 | 16 | 1.3 % |
| `read_enclosing` | 4 | 3 | 0.2 % |
| `ast_grep_outline` | **0** | **0** | **0 %** |
| `ast_grep_replace` | **0** | **0** | **0 %** |
| all pi-lens tools | 1,067 | 175 | **14.0 %** |

Three readings.

**The tools that already answer "what is in this file" are barely used.** Together, `read_symbol`, `module_report` and `read_enclosing` reach 5.5 % of tool-using sessions. `ast_grep_outline` is the closest existing analogue to the deferred outline, and it has **zero** calls in the sample. So does `ast_grep_replace`.

**Where they are used, they win.** `read_symbol` returns a median of 19 lines. A whole-file read of the same file returns 1,303, so the tool serves 2.6 % of it. Against a real `read` of the same path in the same session it returns 5.3 times fewer lines. `module_report` returns 4.6 % of the file and 12.7 times fewer lines. The efficiency is real. The adoption is not.

**One tool loses on cost.** `symbol_search` returns a median of 5,876 characters. A bash command in its own sessions returns 724, so the tool costs 8.1 times more. Its lines are long, at roughly 220 characters each. A sample-wide `rg -n` median is 1,001 characters.

So the deferral is not caution about a promising idea. The instruments exist, they are measurably cheaper than what agents do instead, and agents reach for them in one session in eighteen. An outline would be a fifth such tool, and the same question would apply to it.

**What this does not settle.** The census counts what agents chose, not what would have helped. A tool can be under-used because it is undiscoverable, because its name does not match the task, or because the agent never learned it exists. The `ast_grep_outline` zero is both the strongest signal and the weakest evidence. The tool was advertised, and the sample cannot say whether it was ever offered at the moment it would have paid.
## What would change the answer

- **A workload where a whole-file read is impossible.** Every suite here has files small enough to read whole. A repository with 5,000-line files would force windowed reads and make the trigger and the cap live variables rather than inert gates.
- **A model that under-shoots its window.** This model sizes its window to the block. A weaker or cheaper model may not, and would then benefit from a boundary it cannot find itself.
- **A different language.** Every widening here landed on Python, where functions are 15–30 lines. Go, Rust or Java functions are longer, which shifts the block-size distribution.
- **A cap that scales with the block rather than the file.** Untested. It would bound dilation while still serving the cases the 80-line cap refuses.

## Method

- Suites are re-anchored so the file stays on disk. A benchmark that pre-loads the file into the prompt cannot test a read tool at all.
- Scoring runs each repository's or dataset's own tests. A `micro-swe` task is one mechanical mutation inside a function that starts below line 200 of a file above 400 lines. Every task was proven to fail with the mutation and pass without it.
- Activation is counted from served chrome (`[widened <a>-<b> -> <c>-<d>]`) in the trial transcripts, never inferred from an environment variable.
- The re-read count walks each transcript in order. It pairs every `tool_execution_start` with its `tool_execution_end`, so the requested range and the served range of each read are both known. It then asks what the agent read afterwards. A bash command counts as a re-read only when a reader verb applies to that exact path. An earlier loose matcher reported 18 bash re-reads. All but two were `pytest` runs on a test file whose name ends with the same basename.
- The toggle and both experimental knobs are recorded in every leg's own run log.
- The adoption table walks the same session store separately: 1,853 transcripts, newest by modification time, under a 1.5 GiB budget, parsing 106,086 tool results. Tool-call pairing is exact id, then a `|` prefix, then a suffix. A sample of six files produced identical counts through two independent implementations.

## Threats to validity

- **Provider transport errors and latency drift dominate.** Latency moved by two to three times during the session. Identical configurations moved by up to 22 points on Aider. Any delta below roughly 5 % is unresolvable. Several legs were discarded for timeout contamination.
- **`micro-swe` holds 16 tasks.** It cannot resolve a difference below about two tasks.
- **The public suites are subsets.** EDIT-Bench ran 72 of 108 problems, and Aider ran 118 of 225.
- **One model, one effort setting.** Every result is `muse-spark-1.3-contributor` at thinking low.
- **Mutations are machine-generated.** They are easier than real issue-driven work.
- **The adoption census samples one operator's sessions.** It covers 1,853 of 2,712 transcripts, newest by modification time, across five and a half weeks.
- **A subagent rollout counts as its own session.** A rollout stored separately contributes its own row, so one task can appear several times.

## Recommendation

Do not claim a benefit. The feature is harmless and cheap at its shipped settings, so keeping it enabled is defensible on those grounds alone. Claiming that it improves code development is not supported by any measurement in this study.

If the question matters, the next step is a corpus with files large enough that whole-file reads are uneconomic. That is the only condition under which the feature's precondition holds and its value becomes testable.
