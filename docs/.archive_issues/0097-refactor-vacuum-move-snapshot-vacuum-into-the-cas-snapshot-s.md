# refactor(vacuum): move snapshot vacuum into the CAS snapshot store

> **Archived from pre-migration issue #97.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T10:41:04Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## Finding - Feature Envy / Divergent Change
`src/served-session/session.ts` L854-865: that module models per-session served records and lease state, but `vacuumSnapshots` operates almost exclusively on `file_snapshots` and `line_lineage` - the CAS snapshot store. Snapshot-store SQL and prepared statements therefore live in the session module.

## Remedy
Relocate the snapshot vacuum logic and its prepared statements into `src/snapshot-store.ts`, next to the rest of the CAS snapshot store. `session.ts` keeps only session/lease concerns and calls the relocated function.

## Acceptance criteria
- `vacuumSnapshots` (and any snapshot-store prepared statements it needs) lives in `src/snapshot-store.ts`; no `file_snapshots` / `line_lineage` SQL remains in `served-session/session.ts`.
- Behaviour is unchanged: the global 50 MB budget, the per-path retention cap, and the pinning rules (active unswept lease, `file_undo` restore target, 1-hour retirement grace) all still hold; pruning still runs inside the same transaction semantics and busy-retry wrapper.
- Existing vacuum tests stay green without weakening assertions, and any test that imported the vacuum helper from `session.ts` is updated to the new location.
- The 15-test Stage-0 harness stays green.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:39:49Z

Delivered.

Merged into `dev/mvcc-line-identity` and squashed into `main` @ `bd3a8f2` (this remediation is included in that squash). Verified at delivery by the composite gate — `pnpm run lint` / `format` / `typecheck` / `test:coverage` (coverage ≥ 85% lines/statements/functions, ≥ 80% branches) — plus the 15-test Stage-0 harness with the four fail-closed probes keeping their byte-identity assertions.

Closing.
