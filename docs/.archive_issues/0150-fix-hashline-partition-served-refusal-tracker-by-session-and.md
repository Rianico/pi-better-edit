# fix(hashline): partition served-refusal tracker by session and prune on reset

> **Archived from pre-migration issue #150.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-20T16:51:36Z · state CLOSED · labels: bug, ready-for-agent

## Body

## What to build
Partition `servedRefusalTracker` in `src/hashline/served-guard.ts` by `sessionKey`, matching the session-isolation pattern established for `noopLoopTracker`. When multiple sessions touch the same workspace or when an agent runs long-lived daemon sessions, repeated `E_SUSPICIOUS_TEXT` refusal counts must never collide across sessions, and empty session maps must be pruned on deletion to prevent memory leakage.

## Acceptance criteria
- [ ] `servedRefusalTracker` is scoped to `sessionKey -> path -> RefusalEntry` rather than a flat `path -> RefusalEntry`.
- [ ] `trackServedEditRefusal` and `trackServedWriteRefusal` accept `sessionKey: string` and track attempts strictly within that session.
- [ ] `clearServedRefusals` accepts `sessionKey: string` and `path: string`, deleting the path entry and pruning the parent session map if empty.
- [ ] Post-commit hook in `src/mutation-engine/pipeline.ts` and auto-read in `src/lifecycle-hooks/index.ts` pass the current `sessionKey` to `clearServedRefusals`.
- [ ] Unit/arch test proves that repeated suspicious edits in Session A do not escalate the refusal count in Session B for the same path.
- [ ] All tests pass and coverage remains above repo thresholds.

## Blocked by
- None (can start immediately).

## Comments

### @Rianico — 2026-09-21T04:14:01Z

Resolved by #153 (squash `595692f` on `main`) — session isolation and bounded memory both landed, though not in the shape this ticket's acceptance criteria prescribe.

**Satisfied as written**

- `trackServedEditRefusal` / `trackServedWriteRefusal` take `sessionKey` and track strictly within that session.
- `clearServedRefusals(sessionKey, path)` is called with the current session from both sites: the post-commit hook in `src/mutation-engine/pipeline.ts` and the post-write auto-read in `src/lifecycle-hooks/index.ts`.
- A test proves that repeated suspicious refusals in session A do not escalate the count in session B for the same path, alongside the cap and LRU behaviour (`test/core/served-refusal-session-scope.test.ts`); the suite and coverage thresholds hold.

**Deliberately replaced**

- `servedRefusalTracker` stays one flat `Map<_, RefusalEntry>` keyed `` `${sessionKey}\0${absolutePath}` `` rather than `sessionKey -> path -> RefusalEntry`, and there is no parent session map to prune. Review rejected the nested shape because `size` and eviction then need an O(sessions) scan on *every* refusal, and head-of-session eviction drains one session entirely before touching the next — the biasing that isolation is meant to remove.
- Memory is bounded on the total instead: `SERVED_REFUSAL_MAX_ENTRIES = 256`, evicted from the head of insertion order after the insert, with the key re-inserted on a repeat refusal so a resubmitted offender survives eviction. A constant total cap answers the leak concern without per-session bookkeeping.
- The `\0` separator is enforced, not assumed: `refusalKey` throws `TypeError` if a session key or path carries a NUL, so two scopes cannot fuse into one composite key.

If the nested partition is still wanted as a structural preference rather than a defect fix, reopen this or file it as a distinct refactor — the defect described here no longer reproduces on `main`.

