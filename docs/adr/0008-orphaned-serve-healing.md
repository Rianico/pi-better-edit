# Orphaned serves: eager heal and content-disambiguated verification

Date: 2026-08-20

## Status

accepted

## Context

Orphaned serves accumulated when an external write relocated a line that kept its hash and a subsequent partial re-serve (paged read, echo) wrote the same hash at the new position without nulling the old one. The next `edit` saw `servedPositionsOf(hash) === 2` and failed closed with `E_UNSERVED_RANGE`, and the promise of `reject-and-serve` ("retry with these anchors, no read needed") re-served the current range without healing the stale slot — a self-reinforcing loop. Widening the range could not target the stale position blindly.

## Decision

We decided to heal eagerly at the served-state layer and disambiguate lazily at verification, both silently.

### Considered Options

- **Hash-layer detection (re-hash or re-probe on collision with served state)** — rejected: `hash.ts` is pure (content → hash, no I/O, no session). Making it read SQLite on every `lineHashes()` call couples the file invariant (perfect hashing, unique per file) to the session-indexed mirror and adds I/O to the read hot path. Hash uniqueness stays a file property; the mirror is where the duplicate lives.
- **Eager heal only in `patchServed` (null old position when same hash is written at new position)** — would prevent duplicates from persisting after the healing serve, but leaves already-stored duplicates in the DB to fail again on the next verification.
- **Lazy disambiguation only in `verifyServedRange` (enumerate candidate spans where `served[candFrom+k] === fileHashes[startLine-1+k]` and `len === currentLen`, pick closest to current position)** — fixes already-stored duplicates, but leaves the DB dirty between calls, so every future verification still enumerates candidates.
- **Eager heal + lazy disambiguation (chosen)** — `patchServed` nulls the stale position on the next write of the same hash (O(n) scan per patch, no extra I/O), and `verifyServedRange` enumerates content-matching candidates as a fallback for orphans already in the DB. The two reinforce: new orphans never persist, old orphans are still recoverable.
- **Surface healing as model-visible drift** — extend `drift notice` or add `E_REPEATED_ANCHOR` / `E_ORPHANED_SERVE`. Rejected for the single-valid-survives case: hash anchors are position-independent, so an external shift far from the model's intended range is irrelevant to its next edit — the tool correctly resolves `BSQ` via the current `hashIndex`. Surfacing would be noise. Both-valid candidates (genuine ambiguity) would still be drift, but that case is already covered by the existing once-per-episode drift notice if the healed orphan is reported through `scanDrift`'s reported set. A hard reject-and-serve with healed anchors would reintroduce the non-terminating loop.
- **Wipe entire served row on any hash collision / full re-read as heal** — forces the "full re-read ritual" ADR-0001 forbids. Reads are position-specific by design; healing is per-row, not per-file.

## Consequences

- `hash.ts` stays pure; no DB access from the hashing layer. The file's perfect-hashing invariant (same content at two positions → two different hashes) is unchanged; "relocated line keeps its hash" remains the file condition, "orphaning re-serve" (re-serving the same hash at newPos without clearing oldPos) the mirror event.
- `patchServed` now scans `updated` for `hash` at `i != newPos` and nulls it before writing. The next partial re-read that would have created `Wot@0, Wot@2` leaves `[X, Y, Wot]`. No extra I/O; the existing `updated` array is already in memory.
- `verifyServedRange` no longer fails closed on `length !== 1`. It builds `currentLen`, enumerates `(s,e)` pairs with matching length and content equality against `fileHashes`, and picks the span closest to `startLine-1` when multiple survive. Zero candidates → original `E_UNSERVED_RANGE`; single → use it (stale-vs-valid disambiguation); multiple → closest. Exterior shifts (both endpoints move together) keep `currentLen` invariant and pass via content match; interior inserts/deletes still fail on length/content mismatch. The healed-orphan case is silent — no drift row, no warning — because the mirror was repaired and the edit's intent is unambiguous.
- Tests: `served-edge-cases` "fail-safes with E_UNSERVED_RANGE when duplicate" renamed to "recovers from a stale duplicate by disambiguating" expecting `Successfully edited`; `served-store` truncation test now expects `[null,"ddd","eee","bbb","fff"]` (eager heal nulls the earlier duplicate on the same patch). All 1006 tests pass.
- Glossary: `orphaned serve`, `orphaning re-serve`, and `relocated line keeps its hash` added to `CONTEXT.md` to distinguish duplicated content (two hashes) from duplicated mirror entries (one hash, two positions).

## Amendment 2026-08-26 — Deepen served verification into ServedVerification (C1)

### Context

`src/hashline/served.ts:92-372` carried 280 lines of healing with complexity 92 / fanout 35; `verifyServedRange` was interface ≈ impl — callers (edit.ts via apply → verify) leaked served/fileHashes/fileLines wiring and healing details, and `hashToCanon` was process-global mutable, order-dependent. Candidate C1 asks to deepen this verification boundary into a single module without touching other candidates' seams (edit pipeline, stores, payload).

### Decision

- Extract **`src/hashline/served-verification.ts`** as the deep `ServedVerification` module. Interface: `verify(range: {startHash,endHash,startLine,endLine}, served, fileHashes, fileLines, filePath?) => {ok} | {code, servedRows, echo}` (also throwing `verifyOrThrow` for compat). Implementation absorbs: span resolve (`servedPositionsOf` + candidate enumeration with exact hash equality and `currentLen` filter, closest-to-`startLine` disambiguation), single-candidate canon scan (`canon(fileLines)` + `store.get(hash)`), orphaning re-serve healing (single vs duplicate), length-mismatch healing via canon uniqueness scan, echo building (`buildRangeEcho`/`fmtServedRows`/`paginationHint`/`retryHint`), and `E_RANGE_*` branching via an explicit decision table (unverified → stale → never-served → length → hash mismatch). Healing paths remain exactly as in the original 280-line function; only decomposition changed.

- **CanonStore instance scope.** Replace the global `hashToCanon: Map<string,string>` dependency with an injected `CanonStore {get, set}`. Production `ServedVerification` defaults to `globalCanonStore` (delegates to `rememberHashCanon`/`getCanonForHash`), preserving file-global accumulation from `lineHashes`/`mapStableHashes`. Tests inject `createCanonStore()` (isolated `Map`) plus adapters `createCanonStoreFromEntries`, `__clearGlobalCanonStoreForTest`, `__globalCanonEntriesForTest`, and in-memory `served: (string|null)[]` arrays — no DB or file I/O needed. `hash.ts` now exports `CanonStore`, `createCanonStore`, `globalCanonStore`, and `_lineHashesPure`/`mapStableHashes`/`lineHashes` accept an optional `canonStore` (defaults to global) so callers can thread an isolated store without changing hashing invariants.

- **`src/hashline/served.ts` becomes a thin facade** (≈35 lines) re-exporting `ServedVerification`, `verifyServedRange`, `verifyServedRangeResult`, `ServedRejectionError`, `AnchorMismatchError`, `buildRangeEcho`, `fmtServedRows`, `servedPositionsOf`, and `CanonStore` adapters. No healing logic remains there; fanout drops to 1 (facade → verification). Existing importers (`from "./served"`) keep working with identical error identity (class is now defined in served-verification and re-exported, so `instanceof` stays sound).

- **CONTEXT.md terms unchanged** — serve, served state, served span, range staleness, never-served, reject-and-serve, drift, orphaned serve, orphaning re-serve, relocated line keeps its hash all preserved.

- **Tests.** New `test/core/served-verification.test.ts` exercises the deep module directly with injected stores: unique fast-path, duplicate positions → `E_UNSERVED_RANGE` (with duplicate hint), single-candidate canon heal `a b c → a 1 b c`, never-served gap → `E_UNSERVED_RANGE`, `E_STALE_RANGE` length mismatch without unique heal, interior drift → `E_STALE_RANGE` line number, pagination cap (`SERVED_ECHO_CAP=150` with `[... more — read offset=…]`), store isolation (no cross-pollution), and facade `verifyServedRange` throwing path. Existing integration suites (`served-range-verification`, `hash-heal-tdd`, `served-edge-cases`) continue to pass (1019 tests).

### Consequences

- Verification is now a coherent module with low per-method cyclomatic complexity (each private method <12) versus the previous monolithic 92; callers no longer duplicate healing concerns.
- Global mutable `hashToCanon` order-dependence is contained: production still accumulates globally via `globalCanonStore`, but tests and any future caller can isolate via `createCanonStore`. This does not change the file's perfect-hashing invariant; it only scopes the canon→hash mirror used for healing.
- Healing semantics are unchanged — this amendment is a structural deepening, not a behavioral change — so no new drift or rejection codes are introduced.
