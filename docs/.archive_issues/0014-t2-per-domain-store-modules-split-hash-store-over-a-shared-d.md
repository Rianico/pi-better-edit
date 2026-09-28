# T2 — Per-domain store modules: split hash-store over a shared DB-lifecycle seam

> **Archived from pre-migration issue #14.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-12T09:29:02Z · state CLOSED · labels: ready-for-agent

## Body

## Parent

#12 — Architecture: reject-and-serve as a seam + per-domain store modules (spec)

## What to build

`hash-store.ts` splits into per-domain modules over a shared DB-lifecycle seam: lifecycle (open/migrate/quarantine/busy-retry), snapshot-store, served-store (served table + drift-reported set), and undo-store (shaped like the served store). `served-state.ts` and `edit-undo.ts` consume the new seams instead of reaching into the raw store; the per-domain tests move with their modules. Pure split — zero observable behavior change.

## Acceptance criteria

- [ ] A DB-lifecycle module owns open/migrate/quarantine/busy-retry/withStore; no domain module re-implements it.
- [ ] Per-domain store modules exist (snapshot, served, undo), each owning its parse/validate/delete-corrupt logic; the served and undo stores are shaped alike.
- [ ] `served-state.ts` and `edit-undo.ts` consume the new seams; no direct raw-store access remains outside the store modules (no `loadHashStore`+domain-function pairs in tool modules).
- [ ] Per-domain tests move with their modules and stay green; the full suite stays 100% green (922 passed + 1 skipped) and `npm run eval:compare` reproduces the known results.
- [ ] No behavior change: codes, messages, echo rows, drift notices identical.

## Blocked by

T1 (reject-and-serve seam) — both touch the served-state family; sequence to avoid rebase noise.

## Comments

### @Rianico — 2026-08-12T10:36:42Z

Verified: typecheck + lint clean; full suite 929 passed + 1 skipped; eval:compare local 19/19 / 2.4.1 14/19 / 2.5.0 18/19 (identical char counts). Commit on main.
