# chore(config): revert out-of-scope wt commit.generation prompt rules

> **Archived from pre-migration issue #93.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T08:03:14Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## Finding - scope creep
The specification scopes line-identity MVCC (engine, storage, leases, vacuum). Commit `9baf715` also modifies `.config/wt.toml` (L8-17) to add a `[commit.generation] template-append` prompt block that steers worktrunk's LLM-generated squash message around `commitlint`'s conventions:

```toml
# WHY: wt merge LLM-generates the squash message and commitlint (config-conventional)
# WHY: rejects body lines longer than 100 characters, so the repo convention has to
# WHY: ride along in the prompt; project config honors only template-append.
[commit.generation]
template-append = """
- Keep conventional-commit form: type[(scope)]: imperative lowercase subject, no period
- Wrap every body line at 100 characters or fewer (commitlint body-max-line-length)
- Reference the relevant issue ID in the body (for example, "Closes #80")
"""
```

This was not requested by the specification and is unrelated to line identity. If the repository wants that prompt guidance it belongs in its own change, not in the MVCC delivery.

## Remedy
Revert that block so `.config/wt.toml` is byte-identical to the base branch. The real invariant - commit bodies of at most 100 characters - is enforced by the pre-merge gate and must be satisfied by the commit messages themselves, not by a prompt hint.

## Acceptance criteria
- `git diff feat/mvcc-line-identity...HEAD -- .config/wt.toml` produces no output.
- No other file is touched by this change.
- The rest of `.config/wt.toml` (`[post-start]`, `[pre-merge]`, `[list]`, `[pre-remove]`) is unchanged.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:39:35Z

Delivered.

Merged into `dev/mvcc-line-identity` and squashed into `main` @ `bd3a8f2` (this remediation is included in that squash). Verified at delivery by the composite gate — `pnpm run lint` / `format` / `typecheck` / `test:coverage` (coverage ≥ 85% lines/statements/functions, ≥ 80% branches) — plus the 15-test Stage-0 harness with the four fail-closed probes keeping their byte-identity assertions.

Closing.
