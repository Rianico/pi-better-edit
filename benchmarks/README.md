# Benchmarks

This project's correctness claims are measured, not asserted. Two batteries
cover the two layers of the stack:

- **Tool battery** (`test/eval/comparison-battery.test.ts`, `scripts/eval-compare.mjs`)
  drives the pi extension tools (`read` / `edit` / `undo_last_edit`) through
  the same 23 scenarios against this fork and against published upstream
  versions of `pi-hashline-edit-pro`.
- **Library battery** (`hashline-compare.mjs`, `hashline-battery.mts`) drives
  the [`@oh-my-pi/hashline`](https://www.npmjs.com/package/@oh-my-pi/hashline)
  patch engine through the 10 scenarios that map onto its model.

Every scenario is a deterministic check with a pass/fail verdict — no model in
the loop, no sampling, no stochastic variance. A run either reproduces or it
doesn't. This is deliberately a *correctness* benchmark: does each engine
reject stale edits instead of corrupting files?

Token economics is measured separately because token counts depend on the
payload corpus and tokenizer. This repository now ships a pinned local fixture:

```bash
npm run benchmark:tokens
```

For the 12-edit configuration-refactor fixture, `cl100k_base` reports:

| arm | tokens | saved vs local `str_replace` baseline |
| --- | ---: | ---: |
| str_replace-style JSON | 358 | — |
| this project, `edit` | 248 | **30.7%** |
| this project, `batch_edit` | 238 | **33.5%** |

The benchmark counts serialized payload tokens: twelve individual `edit` calls,
one root-array `batch_edit` call, and twelve individual `str_replace` calls. It is
an envelope measurement; final correctness remains covered by the tool and library
batteries below. The external pinned 12-edit `cl100k_base` snapshot is documented in
`../oh-my-pi.md` and reports 31% for the sibling JSON hashline arm, 42% for oh-my-pi
per-edit patches, and 53% for one batched patch document.

## Tool battery

Method: each scenario creates a scratch file, performs the tool calls exactly
as a model would (read → edit → verify, including the reject-and-serve retry
path), and checks the outcome and the final file content against an expected
verdict. The verdict requires the exact outcome **and** the preserved content
(`preserve` checks), so a scenario that silently overwrote a drifted interior
fails even if the call "succeeded".

Reproduce (Node ≥ 22.19, network needed to install the upstream targets):

```bash
npm run eval              # this fork, local checkout
npm run eval:compare      # local vs pi-hashline-edit-pro@2.4.1 vs 2.5.3
npm run eval:compare -- local pi-hashline-edit-pro@2.5.0   # override targets
```

`eval:compare` installs each target into a temporary directory
(`--no-save --no-package-lock`), symlinks it into `node_modules`, runs the
battery, prints a per-scenario correctness table plus aggregate call/
character counts, then restores

### Results (2026-08-17, Node 22, macOS arm64)

| vs expected verdict | correct | silent data-loss cases |
| --- | --: | --: |
| **this fork (1.1.3)** | **23/23** | 0 |
| `pi-hashline-edit-pro@2.4.1` (fork base) | 17/23 | 5 (B3, B7, B8, B10, B15) + B22 cross-session serve leak |
| `pi-hashline-edit-pro@2.5.3` (latest) | 21/23 | 0 (B8 blind-edit hole, B22 cross-session serve leak) |

Per-scenario table: [results/2026-08-17-tool-battery.md](results/2026-08-17-tool-battery.md).

The scenarios with a `WRONG` verdict for 2.4.1 (B3, B7, B10, B15) are the
"interior drift must-not-silently-overwrite" family: the file changed inside
the edit range after it was read, and the upstream applied the edit anyway,
overwriting the drifted lines. B8 and B22 (both versions) are the
never-served / cross-session serve holes, where an edit anchored on lines the
model was never shown — or was shown in another session — still landed.

## Library battery (@oh-my-pi/hashline)

Method: each scenario drives the `Patcher`/`Patch` API against an
`InMemoryFilesystem` with an `InMemorySnapshotStore`, exactly as the
[package README](https://www.npmjs.com/package/@oh-my-pi/hashline) documents.
Scenarios assert the same safety property as the tool battery: a stale tag is
either recovered with an explicit warning or rejected — never silently
applied. The battery additionally checks that the recovery/head-tail warnings
actually surface, since that is the difference between "detected drift" and
"silent overwrite".

Hashline ships as TypeScript source and its engines require bun
(`"bun": ">=1.3.14"`), so the runner installs `bun` into the scratch directory
alongside the package; nothing is installed into this repo.

Reproduce:

```bash
npm run eval:hashline                          # @oh-my-pi/hashline@latest
npm run eval:hashline -- @oh-my-pi/hashline@17.3.5   # pin a version
```

### Results (2026-08-17, @oh-my-pi/hashline 17.3.5)

10/10 scenarios correct. On the stale-tag paths hashline either recovers with
an explicit `Recovered from a stale file hash…` warning (anchors still map to
unchanged lines) or rejects with a `MismatchError` carrying the anchored
context (H3). Head/tail-only inserts with a stale tag apply with a
`HEADTAIL` warning because their position is content-independent (H4). The
multi-section patch preflights every section before any write, so a stale
second section leaves the first untouched (H8). Unseen anchors are rejected
with a content reveal and a straight retry succeeds (H7).

Per-scenario table: [results/2026-08-17-hashline-library.md](results/2026-08-17-hashline-library.md).

## Reading the numbers honestly

- The two batteries measure different layers. The tool battery tests the pi
  extension's served-state verification, error codes, and undo at the tool
  seam. The library battery tests the hashline patch engine's tag/recovery
  semantics. Neither subsumes the other; both gate the same underlying claim:
  **stale edits are detected, never silently applied**.
- `hashline` is a library; this project is a tool layer built on the same
  concept (per-line content-derived anchors, fail-closed on stale state). The
  mapping between the two is a design comparison, not a score comparison; see
  the main README's [Comparison section](../README.md#comparison).
- These are correctness gates, not throughput numbers. "Calls" and "chars"
  aggregates are the battery's own transcript sizes, included for
  cross-version comparability, not a performance claim.

## Metrics

| Battery | Verdict source | What it gates |
|---------|----------------|---------------|
| Tool battery B1–B22 | outcome + `preserve`/`equals` content checks | every `edit`/`undo` scenario: stale interiors, never-served ranges, noops, empty files, autocorrects, session isolation, undo |
| Library battery H1–H10 | outcome + content checks + warning presence | valid apply, stale-tag recovery vs rejection, head/tail drift, noop, empty-file insert, unseen-anchor guard, batch atomicity, cut/paste, missing tag |

## Prerequisites

- Node.js ≥ 22.19 (tool battery; matches `engines`).
- Network access (installs target packages + the bun runtime into a temp dir).
- macOS/Linux scratch installs work out of the box; Windows is untested for
  the hashline battery (bun + pi-natives staging).

## Notes

- `npm run eval` gates on `RUN_EVAL=1` so the battery never runs in the
  default `npm test` suite.
- The hashline battery pins no version by default (`@latest`); pin explicitly
  (as above) when you need a reproducible across-machine comparison.
- Dated results live in [results/](results/); when you re-run and numbers
  drift, commit a new dated file rather than editing an old one.
