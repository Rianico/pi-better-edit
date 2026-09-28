# docs(domain): re-align CONTEXT.md glossary and drift vocabulary with superseding ADRs

> **Archived from pre-migration issue #88.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T08:03:00Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## Rule
`CONTEXT.md` defines **drift** and commands `_Avoid_: modification, external change (the tool cannot know the source)`. `docs/agents/domain.md` mandates the canonical glossary vocabulary across code, tests, commits and proposals. The single-context source of truth is `CONTEXT.md` at the repo root.

## Violation
1. The MVCC delivery introduces the avoided synonym **external change**:
   - harness file `test/integration/p0-external-change-identity.test.ts` and its `describe("p0-external-change-identity probes")`;
   - `test/tools/served-session.test.ts` (~L492): `"re-serve upsert: external change -> ..."`;
   - branch commit `e460b02 test(mvcc): pin stage-0 external-change identity probe harness`.
2. ADR-0016 and ADR-0017 supersede ADR-0008/0013 and retire `orphaned serve`, `orphaning re-serve`, `relocated line keeps its hash`, `epoch`, `strictPos`, but `CONTEXT.md` was not updated: the authoritative glossary still documents superseded mechanisms and lacks the new canonical vocabulary (line identity, lease, snapshot, retirement).

## Remedy
- Rename the harness to `test/integration/p0-drift-line-identity.test.ts` and update every reference (`docs/adr/0016-content-addressed-line-identity-supersedes-healing.md`, plus a repo-wide grep).
- Replace `external change` wording with `drift` in the harness titles/descriptions and in `test/tools/served-session.test.ts`.
- Update `CONTEXT.md`: retire or rewrite the superseded entries, and add the canonical terms the implementation actually uses.

## Acceptance criteria
- No diff-introduced occurrence of `external change` (case-insensitive) remains under `test/`.
- Pre-existing baseline occurrences are OUT OF SCOPE and must stay untouched: `README.md`, `benchmarks/**`, `docs/spec/**`, `scripts/**`, `test/eval/**`, and the `_Avoid_:` line inside CONTEXT.md's own `drift` entry (that line is the rule itself).
- The harness file is renamed with all references updated, and `pnpm test test/integration/p0-drift-line-identity.test.ts` reports 15 passing tests.
- `CONTEXT.md` no longer presents retired mechanisms as live and documents the new canonical vocabulary.
- Do NOT rewrite `.scratch/mvcc-sparse-dense-anchors/spec.md` - it is the input spec and keeps its own wording.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:39:19Z

Delivered.

Merged into `dev/mvcc-line-identity` and squashed into `main` @ `bd3a8f2` (this remediation is included in that squash). Verified at delivery by the composite gate — `pnpm run lint` / `format` / `typecheck` / `test:coverage` (coverage ≥ 85% lines/statements/functions, ≥ 80% branches) — plus the 15-test Stage-0 harness with the four fail-closed probes keeping their byte-identity assertions.

Closing.
