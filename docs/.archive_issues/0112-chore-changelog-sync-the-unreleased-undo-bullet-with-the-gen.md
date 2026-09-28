# chore(changelog): sync the Unreleased undo bullet with the generator

> **Archived from pre-migration issue #112.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-14T14:42:58Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC).

## Symptom (real red on the delivered branch, caught by the workflow's final gate)

`CHANGELOG.md` `[Unreleased]` is not byte-for-byte the generator's output. The committed bullet for the undo change reads:

```
- **undo:** adopt, retire and re-serve in one transaction
```

while the generator derives it from the HEAD commit subject `19fad16 fix(undo): adopt, retire and re-serve atomically` and therefore produces:

```
- **undo:** adopt, retire and re-serve atomically
```

Task #107 hand-wrote the bullet from its issue title instead of regenerating. This fails the PR `Changelog Check` job and the `pre-push` guard.

**Why the per-task gates missed it:** `.config/wt.toml` `[pre-merge] gate` runs lint, format, typecheck, `test:coverage` and `commitlint` — it does **not** run the changelog check. That check runs only in CI on pull request and in the workflow's `final-gate` node.

## Remedy

1. In your worktree: `PYTHONDONTWRITEBYTECODE=1 uv run python scripts/changelog-unreleased.py update`
2. Inspect `git diff CHANGELOG.md` — with nothing else pending, it must contain only that one bullet change. If it shows anything else, stop and report what you found instead of committing blindly.
3. Commit exactly that file as `chore: sync changelog unreleased section` (`chore` is a hidden type, so the sync commit adds no new bullet and cannot re-stale itself).
4. Verify the way CI does:
   ```
   cp CHANGELOG.md /tmp/before.md
   PYTHONDONTWRITEBYTECODE=1 uv run python scripts/changelog-unreleased.py update
   diff -q /tmp/before.md CHANGELOG.md   # must report no difference
   ```
5. Remove `scripts/__pycache__` if the run created it (it is not gitignored and untracked files block the run).

## Acceptance criteria

- After the sync commit, re-running the generator produces **no** diff — `CHANGELOG.md` is exactly the generator's output.
- The commit is `chore: sync changelog unreleased section` and contains only `CHANGELOG.md`.
- No hand-written bullet anywhere: every `[Unreleased]` entry is generator output.
- The worktree ends pristine apart from the commit (no `scripts/__pycache__`, no stray files).
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:42Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
