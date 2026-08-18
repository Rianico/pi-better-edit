# Practical model-run token/correctness benchmark — 2026-08-17

Command:

```bash
npm run benchmark:practical
```

Configuration:

- Provider: `opencode-go`
- Model: `gpt-5.6-luna`
- Thinking: `high`
- Fixture: `scenario.ts`
- Scenario: read the file, use bash once to change `retries = 2` to `retries = 5`, then apply the remaining configuration refactor through the editing tool while preserving the external change.
- Correctness: final file must exactly equal the expected fixture content.
- Token usage: the sum of assistant `message_end.usage.totalTokens` values emitted by pi, including input, output, reasoning, cache-read, and cache-write usage.

## Results

`@oh-my-pi/hashline` is the practical baseline for the relative column in this run. The project's practical advantage is fewer round trips: **3 tool calls versus 6 for OMP**.

| engine | tool calls | total tokens | saved vs OMP baseline | final correctness |
| --- | ---: | ---: | ---: | :---: |
| `@oh-my-pi/hashline` wrapper | **6** | 28,467 | 0.0% | ✅ |
| this project (`edit`, multi-item) | **3 (fewest)** | 12,593 | **55.8%** | ✅ |

Usage breakdown:

| engine | input | output | reasoning | cache read | cache write |
| --- | ---: | ---: | ---: | ---: | ---: |
| OMP wrapper | 21 | 3,016 | 2,215 | 19,100 | 6,330 |
| this project | 12 | 475 | 161 | 8,592 | 3,514 |

Both engines preserved the external `retries = 5` edit and produced the expected final file in this sample. The OMP run required four patch attempts. Model behavior and cache state are stochastic, so this is one dated sample. Re-run the command to produce another result; do not treat a single run as a universal performance claim.
