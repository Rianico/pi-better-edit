# T2 — Per-session GC + pi -c continuity

> **Archived from pre-migration issue #17.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-12T12:19:09Z · state CLOSED · labels: ready-for-agent

## Body

## Parent

#15 — Architecture: session-keyed served-state isolation (spec)

## What to build

Per-session GC and `pi -c` continuity on top of the session-keyed served store. No session shutdown delete (that would erase the rows a `pi -c` continuation depends on); instead a TTL sweep on store open for crashed/dead sessions. Prove continuity: the same session key's rows survive a store reopen (simulating `pi -c`, which reuses the session id), and a pi-level runtime scenario shows a second `pi -p -c` process editing a range read by the first process without `[E_RANGE_UNVERIFIED]`.

Follow `docs/spec/session-keyed-served-state.md` (GC section) and `docs/adr/0002-session-keyed-served-state.md`.

## Acceptance criteria

- [ ] `SERVED_TTL_MS` constant (7 days) in `src/constants.ts`; sweep `DELETE FROM served WHERE updated_at < ?` runs in `openStore`, busy-retried like other statements.
- [ ] No `session_shutdown` handler deletes served rows; a comment-free test documents why (continuity).
- [ ] Tests: a row older than TTL is pruned on store open; a fresh row with the same key survives a close/reopen cycle (simulated `pi -c`); a different key's row does not interfere.
- [ ] Runtime edge: `scripts/runtime-edge-test.mjs` gains a `pi -c` continuity scenario — two sequential `pi -p` processes sharing one isolated store (XDG) and session dir: process 1 reads a fixture, process 2 (`-c`) edits it with the process-1 anchors and verifies cleanly (no E_RANGE_UNVERIFIED). The harness-facts summary reports it.
- [ ] Full suite green (929 passed + 1 skipped baseline) and `npm run eval:compare` reproduces local 19/19 / 2.4.1 14/19 / 2.5.0 18/19.

## Blocked by

#16 — T1: Session identity + served-store keying


## Comments

### @Rianico — 2026-08-12T13:30:30Z

Verified by parent: typecheck + lint clean, suite 940 passed + 1 skipped, eval battery 19/19 / 14/19 / 18/19 unchanged, runtime edge PASS incl. new continuity scenario (process-2 pi -c edits process-1-served anchors with no E_RANGE_UNVERIFIED). Committed 0a7f94c.
