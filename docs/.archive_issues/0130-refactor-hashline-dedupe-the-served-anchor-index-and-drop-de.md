# refactor(hashline): dedupe the served anchor index and drop dead prefix regexes

> **Archived from pre-migration issue #130.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-16T07:38:25Z · state CLOSED · labels: ready-for-agent

## Body

## Findings (review P3-1, P3-2, P3-3)

**Duplicated index construction.** `findServedHashEcho` and `findServedPrefixMismatches` (`src/hashline/served-guard.ts`) build the same `byAnchor: Map<string, Array<{ servedLine, canonText }>>` and repeat the same diff-marker stripping, prefix slicing and anchor validation.

**Dead code.** `HL_PREFIX_PLUS_RE`, `HL_PREFIX_MINUS_RE`, `HL_BARE_PREFIX_RE` (`src/hashline/hash-identity.ts`) are unused anywhere in `src`, `test`, `prompts` or `docs`; only the barrel `src/hashline/index.ts` re-exports them. `src/hashline/hash.ts` carries unused `_HL_PREFIX_*` twins. `src/write-hook.ts` has `void HASH_SEP;` with `HASH_SEP` imported solely for that statement. `src/edit.ts` has a redundant `void editModeSchema;` (`editModeSchema` is genuinely used later in the file).

## Required behaviour

1. Extract one internal helper for the shared anchor-index build plus candidate scanning, consumed by both functions. This is permitted internal deepening — no public contract change.
2. Delete the dead regexes (all three sites), the barrel re-exports, `void HASH_SEP;` together with its now-unused import, and the redundant `void editModeSchema;`.
3. Remove any import that becomes unused as a consequence; `tsc`/`oxlint` must be clean with no new suppressions.

## Invariants

- Both functions keep their exported names, signatures, returned field sets and ordering of results.
- Existing tests are the oracle for the refactor: the reported `k`, `line`, `anchor`/`hash` and `servedLine` values must not change.
- Architecture guards must stay green, including `test/arch/terminology-synonyms.test.ts` (`src/write-hook.ts` is in `CANONICAL_ALLOWLIST`).


## Comments

### @Rianico — 2026-09-17T16:31:15Z

Landed in #134 — squash `ba7c8d2` on `main` (the PR body's comma-separated `Closes` list only linked the first reference per line).
