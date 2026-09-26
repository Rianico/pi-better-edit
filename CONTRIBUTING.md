# Contributing to pi-better-edit

## Conventional commits

- `feat[(scope)]: description` → MINOR, `fix[(scope)]:` → PATCH, `feat!:` / `BREAKING CHANGE:` → MAJOR
- Other types `docs|style|refactor|perf|test|build|ci|chore|revert` hidden unless `!`
- Scope is noun, description imperative present, lowercase, no period, ≤72 chars
- Enforced by `commitlint` + `husky` (`npx commitlint --from=origin/main --to=HEAD`)

## Changelog

`CHANGELOG.md` `## [Unreleased]` is gated by `scripts/changelog-gate.py` in `changelog-check.yml` (a PR run reads the `Landing:` declaration from the PR body; the `main` run is the durable one); `release.yml` runs `scripts/changelog-unreleased.py clear` then `semantic-release` owns versioned sections. Do not hand-edit versioned sections. Commit a sync as a hidden type (e.g. `chore: sync changelog unreleased section`) so it mints no ledger entry. Hidden types `style|chore|refactor|test|build|ci` only appear when `!`/`BREAKING CHANGE`.

Gates and hooks can probe the ledger read-only with `uv run python scripts/changelog-gate.py ledger --pr <N>` (exit 0 when the PR's entries are attributed, 1 on drift, 2 when the file is absent; nothing is written, staged or committed). A blocked gate can be waived via a `Ledger-Waiver: <reason>` line in the PR body — accepts fixable findings only, never unverified code.

## Reporting Issues
Pick the template that matches your intent — see `.github/ISSUE_TEMPLATE/` (blank issues disabled).
- Bugs: paste-complete input plus the exact args/payload, quote the diff or log; text beats screenshots.
- Features: state the problem and the proposal at minimum; alternatives optional.
Prompt rule: when the model helps file an issue, infer `bug` vs `feat` from intent, ask for any missing `body` field of that form, and render via `gh issue create --template <file>`.

## Before PR

`pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` must pass. See `AGENTS.md` for agent rules.

## Pull Requests
Prefer topic branch → PR → squash merge. Keep one concern per PR; link the issue with `Closes #NN` in the description or commit footer.
### Description
PR body is auto-populated from `.github/pull_request_template.md` (GitHub PR template). Keep the four headings — delete `Architecture` when no structural change:
- **Summary** — 2-3 sentences on *why*, not what line changed. Include `**Impact**: X files (Y +, Z -) · **Risk**: Low | Medium | High` (Low = docs/tests only; Medium = isolated feature/fix; High = cross-module contract, migration, or `BREAKING CHANGE`).
- **What Changed** — grouped by system/feature, not by file list. Flag migrations / API / payload / config-format changes.
- **Architecture** — Mermaid `graph LR` / `sequenceDiagram` before → after only for structural seams, layering, or data-flow changes.
- **Checklist** — derived from change categories; start from the template checklist and add items as needed (e.g., benchmarks for perf, absorption notes for upstream sync).
CI (`changelog-check.yml`, `verify`) must be green before requesting review.

