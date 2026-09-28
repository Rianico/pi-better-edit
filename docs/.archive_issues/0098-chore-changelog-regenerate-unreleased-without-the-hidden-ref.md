# chore(changelog): regenerate Unreleased without the hidden refactor section

> **Archived from pre-migration issue #98.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T10:41:07Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## Finding - documented standards violation (changelog section rules)
`CONTRIBUTING.md`: "Hidden types `style|chore|refactor|test|build|ci` only appear when `!`/`BREAKING CHANGE`."

`CHANGELOG.md` L26-29 introduces a `### Code Refactoring` section under `## [Unreleased]` for commit `81dbd14 refactor: carry snapshots, name pins, share scans`, which carries neither `!` nor `BREAKING CHANGE:`. `scripts/changelog-unreleased.py` marks `refactor` hidden and skips it unless breaking, so the hand-written section is not part of the generated output.

## Remedy
Regenerate the section with the repository's own tool instead of hand-editing it:

```
uv run python scripts/changelog-unreleased.py update
```

This drops the `### Code Refactoring` section and makes `## [Unreleased]` byte-identical to the generated output, which is what both guards require: `.githooks/pre-push` (warn + block + auto-amend) and `.github/workflows/changelog-check.yml` (`diff -q` vs generated).

Commit the sync with a hidden type - `chore: sync changelog unreleased section` - because a visible type (`feat|fix|perf|revert|docs`) re-triggers the guard and loops forever.

## Acceptance criteria
- `uv run python scripts/changelog-unreleased.py update` produces no diff against the committed `CHANGELOG.md` (byte-identical).
- No `### Code Refactoring` section remains under `## [Unreleased]`.
- Versioned release sections (`## [1.7.0]` and older) are untouched.
- This commit touches `CHANGELOG.md` only and uses a hidden conventional type with a body line length of at most 100 characters.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:39:52Z

Delivered.

Merged into `dev/mvcc-line-identity` and squashed into `main` @ `bd3a8f2` (this remediation is included in that squash). Verified at delivery by the composite gate — `pnpm run lint` / `format` / `typecheck` / `test:coverage` (coverage ≥ 85% lines/statements/functions, ≥ 80% branches) — plus the 15-test Stage-0 harness with the four fail-closed probes keeping their byte-identity assertions.

Closing.
