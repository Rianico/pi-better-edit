# T1 — Served-state module: one owner for serve recording and served-span reconstruction

> **Archived from pre-migration issue #10.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-12T06:10:11Z · state CLOSED · labels: ready-for-agent

## Body

## Parent

#9 — Architecture refactor: served-state module + single result assembly (spec)

## What to build

A single served-state module owns the mirror of what the model saw, and every serve site records through it. The served-span reconstruction ("where was this hash served, and where is it now?") is implemented once in the module and consumed by both range verification and the drift scan. The four serve sites (read, the edit rejection echo, the drift scan, the tool_result diff recording) shrink to `record(path, rows)` calls. Observable behavior is byte-identical: same reject codes, same echo rows, same drift notices, same auto-read diffs.

## Acceptance criteria

- [ ] A served-state module exists with `load(path)`, `record(path, rows)`, `clearReported(path)`, `wipe()`, and the served-span reconstruction helpers; the pure verification core (`verifyServedRange`/`buildRangeEcho`/`fmtServedRows`) stays pure and unchanged.
- [ ] All four serve sites record through the module — no site opens the store itself or implements its own record+tolerate habit.
- [ ] The served-span reconstruction (positions-of-hash scan; neighbor-survival/current-position mapping) is implemented once, in the module, and consumed by both verification and drift — no duplicated scan remains.
- [ ] The serve-timing policy (read at execute-time, edit diff at tool_result-time) and the reported-set clearing policy (read clears; rejection echoes and drift rows don't) are preserved exactly, documented in one place in the module.
- [ ] Unit tests at the module seam cover record semantics (upsert, null handling), the reported-clearing policy, and the reconstruction helpers (prior art: existing test/core unit tests for served storage and drift).
- [ ] Full suite green (currently 926 passed + 1 skipped) and `npm run eval:compare` reproduces local 19/19 / 2.4.1 14/19 / 2.5.0 18/19 — no observable-behavior change.

## Blocked by

None — can start immediately.

## Comments

### @Rianico — 2026-08-12T06:20:26Z

Verified: typecheck + lint clean; full suite 941 passed + 1 skipped; eval:compare local 19/19 / 2.4.1 14/19 / 2.5.0 18/19 (identical char counts). Commit on main.
