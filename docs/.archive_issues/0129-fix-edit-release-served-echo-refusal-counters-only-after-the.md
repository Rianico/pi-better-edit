# fix(edit): release served-echo refusal counters only after the write lands

> **Archived from pre-migration issue #129.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-16T07:38:23Z · state CLOSED · labels: ready-for-agent

## Body

## Findings (review P1-2 and P2-2)

The served-echo refusal counter is meant to sharpen a repeated identical refusal, and to be released when the attempt is consumed. Two defects break that.

**P1-2 — write surface never releases it.** `src/lifecycle-hooks/index.ts` calls `clearServedRefusals(absolutePath)` only inside `if (literalBypass)`.
*Counterexample*: refusal (`submission 1×`) → model retries with clean content → write succeeds → next identical refusal reports `submission 2×` although the sequence was already consumed.

**P2-2 — edit surface releases it too early.** `src/mutation-engine/pipeline.ts` clears inside the per-edit in-memory loop, before `writeAtomic` commits.
*Counterexample (reproduced locally)*: seed a refusal, then submit an edit whose commit fails (E_UNDO_UNAVAILABLE or a `writeAtomic` failure) → the counter was already cleared → the next identical refusal reports `submission 1×` instead of `2×`.

## Required behaviour

1. `write`: clear unconditionally on a successful write — drop the `literalBypass` guard, keep the best-effort `try/catch` and its SAFETY comment.
2. `edit`: clear only after the bytes land (after the `writeAtomic` `try/catch` in `apply`), and remove the in-loop clear from `runMutations`. `clearNoopLoop` behaviour is out of scope and must not change.

## Tests (test-first)

- `test/tools/lifecycle-hooks.test.ts`: after a successful `onWrite` **without** `mode: "literal"`, `trackServedWriteRefusal` for the same path + payload returns `1` again (not `2`).
- Integration (`test/core/served-literal-declaration.test.ts`): with a refusal already counted, an edit whose commit fails must leave the counter intact — inject the failure by mocking `../../src/fs-write.js` with a hoisted flag that delegates to the real `writeAtomic` when the flag is off — then assert the next identical refusal reports `submission 2×` and the file bytes are unchanged.

## Invariants

- The counter is best-effort: it must never block or alter a write.
- No session scoping, LRU, or TTL in this task — deliberately deferred to a follow-up ticket (the settled design keeps one in-process map modelled on `noopLoopTracker`).


## Comments

### @Rianico — 2026-09-17T16:31:11Z

Landed in #134 — squash `ba7c8d2` on `main` (the PR body's comma-separated `Closes` list only linked the first reference per line).
