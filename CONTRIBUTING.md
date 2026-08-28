# Contributing to pi-better-edit

> [!info] Single-package repo — one `CHANGELOG.md` at root. Monorepos use per-package changelogs (e.g. `earendil-works/pi` keeps `packages/*/CHANGELOG.md`, each with its own versioned sections).

## Conventional commits

All commits must follow Conventional Commits 1.0.0:

- `feat[(scope)]: description` → MINOR (`1.2.3 → 1.3.0`)
- `fix[(scope)]: description` → PATCH (`1.2.3 → 1.2.4`)
- `feat!:` / `fix!:` / `BREAKING CHANGE:` → MAJOR

Other types `docs|style|refactor|perf|test|build|ci|chore|revert` do not trigger a release unless `!`.

Scope is a noun (`(edit)`, `(agent)`), description is imperative present, lowercase, no period, ≤72 chars.

Enforced by `commitlint` + `husky` pre-commit (`npx commitlint --from=origin/main --to=HEAD`). Config: `commitlint.config.js` (`extends: ["@commitlint/config-conventional"]`) + `.releaserc.json` (`conventionalcommits@8.0.0` preset, `chore`/`docs` hidden).

Examples:

- `feat(edit): route drift signals to user-facing details`
- `fix(agent): handle empty file read`

## Changelog

> [!warning] Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers on tag push.

- `CHANGELOG.md` contains **only versioned sections** (`## [X.Y.Z] - YYYY-MM-DD` with `### Added/Changed/Fixed/Removed`); there is **no `## [Unreleased]`** accumulation point.
- Maintainer cuts a release by pushing a tag:

  ```bash
  git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z
  ```

  `release.yml` (`on: push: tags: ['v*']`) then runs `semantic-release` to generate `## [X.Y.Z]` from `feat`/`fix` commits since last tag (`v1.2.3..vX.Y.Z`, highest bump wins — `feat: a` + `feat: b` → one `MINOR` → `1.3.0` with N bullets). Contributors just write `feat:`/`fix:` commits; no hand-written changelog needed.
- Single-package note: this repo keeps one `CHANGELOG.md` at root. Monorepos (like `earendil-works/pi`) keep per-package changelogs (`packages/*/CHANGELOG.md`), each versioned independently.

## Before submitting a PR

```bash
npm run lint        # eslint — custom/no-comments only allows SAFETY: + Gherkin
npm run typecheck   # tsc --noEmit — noUncheckedIndexedAccess, exactOptionalPropertyTypes
npm test            # vitest — 1065 tests; test:coverage is CI-only (90% threshold)
```

All three must pass. See `AGENTS.md` for agent-specific rules (issue tracker, triage labels, domain docs).
