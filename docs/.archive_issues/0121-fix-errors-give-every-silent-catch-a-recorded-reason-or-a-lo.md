# fix(errors): give every silent catch a recorded reason or a log

> **Archived from pre-migration issue #121.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-15T03:50:17Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78. Found while verifying review 5 — the same defect class review 5 flagged once (the batch-loop `catch {}` that #117 fixes), repeated at six more sites.

## Finding

Empty `catch {}` blocks still swallow failures in `src/`:

| Site | Swallowed |
| --- | --- |
| `src/mutation-engine/pipeline.ts:199` | loading tombstone/canons for the batch (`handle.loadTombstone()`, `handle.loadCanons()`) |
| `src/edit-undo.ts:192` | anchor recovery for a restored snapshot (`anchorsForSnapshotHash`) |
| `src/edit-undo.ts:217`, `:219` | the nested failure paths of the same undo restore |
| `src/served-session/session.ts:413` | the v6 schema `ALTER TABLE` migration block |
| `src/served-session/session.ts:623` | canon persistence on a serve path |

## Why this must go

The operator requires every run to follow `rules/common/development-patterns.md` § 2 (*Guards — Errors, Security, Suppressions*):

> **Errors fail loud** — every path has explicit branch: handle, map to typed error, or propagate. Log cause, no secrets.
> _Check:_ no empty `except`/`catch`; every catch re-raises, returns `Result`/`Err`, or logs with context.

Review 5 caught exactly one instance of this (`pipeline.ts` batch loop, now #117). The remaining six are the same violation, and a reviewer applying the rules will flag them one per round until they are gone.

## Remedy

For each site, choose the honest branch and write down why in a short comment:

1. **Log with context** (preferred, matching the repo's existing best-effort pattern — see `pipeline.ts`'s `console.error("Failed to commit post-write snapshot materialization:", error)` and `session.ts:675`'s "Failed to grant served leases:"): a single line naming the operation and carrying the error.
2. **Propagate** where the failure is not genuinely recoverable at that point.
3. **Keep it silent only with a documented reason** — and only where a log would be wrong (for example a schema `ALTER` whose failure is expected on re-run because the column already exists). Even then the comment must state the expected error and the invariant that still holds.

Constraints:
- **Behaviour must not change.** These are fail-open/best-effort paths: a failed store write must not start failing a read or edit that already committed (spec §3.6.2). Logging must never throw, and must never alter a returned result.
- **No new noise.** Do not log per line or per row; one line per failed operation.
- Do not touch the batch-loop site — that is #117's change.

## Acceptance criteria

- `rg -n 'catch\s*(\([^)]*\))?\s*\{\s*\}' src/` returns nothing (every catch now has a body).
- Each previously-silent site either logs with context or carries a comment naming the expected failure and the invariant that survives; the chosen branch is explained in the commit body, per site.
- Behaviour unchanged: the best-effort paths stay best-effort, no new thrown error, no altered tool result.
- All 15 Stage-0 probes stay green (four fail-closed probes keep byte-identical file assertions); the undo, session, batch and vacuum suites keep their assertions unweakened.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T04:07:14Z

Scope correction after #117 merged (`6eb427b`): the two `pipeline.ts` sites listed in the table are already fixed there (`pipeline.ts:199` tombstone/canon loader and the batch-loop `catch {}`). The remaining sites to fix are **five**:

| Site | Swallowed |
| --- | --- |
| `src/edit-undo.ts:192` | anchor recovery for a restored snapshot (`anchorsForSnapshotHash`) |
| `src/edit-undo.ts:217`, `:219` | nested failure paths of the same undo restore |
| `src/served-session/session.ts:413` | the v6 schema `ALTER TABLE` migration block |
| `src/served-session/session.ts:623` | canon persistence on a serve path |

Verified with `rg -n 'catch\s*(\([^)]*\))?\s*\{\s*\}' src/` on `af58bee`. Acceptance criterion stands: that command must return nothing when you are done.

### @Rianico — 2026-09-15T07:41:14Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
