# refactor(served-session): share canon sync and drop the undo schema middle man

> **Archived from pre-migration issue #103.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T16:13:44Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

Two independent smells: duplication in the serve-recording seam and a pure-forwarder function.

## 1. Duplicated code - `src/served-session/session.ts` L581-598 and L633-654
`recordServesInner` and `recordServesTruncatedInner` duplicate the same three steps verbatim: canon synchronization, displaced-hash extraction, and lease granting.

```ts
const currentCanons = getCanonsInner(store, sessionKey, path);
const updatedCanons = currentCanons.slice();
...
servedStmts(store.db).servedCanonsUpsert(sessionKey, path, JSON.stringify(updatedCanons), Date.now());
```

**Remedy**: extract one shared helper covering canon synchronization plus lease granting, and have both serve paths call it. The truncated path keeps only its genuinely different behaviour (the truncated/drift-notice rows and their `reported` bookkeeping).

## 2. Middle man - `src/undo-store.ts` L72-76
`ensureUndoSchema(db)` is a pure forwarder that delegates straight to `ensureFileUndoSchema(db)`.

**Remedy**: call `ensureFileUndoSchema(db)` directly at every call site and delete the wrapper (updating imports/exports).

## Acceptance criteria
- The canon-sync + lease-grant block exists once; both `recordServesInner` and `recordServesTruncatedInner` delegate to it, and their remaining differences are only the behaviours that genuinely differ.
- `ensureUndoSchema` is gone and every former call site calls `ensureFileUndoSchema` directly; no re-export kept for compatibility.
- Behaviour is unchanged: serve-recording, drift-notice dedup (`reported`), truncated-serve and lease upsert tests all pass without weakened assertions.
- The 15 Stage-0 probes stay green.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:09Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
