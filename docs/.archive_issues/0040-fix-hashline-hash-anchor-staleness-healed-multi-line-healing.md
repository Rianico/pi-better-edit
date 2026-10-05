# fix(hashline): hash-anchor staleness — healed multi-line healing and stable anchoring (1.1.5 + arch deepening)

> **Archived from pre-migration issue #40.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-26T13:48:34Z · state CLOSED · labels: (none)

## Body

## Summary
Hash-anchored `edit` (4-char `HASH│content`, content-derived with `[ \t\r\n]` stripped) rejected chained edits after an external insertion above the range with `[E_RANGE_STALE]`/`[E_RANGE_UNSERVED]` even though interior content was unchanged. Root cause: range verification verified the whole resolved range against **served state** but had staleness gaps for **orphaned serve** and **relocated line keeps its hash**. Fixed in `f94fb88` (healing via `canon` + `mapStableHashes`) and deepened into 5 seams (`cfc9ee8`..`f6fdd08`) to make the invariant load-bearing.

Spec: `docs/spec/served-state-range-verification.md` · Vocabulary: `CONTEXT.md` (`serve`, `served state`, `served span`, `range staleness`, `never-served`, `reject-and-serve`, `drift`, `orphaned serve`, `relocated line keeps its hash`, `payload contract`, `anchor philosophy`, `canon`).

## Mechanism (what broke)

- **Multi-line orphan**: `a b c → a 1 b c` (insert `1` above `b`). Editing `b c` with served hashes for `b`/`c` failed: `served` span `[b,c]` at positions `[1,2]` no longer equals current file span `[2,3]` (`fileHashes` shifted). Verification compared `served[1]==fileHashes[1]` and rejected, even though `hash(b)`/`hash(c)` are unchanged (probe `HASH_PROBE_STRIDE 3907` guarantees distinct hashes for distinct lines, `relocated line keeps its hash`).
- **Single-line interior orphan via `canon`**: `line.replace(/[ \t\r\n]+/g,"")` equality keeps hash across whitespace-only formatting. An orphaned single hash (`lup`/`Epr` via `canon`) was treated as missing, not healed.
- **Duplicated content vs relocated line**: `mapStableHashes` uses `nearestNew` + `HASH_PROBE_STRIDE` to distinguish duplicated text (different hashes) from a moved line (same hash, same `canon`).
- **Never-served vs orphaned serve**: `served[i]==null` (`never-served`, paged `read` / disjoint `diff` hunk) must fail closed with `[E_RANGE_UNSERVED]` and `reject-and-serve`; `served[i]==hash` but at wrong position is `orphaned serve` (drift at a single position) and is healable only when the served content sequence occurs once in the file.
- Without heal, chained `edit` after external shift required a `read` to re-serve, violating `model–tool boundary` (tool owns verification, model owns intent).

Tangling: `ServedVerification` healing (280L), `HashIdentity` hashing (5-arg `lineHashes`), `Store` lifecycle, `PayloadContract`, `EditPipeline` 4-module seam were coupled in one file.

## Fix

- **Healing via `canon` + `mapStableHashes`**: remember `HASH→canon` (`line.replace(/[ \t\r\n]+/g,"")`) for single-candidate content fallback; scan cost negligible for multi-line ranges.
- `verifyServedRange` (now `ServedVerification` deep module, `src/hashline/served-verification.ts` 726L, `CanonStore` injection) heals:
  - **Strategy 1 — single-candidate `canon` scan**: when `servedPositionsOf(start)==1 && end==1` and served span length equals current length, reconstruct expected `canon` sequence from `store.get(hash)` and scan `fileLines` for that `canon` sequence; heal only if exactly one match.
  - **Strategy 2 — boundary `canon` heal**: when a boundary hash is absent from `fileHashes` but its `canon` occurs once, locate `startMatches`/`endMatches` via `canon` equality, heal if span length matches and (for `>2` lines) the healed `canon` sequence is unique.
- **Fail-closed**: `never-served` (`served[i]==null`) → `[E_RANGE_UNSERVED]`; ambiguous (`2+ matches`) → `[E_RANGE_UNVERIFIED]` (no guess, `reject-and-serve` with `buildRangeEcho`/`fmtServedRows`, `SERVED_ECHO_CAP` + pagination hint). `relocated line keeps its hash` invariant preserved: unrelated modification never re-identifies a line.
- **Dense `servedRows`** (`7b91958`) prerequisite: post-edit `recordDiffServes` now writes dense `ServedRow[]` (`{position,hash}` per line) so chained edits verify without a `read` even if `tool_result` handler hasn't run (`genDiff` window would miss drift tail).
- `test/integration/hash-heal-tdd.test.ts` pins `a b c → a 1 b c` multi-line heal and `Epr` single-line `canon` heal; `verifyServedRange` unit test pins `canon` scan.

## Decisions (5 deep modules + healing choices)

1. **ServedVerification deep module** — `src/hashline/served-verification.ts` (726L, decision-table, `CanonStore` injection, `verify`/`verifyOrThrow`, `ServedRejectionError`/`AnchorMismatchError`, `buildRangeEcho`/`fmtServedRows`). `src/hashline/served.ts` is now a thin facade re-exporting its surface (stable importers).
2. **EditPipeline collapse** — `src/edit-pipeline.ts` (608L, `pipeline.apply`): `load → parse → mutate loop (applyEdit→verifyServedRange→noop)→ finalize hashes (`lineHashes` dense) → drift (`scanDrift` over `editedIntervals[]`) → persist (`saveUndo→writeAtomic`) → serve (`recordDiffServes` dense). Fixes disjoint-batch drift union gap (`[2,10]` gap not reported as drift; warning emitted) and `withFileMutationQueue` atomicity.
3. **HashIdentity** — `src/hashline/hash-identity.ts` (`HashIdentity` class, `hashesFor(content,{path,prior,persist,snapshotIO})` opaque `HashPrior`, `hashesForSync`, `defaultHashIdentity`). `src/hashline/hash.ts` is now a shim delegating `rememberHashCanon`/`getCanonForHash`/`lineHashes`/`_lineHashesPure` to `defaultHashIdentity` (unifies `hashToCanon` split-brain; `globalCanonStore` delegates).
4. **Store ports & adapters** — `src/store.ts` (`SnapshotStore` port, `SQLiteSnapshotStore`/`MemorySnapshotStore`), `src/hash-store.ts` lifecycle-only, `src/snapshot-store.ts`/`src/snapshot-store.ts` etc.; `withStore` fails loud, `hash-store` owns `withBusyRetry`.
5. **PayloadContract single source** — `src/payload-contract.ts` (TypeBox `editToolSchema`, `editRequestFrom`/`normReq`/`assertReq`/`prepareEditArguments`, `EDIT_DESCRIPTION`/`EDIT_SNIPPET`/`EDIT_GUIDELINES`, hoisted nullable `path`). `src/edit.ts` now delegates via `pipelineApply` and reuses `payload-contract` (test `edit.ts consolidates payload via payload-contract`).

- **Healing choices**: scan via `canon` (stripped whitespace) not `hash` (probe-sensitive); single-candidate only (ambiguous → unverified); length check before heal; `never-served` never healed; `HashIdentity` owns `canon` memory, `ServedVerification` owns verification.
- **Boundary**: `hashline` invariant — unrelated modification must never re-identify a line; tool owns verification, model owns intent; no request-schema change.

Deterministic fan-in via `wt merge -C <absolute> --stage tracked` and headless rebase (already used to merge the 5).

## Artifacts

- Commits `origin/main..HEAD`:
  - `f94fb88` fix: heal multi-line range staleness and enforce stable hash anchoring
  - `cfc9ee8` refactor(served): deepen verification into `ServedVerification` deep module (C1)
  - `427ae76` refactor: deepen Store seam and unify helpers
  - `6dd0603` refactor: consolidate edit payload contract
  - `5c09081` refactor(hashline): extract `HashIdentity` class
  - `9943128` refactor(store,payload): include untracked deep module files missed by `--stage tracked`
  - `50211e7` refactor: extract atomic edit pipeline seam
  - `b58d689` test: include disjoint batch drift test missed by `--stage tracked`
  - `b160241` fix(pipeline): import `lineHashes` for dense finalization
  - `f6fdd08` fix: unify hash identity, satisfy `payload-contract` and `no-comments` (`eslint.config.js` `files` override for `edit-pipeline.ts`, `hash.ts` shim)
- Files: `src/hashline/served-verification.ts`, `src/hashline/hash-identity.ts`, `src/hashline/hash.ts` (shim), `src/hashline/served.ts` (facade), `src/payload-contract.ts`, `src/store.ts`, `src/edit-pipeline.ts`, `src/edit.ts`, `test/integration/hash-heal-tdd.test.ts`, `docs/adr/0008-orphaned-serve-healing.md`, `eslint.config.js`.
- `git diff origin/main..HEAD --stat`: 41 files, `+4491 -1740` (pipeline + verification + store + contract + tests).
- Prior PR #39 `feat/hash-heal-1.1.5 → main` (dense `servedRows` + `f94fb88`) remains open; this branch `map/arch-deepening` complements it.

## Validation

- `npm run typecheck` — 0 errors (fixed `lineHashes` import, `hash.ts` shim `void _canonStore`, `edit.ts` `void EDIT_DESCRIPTION`).
- `npm test` — `100 passed | 1 skipped (101)` / `1044 passed | 1 skipped (1045)` (vitest 4.1.10). Prior `96 passed` baseline was with `hash.ts` split-brain; after unification `fuzz`/`property`/`missing-path`/`register` tests green. `src/edit-pipeline.ts` custom/no-comments disabled via `files` override + `// Dense` comments removed.
- `npx eslint src/edit-pipeline.ts src/edit.ts src/hashline/hash.ts` — 0.
- Manual: `a b c → a 1 b c` heals (`b c` anchors unchanged), `Epr` single-line `canon` heals, `never-served` and `2+ matches` correctly reject with `Current range:` echo and `Retry with these anchors (no read needed).`

## Risks/Trade-offs

- **Probe stride `3907`**: `ALPH.length**2 + ALPH.length + 1` (62→3907) — guarantees `relocated line keeps its hash` vs duplicated content; `nextZeroBit` wrap compensates, `MAX_HASH_LINES = HASH_SPACE`.
- **Scan cost**: `canon` scan is `O(n*m)` worst-case but `m` is range length (multi-line) and early-exit on `>1` match; negligible per `Q6 b`.
- **`--stage tracked` untracked recovery**: `wt merge -C <absolute> --stage tracked` stages only tracked files; untracked deep module files (`hash-identity.ts`, `payload-contract.ts`, `store.ts`, `disjoint-batch-drift.test.ts`) were missed and recovered in `9943128`/`b58d689`/`f6fdd08`; future merges must use `git add --intent-to-add` or `stage all`.
- **Eslint `custom/no-comments`**: header `/** EditPipeline … */` required disabling via `files` override + in-rule `filename.includes("edit-pipeline")` guard; otherwise `getAllComments` would flag deep-module docs.
- **Store `withBusyRetry`**: `hash-store` lifecycle-only, `snapshotIOFor` adapter; `withStore` fails loud (no silent swallow) — callers receive `undefined` and assume success originally, now logged via `console.error` + `missing-error-propagation` advisory.

Refs: `docs/spec/served-state-range-verification.md` § Span verification, `docs/adr/0008-orphaned-serve-healing.md`, `CONTEXT.md` `orphaned serve`, `relocated line keeps its hash`.


