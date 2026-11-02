# Read expansion: benchmark evidence

Status: evidence record, 2026-11-01; corrected 2026-11-02. This is not a decision record. [ADR-0008](../adr/0008-read-expansion-requested-window-and-bounds.md) held the contract, and [ADR-0009](../adr/0009-serve-a-selection-range-note-instead-of-widening-the-read.md) reverses it on the evidence below.

> [!WARNING] Correction (2026-11-02)
> An earlier version of this record named `PI_BETTER_EDIT_READ_EXPANSION_TRIGGER`, `PI_BETTER_EDIT_READ_EXPANSION_CAP` and `PI_BETTER_EDIT_READ_EXPANSION_CAP_RATIO` as configuration the extension shipped. They never shipped: the trigger and cap knobs existed only as uncommitted changes in an experiment worktree. Released 2.16.0 keeps the fixed 24-line trigger and the fixed per-source caps (80 code, 80 Markdown, 40 plain text). Every table and measured number below stands; the two sentences that implied a released surface are corrected in place, and this note keeps the edit visible.

## Question

Does read expansion cost or save anything measurable, at a fixed model, a fixed Pi runtime and a fixed task set? Can that difference be separated from retry noise?

## Internal pair: 2.14.0 against 2.16.0

Three legs of `explicit-edit-benchmark` (226 tasks, one attempt each) in one sandbox on one host.

| | A | B | C |
|---|---|---|---|
| extension | pi-better-edit **2.14.0** | pi-better-edit **2.16.0** | **2.16.0**, `PI_BETTER_EDIT_READ_EXPANSION=off` |
| Pi runtime | 1.4.0 | 1.4.0 | 1.4.0 |
| model | `opencode-go/muse-spark-1.3-contributor` | same | same |
| thinking | low | low | low |
| concurrency / attempts / timeout | 10 / 1 / 120 s | same | same |
| sandbox | `podman --privileged`, `localhost/eeb-runner:hf`. The host is macOS, where `bwrap` is unavailable, and unprivileged containers fail 0/226 on proc-mount denial | same | same |

Equivalence evidence: identical task-id sets, identical per-task `fixtureSha256`, identical `verifierSha256`. Only `configSha256` differs, as it must.

Provenance is manifest-read in every leg (`results/explicit-edit-pi140-*/manifest.json`), not inferred from the arm file. Each leg records `agentVersion 1.4.0`, `attempts 1`, `concurrency 10` and `timeoutMs 120000`.

### Activation proof

Expansion fired only where intended. Served chrome lines (`[widened <a>-<b> -> <c>-<d>`) were counted across each leg's `trials/**/agent/stdout.jsonl`:

| leg | served widening notes |
|---|---|
| A (2.14.0) | **0** |
| B (2.16.0) | **35** |
| C (2.16.0, toggle off) | **0** |

Example from B: `[widened 65-84 -> 5-84, section …` in a Markdown task. The trigger fired on 7 Markdown task files and nowhere else. That matches a 24-line trigger against small edit-centric fixtures.

### Results, raw

Sums come from `normalized/rounds.jsonl`, one row per attempt.

| metric | A (2.14.0) | B (2.16.0) | C (off) |
|---|---|---|---|
| passed | 226/226 | 226/226 | 226/226 |
| first-attempt passed | 191 | 191 | 208 |
| attempts | 273 | 268 | 249 |
| total tokens | 12,231,226 | 11,900,666 | 10,210,590 |
| cost (USD) | 0.2546 | 0.2578 | 0.2217 |
| tool calls | 1122 | 1064 | 959 |
| model rounds | 1391 | 1333 | 1201 |
| mean / median / p95 seconds | 20.265 / 12.882 / 58.070 | 18.430 / 13.137 / 47.189 | 16.758 / 12.358 / 35.647 |
| connection-error events | 47 | 45 | 17 |

### The measurement that matters: normalise the retries

Totals and per-attempt averages are dominated by retry volume. The retries here are provider transport failures, not extension behaviour. Recompute per **first attempt** and per **passing first attempt**:

| metric | A | B | C |
|---|---|---|---|
| tokens per first attempt | 37,824 | **37,883 (+0.2 %)** | **37,696 (−0.3 %)** |
| tokens per passing first attempt | 36,782 | **36,420 (−1.0 %)** | **37,163 (+1.0 %)** |

All three legs cost the same within ±1 %. Two raw headlines mislead. "2.16.0 uses 2.7 % fewer total tokens" and "expansion off is 7.7 % cheaper per attempt" are both artifacts. Leg C hit 17 connection errors against A's 47 and B's 45. Fewer errors meant 249 attempts instead of 268–273. Every attempt carries tokens into the total.

### What this pair supports

1. **2.14.0 → 2.16.0 is cost-neutral and score-neutral on this benchmark.** First-attempt token cost moved +0.2 %, and passing-first-attempt cost moved −1.0 %. Both legs scored 226/226.
2. **Read expansion is not measurably expensive here.** The normalised cost of B equals A and C.
3. Three deltas sit below the noise floor and are suggestive only. B shows −5.2 % tool calls, −4.2 % model rounds and −9.1 % mean wall time against A.

### What this pair does not support

1. **Any claim that read expansion saves anything.** The fixtures are small and edit-centric. A probe already lands near the edit site, so the trigger fired on only 7 files of 226 tasks. The metric the feature targets is a `read` followed by a second `read` of the same file. This benchmark does not count that.
2. **Any accuracy claim.** The baseline saturates at 226/226, so no score movement is available in either direction.
3. **A per-category story.** Token swings exceed ±25 % in eight categories with zero pass change. That is noise, not signal.

## External pair: expansion on against off

Two public edit benchmarks ran as a 2×2. Each suite is scored by its own tests, and the toggle is the only variable. Settings: Pi 1.4.0, `opencode-go/muse-spark-1.3-contributor`, thinking low, one attempt, concurrency 10, one Linux container, sandboxed agent.

| metric | EDIT-Bench ON | EDIT-Bench OFF | Aider ON | Aider OFF |
|---|---|---|---|---|
| tasks | 72 | 72 | 118 | 118 |
| passed, first run | 53 (73.6 %) | 47 (65.3 %) | 71 (60.2 %) | 71 (60.2 %) |
| passed, all repeats | 53, 57, 56 | **47, 58, 58** | 71, 93, 75 | 71 |
| total tokens | 9,081,022 | 7,829,811 (−13.8 %) | 5,384,416 | 5,736,827 (+6.5 %) |
| tokens per solved task | 171,340 | 166,591 | 75,836 | 80,800 |
| tool calls / model rounds | 670 / 665 | 642 / 625 | 637 / 613 | 662 / 646 |
| mean seconds | 52.9 | 67.8 | 75.4 | 69.1 |
| **widening events** | **10, in 2 of 72 trials** | **0** | **0** | **0** |

Pairs are matched by task id, first run. EDIT-Bench shows 14 flips: 10 tasks pass only with expansion, and 4 pass only without. McNemar exact two-sided **p = 0.180**. Aider shows 12 flips, 6 in each direction. The off repeats below remove this gap, because two later off runs scored 58 of 72, above every expansion leg.

### The mechanism did not fire, so the pass delta is not its effect

Expansion widened a read in **2 of 72** EDIT-Bench trials and **0 of 118** Aider trials. Two widening events cannot turn ten tasks from fail to pass. That difference therefore belongs to provider variance, not to this feature.

Aider is a null control by construction. Its solution files are 6–18 lines and the starting stub is the same size. A read never exceeds the 24-line trigger, so nothing can widen.

Token totals overlap once the off arm is repeated: 8.9–9.2 M with expansion against 7.8–9.6 M without. No cost claim survives either.

### Why the trigger rarely fires

The trigger is 24 lines. A model that reads a whole 80-line file requests a window above the trigger, so the feature never engages. Expansion engages only when a model probes a *small slice* of a larger block. These benchmarks rarely provoke that behaviour.

### Trigger sweep: 12, 18, 24, 48, 1000 and a block-proportional rule

The trigger bounds the requested window. Lowering it makes expansion fire *less* often, not more, because fewer requests qualify as candidates. Each run varied it through an experiment-only build's `PI_BETTER_EDIT_READ_EXPANSION_TRIGGER`, an uncommitted scratch change that never shipped; released 2.16.0 keeps the fixed 24-line trigger. One build also added a dynamic mode, where a probe must cover at most `1/1.618` of its enclosing block.

EDIT-Bench, 72 tasks per leg:

| trigger | leg | passed | tokens | widening events | read calls with a window | whole-file reads |
|---|---|---|---|---|---|---|
| 24 | `eb-on` | 53/72 (73.6 %) | 9,081,022 | 2 | 27 | 175 |
| 24 | `eb-trig24b` | 57/72 (79.2 %) | 9,025,111 | 3 | 28 | 185 |
| 24 | `eb-trig24c` | 56/72 (77.8 %) | 8,910,793 | 0 | 20 | 178 |
| 48 | `eb-trig48` | 55/72 (76.4 %) | 9,170,820 | 3 | 33 | 184 |
| 1000 | `eb-trig1000` | 57/72 (79.2 %) | 9,187,718 | **6** | 27 | 175 |
| dynamic | `eb-dynamic` | 57/72 (79.2 %) | 9,109,347 | 2 | 19 | 183 |
| off | `eb-off` | 47/72 (65.3 %) | 7,829,811 | 0 | 14 | 182 |
| off | `eb-off2` | **58/72 (80.6 %)** | 9,602,399 | 0 | 30 | 182 |
| off | `eb-off3` | **58/72 (80.6 %)** | 8,703,963 | 0 | 16 | 184 |

Aider, 118 tasks per leg:

| trigger | leg | passed | tokens | widening events | read calls with a window | whole-file reads |
|---|---|---|---|---|---|---|
| 24 | `ab-aider-on` | 71/118 (60.2 %) | 5,384,416 | 0 | 3 | 199 |
| 24 | `aider-trig24b` | **93/118 (78.8 %)** | 6,561,320 | 0 | 7 | 208 |
| 24 | `aider-trig24c` | 75/118 (63.6 %) | 5,524,325 | 0 | 1 | 182 |
| 48 | `aider-trig48` | 80/118 (67.8 %) | 5,994,067 | 0 | 3 | 189 |
| 1000 | `aider-trig1000` | 83/118 (70.3 %) | 5,697,360 | 0 | 1 | 181 |
| dynamic | `aider-dynamic` | 72/118 (61.0 %) | 5,881,509 | 1 | 4 | 213 |
| off | `ab-aider-off2` | 71/118 (60.2 %) | 5,736,827 | 0 | 7 | 204 |

Three results follow.

**1. Repeating an identical configuration moves the score more than any trigger change.** Three runs at trigger 24 on EDIT-Bench scored 53, 57 and 56. Three off runs scored 47, 58 and 58. On Aider, three runs at trigger 24 scored 71, 93 and 75. The Aider spread of 22 points is larger than the gap between any two trigger settings measured here. The single off run that scored 47 is the outlier, and the two later off runs equal or beat every expansion leg. An earlier draft of this record reported an on/off gap of 53 against 47, and the off repeats refute it.

**2. Engagement rises with the trigger, and stays too rare to move a score.**

Widening events per EDIT-Bench leg: 0–3 at trigger 24, 3 at 48, 6 at 1000, 2 at dynamic, 0 when off. The 1000-line trigger admits every read in these fixtures. It still widened in only 6 of 72 trials.

**3. The binding constraint is that the model rarely asks for a window.** EDIT-Bench makes 14–33 windowed reads against 175–185 whole-file reads per leg. Aider makes 1–7 windowed reads against 181–213 whole-file reads. A whole-file read carries no offset or limit, so it never enters the expansion path. Expansion can only act on the small minority of reads that name a window, and on Aider that minority is near zero.

A dynamic trigger does not change this. Its proportional test is stricter than 24 for blocks under about 39 lines. It is looser above, but the 80-line code cap means that region rarely serves anything. `eb-dynamic` widened twice and `aider-dynamic` once.

One engagement at trigger 1000 was a no-op: `[widened 204-256 -> 204-256, function test_model_position_distribution]`, where the requested window was already the whole block.

## A suite that does exercise the mechanism: micro-swe

The two public suites never asked for a windowed read, so the trigger was never tested. A third suite removes that limitation: **micro-swe**.

It holds 16 real tasks across `rich` and `flask`. Each is a single mechanical mutation injected into a function that starts below line 200 in a file above 400 lines. The workspace is the full repository with `.git` removed, and scoring runs the repository's own tests. Flask's entire suite runs in 0.67 s, so verification is free.

The suite works as intended. **82 % of read calls request a window** (45 windowed against 10 whole-file), against 7–16 % on EDIT-Bench and 0.5–3 % on Aider.

| leg | trigger | passed | tokens | tokens per task | widening events | windowed reads |
|---|---|---|---|---|---|---|
| `ms-off` | off | 15/16 | 4,402,713 | 275,169 | 0 | 45 |
| `ms-trig24` | 24 | 15/16 | 4,496,369 | 281,023 | **0** | 31 |
| `ms-trig48` | 48 | 14/16 | 4,817,749 | 301,109 | **4** | 35 |
| `ms-trig96` | 96 | 13/16 | 4,230,313 | 264,394 | **0** | 37 |
| `ms-trig1000` | 1000 | 15/16 | 4,976,809 | 311,050 | **2** | 42 |

Paired against the off arm, per task: token deltas of +5,854, +25,940, −10,775 and +35,881, with 2, 3, 2 and 0 pass flips. Score and cost are flat within noise, on 16 tasks.

### Why the mechanism stays inert even here

Two measurements explain it.

**The requested windows are large.**

Across the five legs the model asked for 200 windowed reads. Sizes of 10–24 appear 37 times, and 25–50 appear 42 times. The rest run from 60 up to 330. A trigger of 24 admits 7 windows in a 16-task leg, and a trigger of 1000 admits all of them.

**Where the trigger is not the limit, the cap is.**

At trigger 1000 every windowed read reaches the parser. Only 2 of roughly 42 produced a widening. The rest were refused, overwhelmingly because the enclosing block exceeds the 80-line code cap.

**And where it does fire, the gain is a few lines.** All six widenings observed across the sweep:

| requested | served | added |
|---|---|---|
| 1092-1106 | 1092-1106 | **0** |
| 1092-1106 | 1092-1107 | +1 |
| 2450-2464 | 2450-2468 | +4 |
| 1445-1464 | 1442-1470 | +6 |
| 2386-2397 | 2386-2416 | +19 |
| 2290-2319 | 2244-2319 | +46 |

Mean +12.7 lines, and one of the six served exactly what was requested. The reason is visible in the sizes: when the model probes 15 lines inside a 20-line function, the enclosing block is the window. **The model already sizes its window to the block.** Expansion adds something only when the model under-shoots, and it under-shoots rarely.

### What this establishes

Read expansion is inert on real code for two independent reasons, and neither is a tuning problem:

1. The model picks windows that already match the enclosing block, so there is little left to add. The observed gain is a median of a few lines per firing.
2. Where the model does under-shoot badly, the block is large and the 80-line cap refuses it.

The trigger is the wrong dial for both. Lowering it makes the feature fire less. Raising it exposes the cap instead. On this evidence the feature is best described as harmless and nearly always a no-op, rather than as either helpful or harmful.

### Limits of this suite

16 tasks is small, so the score comparison cannot resolve a difference below roughly two tasks. The mutations are machine-generated and therefore easier than real issue-driven work. Only two of the four intended repositories are represented: `httpx` and `click` did not reach a green baseline in the container. And the token figures per task, around 275,000, are an order of magnitude above the public suites, so a larger sample costs real money.

## Cap sweep: the cap is the binding control

In an experiment-only build the cap was configurable through `PI_BETTER_EDIT_READ_EXPANSION_CAP`. A positive integer set it for every source. `unlimited` removed it. `dynamic` scaled it to the file as `floor(totalLines * ratio)`, where the ratio defaulted to `1/1.618` and was overridable through `PI_BETTER_EDIT_READ_EXPANSION_CAP_RATIO`. Unset kept the released per-source constants. That build was an uncommitted scratch change and never shipped: released 2.16.0 has only the fixed per-source caps. Seven unit tests cover the modes in that build, and the read-expansion suite passes 163 tests there.

Five legs on micro-swe at trigger 1000, so the cap alone decides whether a widening is served. All five used a 300 s trial timeout.

| cap | widenings | requested median | served median | dilation | extra lines served | same-file re-reads | passed | timeouts |
|---|---|---|---|---|---|---|---|---|
| off | 0 | — | — | — | 0 | 16 | 12/16 | 1 |
| 80 | 3 | 15 | 32 | 2.1× | 51 | 17 | 13/16 | 3 |
| 400 | 11 | 20 | 253 | 7.0× | 1,658 | 18 | 7/16 | 9 |
| unlimited | 14 | 205 | 1122 | 4.5× | **9,314** | 7 | 3/16 | 13 |
| dynamic | 13 | 30 | 253 | 4.7× | 1,718 | 15 | 16/16 | 0 |

**The cap is the binding control, and it works as designed.** Widening events rise with it: 0, 3, 11, 14. So does the amount served. The extra lines are 0, 51, 1,658 and 9,314.

**Unlimited serves a class for a single probe.** The largest widening served 1,317 lines. A 20-line probe inside a 2,698-line file was answered with half the file. That dilation is what the 80-line cap existed to prevent. The sweep confirms the cap was doing real work.

**It buys nothing.** Same-file re-reads are 16, 17, 18, 7 and 15 across the five legs. The 7 comes from the unlimited leg, where three trials timed out before issuing a read at all. Per trial that leg issues 0.54 reads against 1.0 for the off arm, so its re-read count falls only because its trials end early. On the legs that completed, serving 1,658 extra lines did not remove a single second read.

**Score does not track the cap.** Pass counts are 12, 13, 7, 3 and 16. That is not a dose-response. The decisive pair is `cap400` at 7/16 and `dynamic` at 16/16. Both served a median of 253 lines. They widened 11 and 13 times. Yet they differ by nine tasks. Provider latency drifted by two to three times during the sweep. The timing and timeout columns are therefore confounded, and the score column is not attributable to the cap.

### What this establishes

The cap decides how much a widening serves. It can be made to serve a great deal. That extra context did not remove a second read. It did not improve the score beyond noise. At the top settings it produced a median dilation of four to seven times the request. The shipped 80-line ceiling is therefore doing its job: it bounds the cost of a feature whose benefit is not observable.

## Lessons: what a benchmark must do to measure this feature

1. **The benchmark must leave the file on disk.** Every cheap public edit benchmark pre-loads the target file into the prompt. Aider passes `fnames` into its coder and stubs file mentions to an empty set. EDIT-Bench hands over the whole file. With the file already in context, no read tool is called. An on/off trial therefore measures noise. Both suites here were re-anchored as file-on-disk agentic tasks for this reason.
2. **The probe must be small and the block must be large.** Expansion needs a request *below* the trigger inside a block *above* it. Fixtures of 6–20 lines satisfy neither condition. That is why Aider returned a clean null, and why the EDIT-Bench delta cannot be traced to the mechanism.
3. **Retry volume must be normalised before totals are compared.** In the internal pair, raw totals suggested −2.7 % and −7.7 %. Per first attempt the legs agreed within ±1 %. One arm had hit 17 provider errors instead of 45.
4. **A ceiling hides accuracy.** At 226/226 no leg can improve, so only cost and reliability are observable.
5. **Verify the toggle from an artifact, not from intent.** In one leg an invalid value fell back to the default. That made the "off" arm a duplicate of the "on" arm. Only counting served `[widened …]` notes exposed it.
6. **A cheap suite is a poor fit for a read-tool question**, even when it is the best available. The tasks are small, the answers are short, and the tool under test is not the tool they constrain.

## Context runs, deliberately excluded from the comparison

Recorded earlier on Pi **0.85.1**, same model and thinking:

- `results/explicit-edit-2026-10-29T06-21-45.000Z` — 2.14.0, 226/226, 8,547,277 tokens, $0.20, 228 attempts.
- `results/explicit-edit-2160-spark` — 2.16.0, 226/226, 10,949,770 tokens (+28.1 % raw, **+13.7 % per attempt**), 257 attempts, 35 connection errors.
- `results/explicit-edit-2160-deepseek` — 2.16.0 on `opencode-go/deepseek-v4.1-flash`, 226/226, $9.54, 46 timeouts, 97 recoveries. It conflates model and extension, and its smoke trial failed on a provider error.

These runs are excluded for two reasons. Their Pi runtime differs from the paired runs, and no manifest records the sandbox they used. Wall-clock and retry volume are therefore not comparable. They remain useful as one datum. The "+28 % tokens" headline from that window was roughly half retry inflation and half a per-attempt increase that the controlled pair does not reproduce.

## Reproduce

Artifacts live under `explicit-edit-benchmark/results/`:

- `explicit-edit-pi140-2140/{manifest,summary}.json`, `normalized/rounds.jsonl`
- `explicit-edit-pi140-2160/{manifest,summary}.json`, `normalized/rounds.jsonl`
- `explicit-edit-pi140-2160off/{manifest,summary}.json`, `normalized/rounds.jsonl`
- `eb-on`, `eb-off`, `eb-off2`, `eb-off3`, `eb-trig24b`, `eb-trig24c`, `eb-trig48`, `eb-trig1000`, `eb-dynamic`
- `ab-aider-on`, `ab-aider-off2`, `aider-trig24b`, `aider-trig24c`, `aider-trig48`, `aider-trig1000`, `aider-dynamic`

Each external leg holds `trials/*/result.json`, `trials/*/tool-calls.json` and `trials/*/agent/stdout.jsonl`. Widening events are counted from `stdout.jsonl` with `\[widened (\d+-\d+ -> \d+-\d+), ([^\]]+)\]`, deduplicated per trial.

Normalisation recipe: read `rounds.jsonl` (one row per attempt). Take the first row per `trialId`. Sum `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`. Divide by the number of first attempts. Counting raw rows gives the retry-inflated figure instead.

The internal run: `npm run benchmark:submit -- --harness pi-default --model <model> --thinking low --concurrency 10 --auth-file <pi auth.json>`, with the arm's extension version and Pi runtime pinned for each leg. One environment repair was needed on macOS: `npm install --no-save @esbuild/darwin-arm64@<esbuild version>`. The checkout carried `@esbuild/linux-arm64` and every `tsx` entry point failed.

The external runs: `node scripts/bench-container.mjs -- --suite <editbench|aider-polyglot> --concurrency 10 --results results/<leg>`, with `PI_BETTER_EDIT_READ_EXPANSION=off` for the off arms. The wrapper runs `podman --privileged`, mounts the worktree and a persistent cache volume, and passes the key through the environment.

## The still-missing measurement

The feature's own metric is the same-file re-read share. `pnpm run replay:read-expansion` computes it from session corpora, with a threshold of 20 % relative fall on at least 200 served-mode reads per language. On this host both corpora were identical, so it reports 0 % by construction. The missing input is a candidate corpus captured on a host running 2.16.0. No further `explicit-edit` run substitutes for it.

## Threats to validity

- **Provider transport errors** hit 14–18 % of trials in the internal legs and dominate run-to-run variance. Any delta under roughly 5 % there is unresolvable.
- **Ceiling effect** in the internal pair: 226/226 in every leg, so accuracy cannot move.
- **Task shape**: edit-centric, small fixtures. This is precisely the case in which expansion has least to save.
- **One model, one thinking level.** Every result here is one model at one effort setting.
- **p95 depends on the percentile method** (26.23 s against 26.81 s on the same baseline data). Pin one definition before citing p95.
- **Leg A is recovery-assisted.** Its smoke trial failed on a transient connection error while the full run passed 226/226.
- **The external suites are subsets.** EDIT-Bench ran 72 of 108 published problems: 11 JavaScript rows are unadapted and 25 torch-scale signatures were excluded. Aider ran 118 of 225: cpp and java are unadapted, Rust was excluded, and 10 exercises were dropped for vacuous or unbuildable tests. Rust and the torch tasks are the gap, and they are named rather than hidden.
- **Runner defects found and fixed during these runs.** The toggle once received `0` where the extension accepts only `on` or `off`. One off arm therefore ran as an on arm. A macOS `node_modules` tree was mounted into a Linux container. The Aider prepare stalled on a crates.io git index that cargo 1.65 cannot reach through the sparse protocol. Each defect was fixed before the numbers above were taken.
