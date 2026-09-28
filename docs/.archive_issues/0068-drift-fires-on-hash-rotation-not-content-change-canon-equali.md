# Drift fires on hash-rotation, not content change (canon-equality)

> **Archived from pre-migration issue #68.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-04T15:18:27Z · state CLOSED · labels: ready-for-agent

## Body

## What to build

Editing a file twice in one session no longer reports the first edit's own lines as drift. Drift fires only when a served line's canon is truly gone outside the replacement range, not when duplicate lines (e.g. `});`, `it/expect`) get fresh hashes from probing plus tombstone growth.

Concrete repro from session 2026-09-04 (pi-better-rules): edit tests/lifecycle.test.ts at Sce (+30 lines) then edit [cmi,cmi] (+2 lines) with only a failed bad-payload edit and a partial read between. Second edit reported 20 lines including the Sce/Tdf block just added.

## Acceptance criteria

- [ ] Repro above produces no drift notice (empty driftNotice, no [USER] drift section)
- [ ] Real deletion outside the range still drifts (canon deficit case covered by a test)
- [ ] Whitespace-only reformat stays silent (ADR-0005)
- [ ] `npm test` and `tsc --noEmit` green

## Blocked by

None (can start immediately)

## Comments

### @Rianico — 2026-09-05T06:42:48Z

Opened PR #71 (fix/drift-canon → main).
