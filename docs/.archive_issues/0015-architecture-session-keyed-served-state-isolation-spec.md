# Architecture: session-keyed served-state isolation (spec)

> **Archived from pre-migration issue #15.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-12T12:18:45Z · state CLOSED · labels: ready-for-agent

## Body

## Problem Statement

The served-state store is a **global single namespace** (one row per path) with a **full-table wipe at every session start**. Every pi process that loads the extension — main session, every sub-agent (`context: fresh` or `fork`), every nested `pi -p` run — fires `session_start` → `wipeServedState()`, destroying every other process's served record. Verified empirically: after any pi process starts, the store holds only that process's reads. Symptom: the main model edits with anchors it was served and gets `[E_RANGE_UNVERIFIED]` because a sub-agent's `session_start` wiped the record mid-work. Separately, `pi -c` reuses the **same session id** (verified) but the new process wipes the table at start, so the continued model cannot verify edits against content read before the restart.

Served state's fact authority is *what this session's model context has been shown* — inherently session-private; the store models it as a global namespace.

## Solution

Partition the served table by session id (`(session_id, path)`); scope every served-state operation to the session's own rows; **remove the session-start wipe**; GC via TTL sweep on store open (no shutdown delete, so `pi -c` continuity holds). Session identity: `ctx.sessionManager.getSessionId()` — never `process.env.PI_SESSION_ID` (a nested pi inherits the parent's value via bash spawn env; verified). Undo and snapshots stay global (ADR-0002).

## Spec

`docs/spec/session-keyed-served-state.md` (committed `16e17c5`), decision record `docs/adr/0002-session-keyed-served-state.md`.

Key implementation decisions:

- Schema: `served(session_id TEXT NOT NULL, path TEXT NOT NULL, hashes, reported, updated_at, PRIMARY KEY (session_id, path))`; bump `HASH_STORE_VERSION` (existing gate rebuilds).
- Statements gain a session param; `servedWipe` → `DELETE WHERE session_id = ?`; new `servedPruneOlderThan(cutoff)`.
- `sessionKeyFor(ctx)` helper → `ctx.sessionManager?.getSessionId() ?? crypto.randomUUID()`.
- Every served-store function takes an explicit `sessionKey` (pure seam, literal keys in tests).
- Call sites: `index.ts` session_start drops the wipe (keeps `pruneMissingAll`); tool_result (write auto-read, edit diff) passes the key; read.ts, edit.ts (→ `recordEchoServes`), drift.ts pass the key.
- GC: `SERVED_TTL_MS` (7 days) sweep in `openStore`, busy-retried.

## Empirical verification (already done)

- Session ids are globally unique and stable per process (main `019fefb8…`, fresh sub-agent `019ff5dc…`, fork sub-agent `019ff5dd…`, nested pi `019ff5d7…`).
- `pi -c` keeps the same session id and session file; fires `session_start` with `reason=startup`.
- `process.env.PI_SESSION_ID` inside an extension process is unreliable (inherited from parent).
- Every process start wipes the shared served table (store left empty after a sub-agent ran).

## Tickets

- #16 T1 — Session identity + served-store keying (schema, statements, facade, call sites, remove wipe, unit tests)
- #17 T2 — Per-session GC + `pi -c` continuity (TTL sweep, no shutdown delete, continuity proof incl. runtime edge)


## Comments

### @Rianico — 2026-08-16T04:08:36Z

Implemented. Children #16 (T1 session identity + served-store keying) and #17 (T2 per-session GC + pi -c continuity) are merged; served state is keyed by (session, path) per ADR-0002 (accepted) and swept by SERVED_TTL_MS on store open.
