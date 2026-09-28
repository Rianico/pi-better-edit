# refactor(domain): rename served feedback from echo to serve vocabulary

> **Archived from pre-migration issue #108.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-14T14:42:46Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC).

## Standards finding (review 4) — `echo` used for *serve*

`CONTEXT.md` § Language defines **serve** as delivering line rows into model context (tool output, diffs, error feedback) and commands `_Avoid_: display, show, echo`, reserving *echo* for the single error condition **served hash echo**.

The resolution seams still name reject-and-serve feedback `echo`:

| Site | Current |
| --- | --- |
| `src/hashline/served-verification.ts:78` | `buildRangeEcho` (exported) |
| `src/hashline/served-verification.ts:117-132` | `buildRangeEchoBlock` returning `{ echoRows, echo }` |
| `src/served-session/types.ts:64`, `session.ts:942` | `recordEcho(...)` |
| `src/served-session/index.ts:72` | `recordEchoServes(...)` |
| `src/mutation-engine/pipeline.ts:480,483` | `handle.recordEcho(...)` |
| `src/noop-guard.ts:57,69-71` | `echoRows`, `buildRangeEcho`, `recordEcho` |

**Worse**: the guard added by #101 does not enforce the rule. `test/arch/terminology-synonyms.test.ts` exempts one file (`expect(matching(/echo/i)).not.toContain("src/hashline/lease-resolve.ts")`) — so `buildRangeEchoBlock` survives in the *same directory as the guard* — and its other assertion checks `recordRejectionEcho|batchAbortEchoBlock`, two identifiers that never existed.

## Remedy

Rename the non-canonical identifiers (keep the map consistent end-to-end):

- `buildRangeEcho` → `buildRangeServeRows`
- `buildRangeEchoBlock` → `buildRangeServeBlock`; its return shape `{ echoRows, echo }` → `{ servedRows, rendered }`
- `recordEcho` → `recordServeFeedback` (interface + implementation + every call site)
- `recordEchoServes` → `recordRejectionServes`
- `src/mutation-engine/types.ts:81` `echo?: string` → `servedBlock?: string` (update `mutation-engine/engine.ts:31-34` and the doc shapes that list `echo`, e.g. `served-verification.ts:295`)
- Prose/comments that use *echo* for serve: `noop-guard.ts:50`, `served-verification.ts:8,116,160-161`, `mutation-engine/pipeline.ts:21,54`, `mutation-engine/engine.ts:31,34`, `payload-contract.ts:84`

**MUST NOT be renamed** — this is the canonical `served hash echo` family, including its prose and tests: `E_SERVED_ECHO`, `EditHashEchoError`, `findEditHashEcho`, `ServedHashEcho`, `findServedHashEcho`, `servedHashEchoDenial`, the module `src/write-hook.ts`, and the glossary phrase `served hash echo` in `CONTEXT.md`.

**Replace the weak guard**: scan `src/**.ts` whole-tree, strip the canonical tokens listed above, then assert no `/echo/i` remains. No single-file carve-out: if a file must stay exempt (only `src/write-hook.ts`, which implements the canonical condition), keep it as an explicitly commented allowlist entry — not a silent `.not.toContain(<one path>)`. The guard must fail if any renamed identifier returns.

## Acceptance criteria

- `rg -ni 'echo' src/` returns only canonical `served hash echo` family occurrences; every non-canonical use is renamed.
- `test/arch/terminology-synonyms.test.ts` enforces the rule tree-wide with an explicit canonical allowlist, and fails when a renamed identifier is reintroduced (prove it by temporarily reverting one name and observing red — do not commit the probe).
- No behaviour change: all 15 Stage-0 probes stay green, including the four fail-closed probes with byte-identical file assertions; no existing assertion weakened or deleted.
- Renamed identifiers are updated everywhere, including tests and docstrings that reference them.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:28Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
