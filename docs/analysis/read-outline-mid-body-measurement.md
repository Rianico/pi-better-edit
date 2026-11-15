# Read outline: mid-body measurement

Date: 2026-11-15. Question: when an edit target is deep inside a large function, does an outline-led read reduce tokens and exploration rounds?

The prior body suite inserted at the opening brace. The declaration anchor alone could solve it, so that suite measured the cost of a body read, not its value. This suite moves the target into the function body.

## Verdict

The prompt-only **150-line / 60-line** guideline is the best aggregate arm at N=18.

- 18/18 pass.
- **38,153 tokens/trial**, **−15.3%** against the 45,032 control.
- **3.61 rounds/trial**, the lowest in the study.
- No schema change and no `read.md` change.

It beats span mode (38,469 tokens, 3.75 rounds) and anchor range (39,652 tokens, 3.67 rounds) on tokens. The 150/50 arm is rejected: at N=18 it is 42,625 tokens.

The aggregate win is not uniform. Three deep-target tasks save 48,162 tokens; three shallow tasks pay 6,888 tokens. The 7:1 leverage is the reason to ship.

## Method

- Six tasks. Each inserts a unique line deep inside a large function.
- Model `opencode-go/muse-spark-1.3-contributor`, thinking low.
- Tools: `read`, `edit`, `undo_last_edit`; no bash.
- Sequential arms, concurrency 2.
- Control, radius 5, anchor range, span mode: 6 tasks × 2 reps, 12 trials.
- Prompt-only arms: 12 trials; the 150/50 and 150/60 arms were repeated to 18 trials.

Tasks:

| id | file | function | target depth |
|---|---|---|---|
| `mid-build-store-deep` | `src/hash-store.ts` | `buildStore` | 109 of 130 lines |
| `mid-build-store-gate` | `src/hash-store.ts` | `buildStore` | 72 of 130 |
| `mid-build-stmts-lineage` | `src/served-session/session.ts` | `buildStmts` | 41 of 300 |
| `mid-build-stmts-folds` | `src/served-session/session.ts` | `buildStmts` | 131 of 300 |
| `mid-load-edit-file` | `src/mutation-engine/edit-source.ts` | `loadEditFile` | 21 of 41 |
| `mid-verify-span` | `src/served-session/serve-render.ts` | `verifyRebasedSpan` | 125 of 170 |

## Results

| arm | N | pass | tokens/trial | delta | rounds/trial | reads | whole-file |
|---|---:|---:|---:|---:|---:|---:|---:|
| control | 12 | 12/12 | 45,032 | — | 4.00 | 22 | 7 |
| radius 5 | 12 | 12/12 | 43,591 | −3.2% | 4.75 | 33 | 2 |
| anchor range | 12 | 12/12 | 39,652 | −12.0% | 3.67 | 20 | 4 |
| span mode | 12 | 12/12 | 38,469 | −14.6% | 3.75 | 21 | 3 |
| prompt: 7th bullet, 40-line chunk | 12 | 12/12 | 45,699 | +1.5% | 5.25 | 39 | 1 |
| prompt: 100-line / 50-line | 12 | 12/12 | 41,749 | −7.3% | 3.92 | 21 | 5 |
| prompt: 150-line / 50-line | 18 | 18/18 | 42,625 | −5.3% | 3.89 | 32 | 9 |
| **prompt: 150-line / 60-line** | **18** | **18/18** | **38,153** | **−15.3%** | **3.61** | 29 | 8 |

The 150/60 arm's 12-trial result was 36,377. At N=18 it settles at 38,153.

The 150/50 arm's 12-trial result was 38,153. At N=18 it is 42,625. The 12-trial result was optimistic.

## Per-task: 150/60 vs control

| task | control | 150/60 | delta |
|---|---:|---:|---:|
| `mid-build-store-deep` | 64,927 | 36,729 | −43.4% |
| `mid-build-store-gate` | 42,844 | 44,874 | +4.7% |
| `mid-build-stmts-lineage` | 53,974 | 36,479 | −32.4% |
| `mid-build-stmts-folds` | 46,196 | 46,807 | +1.3% |
| `mid-load-edit-file` | 25,637 | 23,168 | −9.6% |
| `mid-verify-span` | 36,614 | 40,861 | +11.6% |

The three wins save 48,162 tokens. The three regressions add 6,888. The net is 41,274 tokens saved across the six tasks.

The 150/50 arm regresses more: `mid-build-stmts-folds` +19.8%, `mid-load-edit-file` +3.9%, `mid-build-store-gate` +4.5%. The 50-line window is too narrow for the 300-line `buildStmts` target.

## Mechanism

- The control's whole-file reads are the dominant cost. Seven of its 22 read calls read the whole file. When a small window missed a deep target, the model sometimes escalated to a whole-file read.
- The 7th-bullet 40-line chunk arm eliminated whole-file reads (1 of 39) but turned the model into a sequential scanner. It cost 5.25 rounds and 45,699 tokens. Sequential windowing is worse than one whole-span read.
- The 100-line / 50-line bullet was partial. `buildStore` is 130 lines; the 100-line threshold classified it as large and forced a window, losing the one-call span win.
- The 150-line threshold lets `buildStore` (130) read as one span and keeps `verifyRebasedSpan` (170) on the 60-line window. That is the 150-line win on both tasks.
- The 60-line window is better than 50 on the 300-line `buildStmts` target: `mid-build-stmts-folds` falls from 55,347 (50) to 46,807 (60).
- The 60-line window costs on `mid-verify-span`: 40,861 vs 35,011 at 50. The net across all six tasks favors 60.

## Threats

- N=18 for the final prompt arm; N=12 for the control and the schema arms. The per-task spread is larger than the aggregate delta.
- One model and one effort setting.
- The 12-trial claims did not survive N=18. The "every task wins" claim is false; the aggregate is the defensible claim.
- The whole-file reads are 8/29 (27.6%) at N=18, not 3/22. The 12-trial whole-file count was optimistic. The remaining whole-file reads are mostly turn-1 direct reads, not panic loops.
- The 150/50 arm's `mid-build-stmts-folds` N=18 mean includes a malformed `windows` JSON argument. The 150/60 arm's N=18 result is the cleaner comparison, but the sample is still small.
- The 7:1 leverage is a post-hoc aggregate. It is a reason to ship, not a prediction for every task.

## Recommendation

1. Ship the 150/60 bullet in `prompts/read-guidelines.md`. Keep the 6-guideline structure. Keep `prompts/read.md` unchanged.
2. Do not add `mode: "span"`, `span_anchor`, `span_offset`, `anchor_from`, or `anchor_to`. The prompt-only arm matches or beats them on tokens and rounds with no schema.
3. Do not set `DEFAULT_ANCHOR_RADIUS` to 5. It increases rounds on deep targets.
4. Stop at N=18. Do not run Rep 4 or test a 55-line window. The 150/50 rejection is decisive; 55 is overfitting.
5. Keep the schema branches as experimental evidence. Do not merge them.

The ship bullet:

```markdown
- read: for a file above about 200 lines, start with `mode: "outline"` before any body read. It serves one declaration line per symbol as a live anchor, so you can find the target without reading the whole file. When the edit targets that declaration line, edit from the anchor directly; do not read the body. Otherwise read only the window you need: for a function under 150 lines, read its span in one call via `{ offset, limit }`; for larger functions, read a 60-line window around the target. Do not read the whole file to verify.
```
