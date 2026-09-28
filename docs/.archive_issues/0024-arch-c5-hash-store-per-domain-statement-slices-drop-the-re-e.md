# Arch C5: hash-store per-domain statement slices — drop the re-export facade

> **Archived from pre-migration issue #24.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-15T03:47:42Z · state CLOSED · labels: ready-for-agent

## Body

Part of #20

Blocked by: C1 ticket (hash.ts must stop importing `getSnapshot`/`upsertSnapshot`/`loadHashStore` from `../hash-store` before the re-export can be dropped).

## Goal
Turn `src/hash-store.ts` from a god-hub into a narrow lifecycle seam. The issue-#14 split produced three domain stores, but the seam's interface is as large as what it hides: one ~20-statement `Prepared` interface spanning all three domains, plus a re-export of all three stores while they import back from it — a module-level cycle with two import paths to the same functions.

## Friction (why)
- `src/hash-store.ts`'s `Prepared` interface enumerates every statement for every table (snapshots: get/allPaths/allHashes/deleteOne/upsert; undo: undoUpsert/undoGet/undoDelete; served: servedGet/servedUpsert/servedReportedUpsert/servedReportedClear/servedDelete/servedDeletePath/servedWipe/servedPruneOlderThan). The domain stores are thin JSON-mapping wrappers over this single god-interface — each store sees the whole schema.
- `hash-store.ts` re-exports all three domains (`export { ... } from "./snapshot-store" / "./served-store" / "./undo-store"`) while those modules import `loadHashStore`/`withStore`/`HashStore` from it. Verified cycle: hash-store <-> snapshot-store (via `isValidSnapshot`), hash-store <-> served-store, hash-store <-> undo-store. Two import paths exist to the same functions.
- `migrateLegacy` (legacy JSON store) and schema/versioning live in the hub.

The lifecycle logic itself (corruption quarantine, busy retry, WAL, version migration, TTL sweep, caching, transactions) is deep and correctly concentrated — keep it.

## Solution
- Hand each store only its own statement slice (per-table `Prepared` slices), so each store owns its schema's statements.
- Drop the re-export facade: one import path per domain (callers import the domain store directly).
- Keep `pruneMissing`'s cross-table delete (it is the TTL/GC policy — deliberate).
- Keep `isValidSnapshot` where it belongs (snapshot-store), breaking the hash-store <-> snapshot-store cycle.

## Files
`src/hash-store.ts`, `src/snapshot-store.ts`, `src/served-store.ts`, `src/undo-store.ts`, callers of the hash-store re-exports (index.ts, edit.ts, batch-edit.ts, read.ts, edit-undo.ts, drift.ts).

## Acceptance
- Module graph: no import cycle between hash-store and the domain stores (`npx madge --circular src` or the module report shows none).
- One import path per domain: nothing imports served/snapshot/undo functions from `./hash-store`.
- `npm run typecheck && npm run lint && npm test` green; `test/core/hash-store*.test.ts`, `test/core/served-store.test.ts`, `test/core/snapshot-store.test.ts`, `test/core/undo-store.test.ts` pass.

## Constraints
ADR-0002 semantics unchanged: session-keyed served rows, global undo/snapshots, TTL sweep on open.


## Comments

### @Rianico — 2026-08-15T05:39:34Z

Done — merged to main as 2cea04f (wt merge, squash). hash-store is a narrow lifecycle seam ({ db, engine } + onStoreOpen hook registry); snapshot/served/undo stores own their statement slices (WeakMap-cached per db); re-export facade and served-store bridge deleted; isValidHashList moved to pure hashline; madge reports no cycles; 997 tests pass, coverage 93.1/93.89/92.94/88.56.
