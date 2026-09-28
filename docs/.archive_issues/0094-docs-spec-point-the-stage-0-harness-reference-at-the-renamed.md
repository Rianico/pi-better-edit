# docs(spec): point the Stage-0 harness reference at the renamed drift probe file

> **Archived from pre-migration issue #94.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T10:40:58Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## Finding - the spec's designated Stage-0 harness path no longer exists
Spec section 6 "Stage 0 - Empirical Pin" names the harness explicitly, and the file was renamed by #88 (`8632012 docs(domain): re-align glossary for line identity`) so the test path matches the canonical `drift` glossary term in `CONTEXT.md` (`_Avoid_: ... external change`). The spec is now the only stale reference; `docs/adr/0016-content-addressed-line-identity-supersedes-healing.md` already names the new path.

## Remedy (authorized by the reviewer: update the spec's path reference, keep the new name)
Update the two path references inside `.scratch/mvcc-sparse-dense-anchors/spec.md`:

- L653: `- File: \`test/integration/p0-external-change-identity.test.ts\`` -> the new `p0-drift-line-identity` path, with a short parenthetical recording that #88 renamed it to the glossary's `drift` term.
- L698: the trailing reference "...asserted end-to-end in \`test/integration/p0-external-change-identity.test.ts\` Probe `C`" -> the new path.

This is a path-reference correction only. The revision 22 requirements, decision tables, probe definitions and acceptance criteria must stay byte-identical - the spec remains the authoritative input for the implementation.

## Acceptance criteria
- Both spec references name `test/integration/p0-drift-line-identity.test.ts`, and the referenced file exists.
- `git diff` for this change touches only those path tokens (plus the short rename note at L653); every other line of the spec is unchanged.
- No `p0-external-change-identity` reference remains anywhere in the repository.
- Do not introduce the avoided synonym `external change` in the new text: describe the rename via `drift` and the glossary, not via the old phrase beyond quoting the renamed path once.
- `pnpm test test/integration/p0-drift-line-identity.test.ts` reports 15 passing tests, and the standard gates (`pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage`) are green.


---

## Addendum (operator, after a 5-round false block)

A previous run blocked this task for five rounds on an agent-authored counter, not on the work. The work is correct; the grader was wrong.

**Correct commit already exists.** Branch `task/94`, commit `c29f631 docs(spec): point the Stage-0 harness reference at the renamed drift probe file`, in worktree `/Users/zhengxk/development/ai/pi-better-edit.task-94`. Round 1 must verify it, fix it only if something is genuinely wrong, and merge it - do not redo it from an empty tree.

**Diff-line counting trap (the cause of the false block).** A removed unified-diff line whose *content* itself begins with `-` renders with the diff marker prepended, i.e. `-- File: ...`. So `grep -cE '^-[^-]'` - and every naive `grep -c '^-'` variant - under-counts or misses it entirely. Never gate on a hand-rolled `grep` diff counter.

**Verification command (use this, not a grep counter).**

```
git -C <worktree> diff --numstat dev/mvcc-line-identity...HEAD
```

Expected output, exactly one line:

```
2	2	.scratch/mvcc-sparse-dense-anchors/spec.md
```

Two integer columns, tab-separated: 2 added, 2 removed, one file touched. Anything else - a third file, a different count, a missing line - is a real failure worth fixing.

**Content check.** `git -C <worktree> diff dev/mvcc-line-identity...HEAD` must show only the two Stage-0 harness path tokens changing (plus the short `renamed by #88` note at L653). Every other byte of the revision 22 spec is unchanged.


## Comments

### @Rianico — 2026-09-15T07:39:38Z

Delivered.

Merged into `dev/mvcc-line-identity` and squashed into `main` @ `bd3a8f2` (this remediation is included in that squash). Verified at delivery by the composite gate — `pnpm run lint` / `format` / `typecheck` / `test:coverage` (coverage ≥ 85% lines/statements/functions, ≥ 80% branches) — plus the 15-test Stage-0 harness with the four fail-closed probes keeping their byte-identity assertions.

Closing.
