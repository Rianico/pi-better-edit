# Arch C1: Restore the hashline purity seam — stop store I/O leaking into hashline/

> **Archived from pre-migration issue #21.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-15T03:47:24Z · state CLOSED · labels: ready-for-agent

## Body

Part of #20

## Goal
Make `src/hashline/` a pure leaf again. Today the "pure hash machinery" pitch is false at the seam: hashline modules reach into the store stack, creating a verified `src <-> hashline` import cycle (19 edges in the module graph, 8 of them layering violations).

## Friction (why)
- `src/hashline/hash.ts` imports `loadHashStore, getSnapshot, upsertSnapshot` from `../hash-store`; `lineHashes` falls back to `store ?? await loadHashStore()` — the hashing module decides persistence policy instead of the caller.
- `src/hashline/served.ts` imports `recordServed` from `../served-state` and exports the *impure* `recordEchoServes` (async store write) next to the pure `verifyServedRange` / `buildRangeEcho` / `fmtServedRows`.
- A reader cannot tell, at the module seam, which exports are pure and which reach into the store; anything importing hashline transitively loads the whole store-open path (quarantine, busy retry, exit handlers).

## Solution
- Inject the store at every call site. `edit.ts` already passes one; `batch-edit.ts` currently passes `undefined` for `lineHashes` (relying on the internal fallback) — load the store once in `processFile`/`executeBatch` and pass it through.
- Move `recordEchoServes` out of `hashline/served.ts` into the served-state surface.
- Result: hashline imports only `../utils` and `../constants`; zero behavior change.

## Files
`src/hashline/hash.ts`, `src/hashline/served.ts`, `src/edit.ts`, `src/batch-edit.ts`, `src/read.ts`, `src/file-reader.ts`, `src/served-state.ts`

## Acceptance
- No module under `src/hashline/` imports from `src/` top-level modules (grep `from "../` inside `src/hashline` — only `../utils`, `../constants` allowed).
- `npm run typecheck && npm run lint && npm test` green; coverage thresholds hold (`test:coverage`).
- No behavior change: existing integration/tools tests pass untouched.

## Constraints
Respect ADR-0001 (model–tool boundary; reject-and-serve; only the tool's own serves count) and ADR-0002 (session-keyed served state). Do NOT change verification semantics.


## Comments

### @Rianico — 2026-08-15T05:02:22Z

Done — commit a11a833 on main (restore hashline purity seam). Verified: hashline no longer imports from the store stack; injected store at call sites; recordEchoServes moved to served-state surface.
