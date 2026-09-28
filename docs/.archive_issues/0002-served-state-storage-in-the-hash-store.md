# Served-state storage in the hash store

> **Archived from pre-migration issue #2.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-11T07:41:11Z · state CLOSED · labels: ready-for-agent

## Body

## What to build

The tool's **served state** — its session-scoped, per-file, per-line record of the hashes delivered to the model's context — persisted in the hash store: a new `served` table alongside `snapshots` and `undo`. Entries are position-indexed per file and hold either a served 3-char hash or an explicit never-served marker. The record is cleared wholesale at session start and pruned for missing files alongside snapshots and undo. Nothing model-visible changes yet; this is the storage foundation the served-state verification builds on.

See `docs/spec/served-state-range-verification.md` (Implementation Decisions 1, 8; user stories 22, 23) and `docs/adr/0001-served-state-range-verification.md`. Use the `CONTEXT.md` glossary vocabulary throughout (serve, served state, never-served).

## Acceptance criteria

- [ ] Served entries round-trip per file and position (upsert / read / delete), following the hash-store test pattern.
- [ ] Never-served positions are representable distinctly from served hashes (a gap is detectable, not a missing row).
- [ ] A store version bump clears served state alongside snapshots and undo.
- [ ] Session start wipes served state wholesale — a fresh session starts empty, nothing leaks from a previous session.
- [ ] `pruneMissing` deletes served entries for missing files alongside snapshots and undo.
- [ ] Store-seam tests cover CRUD, wipe, and prune; the lifecycle (`session_start`) handler test covers the wipe, following the existing lifecycle/auto-read captured-handler patterns.

## Blocked by

- None — can start immediately.

## Blocked by

- None — can start immediately.


## Comments

### @Rianico — 2026-08-11T08:04:44Z

Implemented in commit `6a30198` on `replace_rejection`: served table (path-keyed JSON `(string|null)[]` by position), `getServed`/`upsertServed`/`deleteServed`/`wipeServed`, version-bump clear, session-start wipe, prune fold-in. Typecheck clean; 22 new store-seam tests + 1 lifecycle test; full suite 862/866 (4 failures are the known pre-existing macOS `/var`→`/private/var` `resolveTarget` environmental issue).

### @Rianico — 2026-08-11T08:04:46Z

Closing: storage foundation complete and verified.
