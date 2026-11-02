# Read expansion: does it help?

Final report, 2026-11-02. Contract: ADR [0008](../adr/0008-read-expansion-requested-window-and-bounds.md). Raw evidence: [read-expansion-benchmark-evidence.md](read-expansion-benchmark-evidence.md).

## Verdict

**Read expansion does not measurably help code development.** It is also not harmful at its shipped settings.

Five task suites and roughly 1,500 trials were run. No configuration produced a score improvement outside run-to-run noise. No configuration reduced the number of times an agent reads a file it has already read.

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

   The share of windowed reads that repeat an already-served range of the same file was 16 % with expansion off. With it on the share was 19–26 %. The feature served more, and the agent re-read anyway.

Point 3 is the decisive one. Expansion always serves more lines than were requested, so it cannot save anything in the read it fires on. Its only possible value is preventing a later read. That later read still happens.

## What would change the answer

- **A workload where a whole-file read is impossible.** Every suite here has files small enough to read whole. A repository with 5,000-line files would force windowed reads and make the trigger and the cap live variables rather than inert gates.
- **A model that under-shoots its window.** This model sizes its window to the block. A weaker or cheaper model may not, and would then benefit from a boundary it cannot find itself.
- **A different language.** Every widening here landed on Python, where functions are 15–30 lines. Go, Rust or Java functions are longer, which shifts the block-size distribution.
- **A cap that scales with the block rather than the file.** Untested. It would bound dilation while still serving the cases the 80-line cap refuses.

## Method

- Suites are re-anchored so the file stays on disk. A benchmark that pre-loads the file into the prompt cannot test a read tool at all.
- Scoring runs each repository's or dataset's own tests. A `micro-swe` task is one mechanical mutation inside a function that starts below line 200 of a file above 400 lines. Every task was proven to fail with the mutation and pass without it.
- Activation is counted from served chrome (`[widened <a>-<b> -> <c>-<d>]`) in the trial transcripts, never inferred from an environment variable.
- The toggle and both experimental knobs are recorded in every leg's own run log.

## Threats to validity

- **Provider transport errors and latency drift dominate.** Latency moved by two to three times during the session. Identical configurations moved by up to 22 points on Aider. Any delta below roughly 5 % is unresolvable. Several legs were discarded for timeout contamination.
- **`micro-swe` holds 16 tasks.** It cannot resolve a difference below about two tasks.
- **The public suites are subsets.** EDIT-Bench ran 72 of 108 problems, and Aider ran 118 of 225.
- **One model, one effort setting.** Every result is `muse-spark-1.3-contributor` at thinking low.
- **Mutations are machine-generated.** They are easier than real issue-driven work.

## Recommendation

Do not claim a benefit. The feature is harmless and cheap at its shipped settings, so keeping it enabled is defensible on those grounds alone. Claiming that it improves code development is not supported by any measurement in this study.

If the question matters, the next step is a corpus with files large enough that whole-file reads are uneconomic. That is the only condition under which the feature's precondition holds and its value becomes testable.
