# Read expansion: benchmark evidence

Status: evidence record, 2026-11-01. Not a decision record; ADR [0008](../adr/0008-read-expansion-requested-window-and-bounds.md) holds the contract.

## Question

Does read expansion (pi-better-edit 2.16.0) cost or save anything measurable at fixed model, fixed Pi runtime, and a fixed task set — and can that be separated from retry noise?

## Setup

Three legs of `explicit-edit-benchmark` (226 tasks, one attempt each) in one sandbox on one host.

| | A | B | C |
|---|---|---|---|
| extension | pi-better-edit **2.14.0** | pi-better-edit **2.16.0** | **2.16.0**, `PI_BETTER_EDIT_READ_EXPANSION` set |
| Pi runtime | 1.4.0 | 1.4.0 | 1.4.0 |
| model | `opencode-go/muse-spark-1.3-contributor` | same | same |
| thinking | low | low | low |
| concurrency / attempts / timeout | 10 / 1 / 120 s | same | same |
| sandbox | `podman --privileged`, `localhost/eeb-runner:hf` (host is macOS; `bwrap` is unavailable, unprivileged containers fail 0/226 on proc-mount denial) | same | same |

Equivalence evidence: identical task-id sets, identical per-task `fixtureSha256`, identical `verifierSha256`. Only `configSha256` differs, as it must.

Provenance is manifest-read in every leg (`results/explicit-edit-pi140-*/manifest.json`), not inferred from the arm file: `agentVersion 1.4.0`, `harnessVersion` per leg, `attempts 1`, `concurrency 10`, `timeoutMs 120000`.

## Activation proof

Expansion fired only where intended. Counting served chrome lines (`[widened <a>-<b> -> <c>-<d>`) across each leg's `trials/**/agent/stdout.jsonl`:

| leg | served widening notes |
|---|---|
| A (2.14.0) | **0** |
| B (2.16.0) | **35** |
| C (2.16.0, toggle off) | **0** |

Example from B: `[widened 65-84 -> 5-84, section …` in a Markdown task. The trigger fired on 7 Markdown task files and nowhere else, which matches a 24-line trigger against small edit-centric fixtures.

## Results

Raw, from `normalized/rounds.jsonl` sums (one row per attempt):

| metric | A (2.14.0) | B (2.16.0) | C (2.16.0, off) |
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

## The measurement that matters: normalise the retries

Totals and per-attempt averages are dominated by retry volume, and retries here are provider transport failures, not extension behaviour. Recomputed per **first attempt** and per **passing first attempt**:

| metric | A | B | C |
|---|---|---|---|
| tokens per first attempt | 37,824 | **37,883 (+0.2 %)** | **37,696 (−0.3 %)** |
| tokens per passing first attempt | 36,782 | **36,420 (−1.0 %)** | **37,163 (+1.0 %)** |

All three legs cost the same within ±1 %. The apparent "2.16.0 uses 2.7 % fewer total tokens" and "expansion off is 7.7 % cheaper per attempt" are artifacts of C hitting 17 connection errors against A's 47 and B's 45: fewer errors meant 249 attempts instead of 268–273, and every attempt carries tokens into the total.

## What this supports

1. **2.14.0 → 2.16.0 is cost-neutral and score-neutral on this benchmark.** First-attempt token cost +0.2 %; passing-first-attempt −1.0 %; 226/226 in both.
2. **Read expansion is not measurably expensive here.** The normalised cost of B equals A and C.
3. Suggestive only, below the noise floor: B shows −5.2 % tool calls, −4.2 % model rounds, −9.1 % mean wall time against A.

## What this does not support

1. **Any claim that read expansion saves anything.** `explicit-edit` fixtures are small and edit-centric, so a probe already lands near the edit site and the trigger fires rarely (7 files of 226 tasks). The metric the feature targets — a `read` followed by a second `read` of the same file — is not what this benchmark counts.
2. **Any accuracy claim.** The baseline saturates at 226/226, so no score movement is available in either direction.
3. **A per-category story.** Token swings exceed ±25 % in eight categories with zero pass change, which is noise, not signal.

## Context runs, deliberately excluded from the comparison

Recorded earlier on Pi **0.85.1**, same model and thinking:

- `results/explicit-edit-2026-10-29T06-21-45.000Z` — 2.14.0, 226/226, 8,547,277 tokens, $0.20, 228 attempts.
- `results/explicit-edit-2160-spark` — 2.16.0, 226/226, 10,949,770 tokens (+28.1 % raw, **+13.7 % per attempt**), 257 attempts, 35 connection errors.
- `results/explicit-edit-2160-deepseek` — 2.16.0 on `opencode-go/deepseek-v4.1-flash`, 226/226, $9.54, 46 timeouts, 97 recoveries; conflates model and extension, and its smoke trial failed on a provider error.

These are excluded because their Pi runtime differs from the paired runs, and no manifest records the sandbox they ran in — so wall-clock and retry volume are not comparable. They remain useful as one datum: the "+28 % tokens" headline from that window was roughly half retry inflation and half a per-attempt increase that the controlled pair does not reproduce.

## Reproduce

Artifacts, all under `explicit-edit-benchmark/results/`:

- `explicit-edit-pi140-2140/{manifest,summary}.json`, `normalized/rounds.jsonl`
- `explicit-edit-pi140-2160/{manifest,summary}.json`, `normalized/rounds.jsonl`
- `explicit-edit-pi140-2160off/{manifest,summary}.json`, `normalized/rounds.jsonl`

Normalisation recipe: read `rounds.jsonl` (one row per attempt), take the first row per `trialId`, sum `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`, and divide by the number of first attempts. Counting raw rows gives the retry-inflated figure instead.

The run itself: `npm run benchmark:submit -- --harness pi-default --model <model> --thinking low --concurrency 10 --auth-file <pi auth.json>`, with the arm's extension version and Pi runtime pinned for each leg. The harness needed one environment repair on macOS: `npm install --no-save @esbuild/darwin-arm64@<esbuild version>`, because the checkout carried `@esbuild/linux-arm64` and every `tsx` entry point failed.

## The still-missing measurement

The feature's own metric is the same-file re-read share, which `pnpm run replay:read-expansion` computes from session corpora (threshold: 20 % relative fall on at least 200 served-mode reads per language). On this host both corpora were identical, so it reports 0 % by construction. A candidate corpus captured on a host running 2.16.0 is the missing input, and no further `explicit-edit` runs substitute for it.

## Threats to validity

- **Provider transport errors** hit 14–18 % of trials in these legs and dominate run-to-run variance. Any delta under roughly 5 % here is unresolvable.
- **Ceiling effect**: 226/226 in every leg, so accuracy cannot move.
- **Task shape**: edit-centric, small fixtures — precisely the case in which expansion has least to save.
- **One model, one thinking level.**
- **p95 depends on the percentile method** (26.23 vs 26.81 s on the same baseline data by two methods); pin one definition before citing p95.
- Leg A's smoke trial failed on a transient connection error while its full run passed 226/226, so leg A is recovery-assisted rather than clean. Leg C carries the only timeout, an outlier attempt that consumed 211.5 k tokens.
