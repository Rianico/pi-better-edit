# E_RANGE_UNVERIFIED: rejection-echo and drift serves don't truncate the served tail after a shrinking external write

> **Archived from pre-migration issue #27.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-15T06:17:24Z · state CLOSED · labels: ready-for-agent

## Body

## Bug: "was served at 2 positions" returns after an external shrink

**Severity:** correctness — a line edit fails with `[E_RANGE_UNVERIFIED] ... was served at 2 positions` and stays failing until a fresh whole-file `read`.

### Symptom
1. `read` an 8-line file (served-state holds positions 0-7).
2. The file is shrunk to 2 lines by a path that does **not** fire this extension's truncating serve hooks — e.g. pi's built-in `replace` tool, a `bash` write, or another agent/tool editing the file (the plugin only shadows `read`/`read_skill`/`edit`/`batch_edit`/`undo_last_edit`, and the `tool_result` truncation only runs for `write`/`edit`/`batch_edit`/`undo_last_edit`).
3. An edit attempt on a stale anchor gets rejected (E_RANGE_STALE etc.) → the rejection echo is recorded via `recordEchoServes` → `recordServed` (**non-truncating**).
4. The surviving lines now appear at **two** served positions (their current one and the stale pre-shrink one). Every subsequent boundary-anchor edit on those lines fails with `E_RANGE_UNVERIFIED` until the model does a fresh `read`.

The same stale tail can be re-seeded by `scanDrift` (`src/drift.ts` → `recordServed`), the drift-notice path.

### Root cause
Commit `25ed5f0` ("truncate served-state to the post-mutation line count when recording serves") fixed the read / write auto-read / post-edit diff / post-batch diff serve sites by routing them through `recordServesTruncated`/`recordDiffServes`, which truncate the stored array to the file's current line count before upserting.

Two serve sites were **missed** and still call the non-truncating `recordServed`:
- `src/served-state.ts` → `recordEchoServes` (policy `"live"`), called from:
  - `src/edit-pipeline.ts` (rejection echo in `applyOneEdit`)
  - `src/noop-guard.ts` (noop-loop rejection echo)
- `src/drift.ts` → `scanDrift` records drift rows via `recordServed`.

So a file shrink through a non-shadowed tool (built-in `replace`, bash, another agent) followed by a rejection or drift notice re-creates the exact pre-`25ed5f0` state: the stored served array keeps the old tail, and a surviving line's hash lands at its old position (stale tail) **and** its new position.

### Reproduction (fails today)
```ts
// serve 8 lines, then echo-serve the current 2 lines after an external shrink
await recordServed(key, p, [...positions 0..7 ...]);
await writeFile(p, "f\ng\n");                       // external shrink, no hashline hook
await recordEchoServes(key, p, [{position:0,hash:"fff"},{position:1,hash:"ggg"}], "live");
// getServed(store,key,p) => ["fff","ggg","ccc","ddd","eee","fff","ggg","hhh"]
// "fff" at positions [0,5] and "ggg" at [1,6] → next edit: "was served at 2 positions"
```
Verified against `HEAD` (c0c4ee0) with the real `recordEchoServes` function.

### Expected fix
Thread the current line count into the two missed sites and truncate before recording, mirroring `25ed5f0`'s approach:
- `recordEchoServes` should take/derive the current line count and record via `recordServesTruncated` (or the callers pass the count through, like the dsh port `dsh-better-edit` 0.1.4 did — its fix threaded counts through "all rejection-echo sites" and "drift rows").
- `scanDrift` should record via `recordServedTruncated` using `resultLines.length` (and the appropriate `clearFrom`).
- Add regression tests: serve an 8-line file, shrink externally, run a rejection echo (and a drift notice), assert no hash is served at >1 position, and assert a subsequent anchored edit succeeds (or at least no `E_RANGE_UNVERIFIED` from duplicates).

### Acceptance
- `npm run typecheck && npm test` green (currently 997 passing).
- New regression tests fail on the current code and pass after the fix.
- No behavior change for the already-fixed paths (read / write auto-read / post-edit / post-batch diff).


## Comments

### @Rianico — 2026-08-15T06:33:45Z

Fixed in `abd8372` on `main`.

**Changes:**
- `recordEchoServes` now accepts an optional `lineCount` and records through the truncating `recordServedTruncated` (truncate-only, no `clearFrom`) when the count is known; plain `recordServed` remains the fallback.
- The rejection-echo caller in `src/edit-pipeline.ts` (`applyOneEdit`) passes `input.hashes.length`.
- The noop-loop echo caller in `src/noop-guard.ts` passes `input.hashes.length`.
- `scanDrift` in `src/drift.ts` records drift rows via `recordServedTruncated` with `resultLines.length` instead of the non-truncating `recordServed`.

**Regression tests added:**
- `test/core/serve-recording.test.ts`: `recordEchoServes` truncation to the current line count (reproduces the exact "fff at [0,5]" duplicate), plain-recording fallback, and `scanDrift` truncation.
- `test/integration/served-truncation-external-shrink.test.ts`: full tool-seam scenario — read an 8-line file, external shrink to `f\ng` via a non-shadowed path, stale-anchor edit rejection, asserts no hash is served at >1 position.

**Validation:** `npm run typecheck` clean, `npm run lint` clean, full suite 1001 passed / 1 skipped (was 997 before). All three new regression tests fail on the pre-fix code and pass after.


### @Rianico — 2026-08-15T06:33:52Z

Resolved by abd8372 (main).
