# refactor(docs): sweep the avoided echo synonym out of docs and test descriptions

> **Archived from pre-migration issue #114.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-15T02:38:39Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78. Review 5, Standards finding 1 (residual of #108).

## Rule

`CONTEXT.md` § Language (`serve`): `_Avoid_: display, show, echo`, reserving *echo* for the single error condition **served hash echo**. `docs/agents/domain.md`: avoided synonyms are banned in documentation and test descriptions too.

#108 renamed the identifiers in `src/` and added a guard — but the guard only scanned `src/`, so the same avoided synonym survives across documentation and test descriptions.

## Violations (verified on `39f1076`)

**Documentation**
- `README.md` L56 `diff/echo/reject rows`, L108 `diff/echo rows`, L116 `rejection echo`, L119 `the current range is echoed`, L130 `echoes all count as serves`, L196-199 (table cells `the current range is echoed`), L259, L263
- `CONTEXT.md` L74 `(or an echo/diff that covers …)`, L90 `(or reject-and-serve's echoed rows)`
- `docs/adr/0016-…-supersedes-healing.md` L21 `costs one echo turn`, L27 `echoed rows`
- `docs/adr/0015-named-object-edit-payload.md` L19 `variants with echo + retry hint`
- `docs/spec/session-keyed-served-state.md` L34, L36 — L34 also names the **renamed** `recordEchoServes`, so the doc is doubly stale (correct name: `recordRejectionServes`)
- `docs/articles/tool-contracts-for-llm.md` L71 `stale-anchor/echo/drift scenarios`

**Test descriptions / comments**
- `test/core/served-rejection-unification.test.ts` — describe/it titles and comments
- `test/hashline/lease-resolve.test.ts` L80, 155, 167, 189, 349, 473, 619, 623, 644
- `test/core/reject-and-serve-seam.test.ts` L17
- any other test file where a *title or comment* calls served feedback an echo (`rg -ln echo test/`)

**Keep (canonical or a different sense — document why in each case)**
- the `served hash echo` family: `E_SERVED_ECHO`, `EditHashEchoError`, `findEditHashEcho`, `ServedHashEcho`, `findServedHashEcho`, `servedHashEchoDenial`, `src/write-hook.ts`, the glossary phrase itself
- `docs/articles/hash-anchors-myers-single-token-review.md` L11 — quoting an external proposal about a *model* echoing old code, not served feedback

## Remedy

Replace the avoided synonym with **serve** wherever it denotes served rows (reject-and-serve feedback, diff rows, fresh anchors): "the current range is served as fresh `HASH│content` rows", "diff/serve/reject rows", "costs one serve turn", etc. Fix the stale identifier in `docs/spec/session-keyed-served-state.md`.

**Then close the hole that let it through**: extend `test/arch/terminology-synonyms.test.ts` so it covers, each with an explicit documented canonical allowlist (strip allowlisted tokens, then assert no `/echo/i` remains):
1. `src/**.ts` (existing whole-src rule — keep it),
2. **test titles** across `test/**.ts` (lines matching `/^\s*(it|test|describe)\(/`),
3. the binding domain docs: `CONTEXT.md` and `docs/adr/**.md`.

No single-file carve-outs and no allowlisting by file except `src/write-hook.ts` (the canonical condition's implementation), with the reason in a comment.

## Acceptance criteria

- `rg -ni 'echo' README.md CONTEXT.md docs/ test/` returns only canonical `served hash echo` occurrences and the documented external-quote case.
- The extended guard fails when a violation is reintroduced — prove it by temporarily reverting one rename, observe red, then restore (do not commit the probe).
- No assertion weakened or deleted anywhere.
- All 15 Stage-0 probes stay green, including the four fail-closed probes with byte-identical file assertions.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:46Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
