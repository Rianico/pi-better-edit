# T2 — Single result assembly: structured warnings and pure finalizeResult

> **Archived from pre-migration issue #11.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-12T06:10:13Z · state CLOSED · labels: ready-for-agent

## Body

## Parent

#9 — Architecture refactor: served-state module + single result assembly (spec)

## What to build

The post-edit result the model sees is assembled exactly once, by a pure function in the response-assembly module, using structured warnings carried in `details`. The tool_result handler stops string-parsing the rendered text to recover warnings and becomes a thin adapter that calls the assembly function. The model-facing text is identical to today: same success/noop lines, same warnings block, same drift notice placement, same auto-read diff.

## Acceptance criteria

- [ ] Warnings flow through `details` as structured data (`warnings: string[]`); the string-parsing warning recovery is deleted.
- [ ] A pure `finalizeResult(details)` in the response-assembly module produces the post-edit text (diff + warnings + drift notice); the existing response builders (`buildChanged`/`buildNoop`) keep building the non-diff text.
- [ ] The tool_result handler is a thin adapter: read `details`, call the assembly function, return content. It no longer re-derives warnings from text.
- [ ] Result text is identical for applied, noop, and drifted results (asserted by the existing harness tests, which stay green unchanged in observable behavior).
- [ ] Unit tests for the assembly function follow the existing response-builder test pattern (prior art: existing test/core response tests).
- [ ] Full suite green and `npm run eval:compare` reproduces the known results — no observable-behavior change.

## Blocked by

T1 (served-state module) — both touch the tool_result handler; sequence to avoid rebase noise.

## Comments

### @Rianico — 2026-08-12T06:43:41Z

Verified: typecheck + lint clean; full suite 941 passed + 1 skipped; eval:compare local 19/19 / 2.4.1 14/19 / 2.5.0 18/19 (identical char counts). Commit 4fc0005 on main.
