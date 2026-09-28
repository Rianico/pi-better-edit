# edit: unify rejection diagnostics (distinct-anchor counts, one served block, [MODEL] tag, batch noun)

> **Archived from pre-migration issue #147.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-18T09:21:13Z · state CLOSED · labels: bug, ready-for-agent

## Body

## Problem

Five reporting defects in the rejection path, all measured on `ba7c8d2`. Sources: `docs/spec/mvcc-session-failure-handoff.md` (findings 6, 7, 8), `docs/spec/error-code-consistency-audit.md` (F3a, F3b).

| # | Defect | Evidence |
| :--- | :--- | :--- |
| 6 | One anchor used as both bounds is counted and listed twice: `[E_STALE_ANCHOR] 2 stale anchors in sample.ts: "ZZZ", "ZZZ".` | `src/hashline/resolve.ts:202`, `src/hashline/lease-resolve.ts:103-117` |
| 7 | A batch abort renders the served block twice (`Current range:` then `Current on-disk range for edit[i]`) | `src/mutation-engine/pipeline.ts:505` |
| 8 | Doubled tag: `[MODEL] edit[1] (…) failed: [MODEL] [E_STALE_RANGE] …` | `src/mutation-engine/pipeline.ts:533` |
| F3a | `[E_NOOP_LOOP]` rejects carry no `[MODEL]` prefix, while every other retryable edit-path rejection does (`docs/adr/0014-user-model-audience.md:19`) | `src/noop-guard.ts:82-83`; the notice variants at `:89-90` correctly stay `[USER]`-dimmed |
| F3b | A single-item call is told "resend will reject **the batch**" | `src/mutation-engine/pipeline.ts:821` passes `batch: true` unconditionally; the single-item wording at `src/noop-guard.ts:83` is production-unreachable |

| Flag 2 | A `content` error without the audience prefix: `[E_UNDO_STALE] cannot undo on …` returns `content` with `isError: true`, while `docs/adr/0014-user-model-audience.md:19` states error `content` headers are `[MODEL] [E_*]` | `src/edit-undo.ts:151`, `:164` (the ADR's sweep never listed `src/edit-undo.ts`) |

## Note on the audit's Flag 2

The consistency audit refuted this item with *"prefixing would falsely promise retry"* — a rationale that rests on reading `[MODEL]` as a retry demand. `[MODEL]` is an audience marker (see #146), so the refutation is unsound: the real question is whether the undo refusal is a model-facing signal (it is returned in `content`) and therefore needs the prefix. Re-check this row before closing.

## Acceptance

- One anchor is counted once; the plural label follows the distinct count.
- A rejection renders the served block exactly once.
- Exactly one `[MODEL]` tag per message.
- `[E_NOOP_LOOP]` rejects carry `[MODEL]`; its notices keep the dimmed `[USER]` channel.
- Batch wording matches the call arity (single item vs batch).
- Existing message pins are updated, not deleted (`test/core/hashline.parse.test.ts`, rejection-message tests); `pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-18T10:23:07Z

## `E_UNDO_STALE` re-open verified independently

The withdrawn refutation is sound, and I confirm it: `src/edit-undo.ts:151` and `:164` return `content` with `isError: true` and a bare `[E_UNDO_STALE]`, while `docs/adr/0014-user-model-audience.md:19` states that error `content` headers are emitted as `[MODEL] [E_*] …` normal, and the ADR's file sweep (`0014:40`) never listed `src/edit-undo.ts`. The non-blocking precedent is real: `src/edit-tool.ts:53` emits `[MODEL] [E_BAD_PAYLOAD] Autocorrected: …` as a warning, and `src/edit-response.ts` appends `warnings` to model content. The earlier retryability-based refutation was mine — it was wrong, and the audit now records it as withdrawn.

Citation fixes landed in `docs/spec/error-code-consistency-audit.md` (874411b): the monochrome clause cites `0014:13`, and the withdrawn refutation is marked in place so the entry no longer reads as live.


### @Rianico — 2026-09-20T14:33:06Z

Verified on `main` @ `3b22008` (first pass `4ee5f79`, completed by the batch/tier rounds).

All five defects are closed structurally rather than by convention: anchors are reported per distinct anchor; a batch abort renders one served block (the failing item's `servedBlock` only, with no sibling leakage — `test/arch/rejection-payload-region.test.ts` and the isolation test pin it); the doubled tag is gone because the batch arm no longer repeats the item ref that `batchAbortFor` already prefixes; and `[E_NOOP_LOOP]` is audience `MODEL` through the registry. The registry is now the only producer of `[MODEL]`/`[USER]` headers, with an ast-grep oracle asserting no raw header literal exists outside `src/domain-errors.ts`.

Closing as resolved.
