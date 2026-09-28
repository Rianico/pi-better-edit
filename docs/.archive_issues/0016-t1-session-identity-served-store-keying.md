# T1 — Session identity + served-store keying

> **Archived from pre-migration issue #16.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-12T12:19:07Z · state CLOSED · labels: ready-for-agent

## Body

## Parent

#15 — Architecture: session-keyed served-state isolation (spec)

## What to build

The served table becomes session-partitioned: every row gains a `session_id`, the key becomes `(session_id, path)`, and every served-state operation takes an explicit session key. Session identity comes from the pi `ExtensionContext` (`ctx.sessionManager.getSessionId()`), never from `process.env.PI_SESSION_ID`. The `session_start` wipe is removed (fresh sessions have no own rows; a continued session keeps its rows). Observable behavior within one session is byte-identical.

Follow `docs/spec/session-keyed-served-state.md` and `docs/adr/0002-session-keyed-served-state.md` (committed `16e17c5`). Grounding facts verified empirically in the spec: session ids are unique per process and stable across `pi -c`; the event/tool ctx exposes `sessionManager`.

## Acceptance criteria

- [ ] Schema: `served(session_id TEXT NOT NULL, path TEXT NOT NULL, hashes TEXT NOT NULL, reported TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, path))`; `HASH_STORE_VERSION` bumped so the existing version gate rebuilds on upgrade.
- [ ] Statements (`hash-store.ts`): `servedGet(session, path)`, `servedUpsert(session, path, hashes, updated_at)`, `servedReportedUpsert(session, path, '[]', reported, updated_at)`, `servedReportedClear(session, updated_at, path)`, `servedDelete(session, path)`, `servedWipe(session)` → `DELETE FROM served WHERE session_id = ?`. `allStmt` (pruneMissingAll) unchanged.
- [ ] `sessionKeyFor(ctx)` helper: `ctx.sessionManager?.getSessionId() ?? crypto.randomUUID()`; no call site reads `process.env`.
- [ ] Every served-store function takes an explicit `sessionKey` first param — `getServed`, `upsertServed`, `recordServes`, `getReported`, `addReported`, `clearReported`, `deleteServed`, `wipeServed`, and the async facades `loadServed`, `recordServed`, `driftReported`, `markDriftReported`, `clearDriftReported`, `wipeServedState`.
- [ ] Call sites updated: `index.ts` `session_start` drops `wipeServedState()` (keeps `pruneMissingAll`); `index.ts` `tool_result` (write auto-read + edit/undo diff serves) passes `sessionKeyFor(ctx)`; `read.ts` passes it; `edit.ts` passes it to `loadServed` and threads it into `recordEchoServes`; `drift.ts` passes it; `hashline/served.ts` `recordEchoServes(session, path, rows)`.
- [ ] Unit tests at the store seam with literal keys: two sessions recording the same path stay independent; `wipeServed(sessionA)` does not clear session B's rows; reported sets are per-session; a fresh session sees no rows. Update any existing served-store tests that assumed the global shape.
- [ ] Full suite green (929 passed + 1 skipped, or the current baseline) and `npm run eval:compare` reproduces local 19/19 / 2.4.1 14/19 / 2.5.0 18/19 — no observable-behavior change.

## Blocked by

None — can start immediately.


## Comments

### @Rianico — 2026-08-12T12:40:07Z

Verified by parent: typecheck clean, lint clean, suite 936 passed + 1 skipped (7 new isolation tests), eval battery 19/19 / 14/19 / 18/19 unchanged. Committed 54a10a5.
