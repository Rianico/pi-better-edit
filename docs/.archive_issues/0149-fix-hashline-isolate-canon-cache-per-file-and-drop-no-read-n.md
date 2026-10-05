# fix(hashline): isolate canon cache per file and drop (no read needed) retry hint

> **Archived from pre-migration issue #149.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-20T15:48:49Z · state CLOSED · labels: released

## Body

## Problem

### 1. Cross-file 4-character anchor hash collision poisons process-global canon cache
In `src/hashline/hash-identity.ts`, `defaultHashIdentity` maintains an in-memory `hashToCanon` map (`Map<string, string>`) that keys strictly on the 4-character anchor hash without any file path or session scoping:
```ts
rememberHashCanon(hash: string, canonText: string): void {
  if (!this.hashToCanon.has(hash)) this.hashToCanon.set(hash, canonText);
}
```
Because 4 characters yield 62^4 = 14,776,336 slots, collisions across different files in a repo remain likely enough to poison an unscoped map.
When file A (e.g. `src/hashline/apply.ts`) hashes a line to `FU6`, `FU6 -> "}=verification??{};"` is locked into the global map.
When file B (e.g. `test/tools/lifecycle-hooks.test.ts`) has a line `clearServedRefusals(absolutePath);` that also hashes to `FU6`, `rememberHashCanon` ignores it.

Later, when an edit commits on file B, `src/mutation-engine/pipeline.ts` calls `recordDiff(denseRows, ...)` where `denseRows` contains only `{ position, hash }` without the corresponding file line canons.
In `src/served-session/session.ts`:
```ts
const cv = row.hash ? (globalCanonStore.get(row.hash) ?? null) : null;
updatedCanons[row.position] = cv;
```
`session.ts` falls back to `globalCanonStore.get("FU6")`, pulling file A's canon and storing it into file B's persisted SQLite `canons` row!
When file B is next edited, `verifyServedRange` in `src/hashline/served-verification.ts` compares disk content against `servedCanons` and rejects with a false-positive `[E_STALE_RANGE]`:
```text
[MODEL] [E_STALE_RANGE] line 260 in test/tools/lifecycle-hooks.test.ts differs from what was served (expected "}=verification??{};" vs actual "clearServedRefusals(absolutePath);").
```

### 2. Misleading `Retry with these anchors (no read needed).` causes LLM retry loops
In `src/domain-errors.ts`, `E_STALE_RANGE` formats with:
```ts
const RETRY_HINT = "Retry with these anchors (no read needed).";
```
Telling the model `no read needed` gives false confidence and traps agents in blind retry loops. When the anchor or canon is stale/poisoned, retrying with the same anchors immediately fails with the identical error.

## Required Fix

1. **Isolate canon lookup by file**:
   - Ensure `pipeline.ts` passes actual line canons or file lines into `recordDiff`, so `session.ts` does not fall back to an un-scoped `globalCanonStore`.
   - Scope `HashIdentity` / `globalCanonStore` by file path or eliminate process-global un-scoped `hashToCanon` mappings.
2. **Improve `E_STALE_RANGE` diagnostic**:
   - Remove the `(no read needed)` retry mandate.
   - Show the latest view (`Current range (fresh read):` similar to `E_UNVERIFIED_RANGE`) so the model can inspect the current state on disk and make an informed retry.

## Comments

### @Rianico — 2026-09-21T02:04:10Z

Implemented on `dev/stale-range` (`1070328`), pushed to `origin`. Not yet PR'd/merged — leaving this open until it lands.

### 1. Canon lookup is file-scoped; the un-scoped map is gone

A 4-char anchor is unique only inside one file's hash allocation, so the process-global `hash -> canon` map was unsound by construction. Rather than scope it by path, it is deleted — its only production readers were the buggy fallback and a drift heuristic; `ServedVerification.ensureCanonsPopulated` *wrote* the map and never read it back.

- `ServedRow` / `ServedEntry` gain an optional `canon`, stamped by every producer that holds the file's lines: edit-pipeline dense rows (`pipeline.ts`), `edit-response.ts` success/batch rows, rejection serves (`buildRangeServeRows(..., fileLines)`), `noop-guard`, `drift`, `edit-undo`, and the `write` auto-read in `lifecycle-hooks`.
- `writeServeRecord` persists `row.canon ?? null`; it no longer consults a hash-keyed store. A producer with only hashes records none, and that position degrades to hash-equality verification (the legacy ADR-0005 behavior) instead of claiming a file-blind canon.
- Removed: `CanonStore`, `createCanonStore`, `globalCanonStore`, `HashIdentity.hashToCanon` / `rememberHashCanon` / `getCanonForHash` / `clearCanon` / `canonEntries`, `ServedVerification`'s write-only store field and `ensureCanonsPopulated`, the `canonStore` params on `verifyServedRange` / `verifyServedRangeResult`, and `_lineHashesPure`'s store param. `drift` reads only `servedCanons[servedPos]`.

Regression test (`test/core/serve-recording.test.ts` -> "scopes served canons per file when two files share one 3-char anchor (#149)" as measured at `47a04f7`): two files recorded under one anchor string each keep their own canon. On the pre-fix code it reads back file A's line — verified by stashing `src/` and re-running:

```
AssertionError: expected [ '}=verification??{};' ] to deeply equal [ 'clearServedRefusals(absolutePath);' ]
```

### 2. `[E_STALE_RANGE]` serves a fresh read, no `(no read needed)` mandate

Format is now `${headline}\nCurrent range (fresh read):\n${servedBlock}` — the same heading as `[E_UNVERIFIED_RANGE]` — and the `remedy` field is gone, so the code joins the remedy-free set by rule (the evidence pins that served state and disk disagree, not that the same anchors are the right retry). `[E_STALE_ANCHOR]` keeps `Current range:` + the hint: there the served rows *are* the retry.

Contract updates: `test/arch/remedy-eligibility.test.ts` (`REMEDY_FREE` now names `E_STALE_RANGE`, both directions), `test/arch/domain-error-registry.test.ts` (fresh read, no retry hint, no remedy), and `test/arch/rejection-payload-region.test.ts` (range-family codes share the fresh-read shape; new negative control plants a retry hint on a stale-range payload and asserts the oracle fails it). The oracle's substance — rows must reproduce the current on-disk hashes and stay in the caller-named live window, never placed by a content lookup — is unchanged.

### ADR conflict (flagged, not silently overridden)

This amends **ADR-0018 decision 4** (its oracle pinned `Current range:` + retry hint for every non-unverified row-carrying payload) and **ADR-0021 decision 4** (remedy-free enumeration). Recorded as `docs/adr/0022-file-scoped-canons-and-fresh-read-stale-range.md` with reciprocal `Amended by` links; `CONTEXT.md`, `README.md` and `docs/spec/unified-error-and-warning-contract.md` section 3.2 updated to match.

### Verification

`pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` -> all green (`1517 passed | 1 skipped`, coverage 91.3 / 85.3 / 92.2 / 92.4 against 85 / 85 / 85 / 80 thresholds). `npx commitlint --from=origin/main --to=HEAD` -> 0 problems.

Commits: `2469e74` fix + tests · `35de4bf` docs + ADR-0022 · `1070328` changelog sync.


### @github-actions — 2026-09-21T16:47:36Z

:tada: This issue has been resolved in version 2.0.0 :tada:

The release is available on [GitHub release](https://github.com/Rianico/pi-better-edit/releases/tag/v2.0.0)

Your **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:
