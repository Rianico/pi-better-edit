# Contributing to pi-better-edit

## Conventional commits

- `feat[(scope)]: description` → MINOR, `fix[(scope)]:` → PATCH, `feat!:` / `BREAKING CHANGE:` → MAJOR
- Other types `docs|style|refactor|perf|test|build|ci|chore|revert` hidden unless `!`
- Scope is noun, description imperative present, lowercase, no period, ≤72 chars
- Enforced by `commitlint` + `husky` (`npx commitlint --from=origin/main --to=HEAD`)

### Footer-shaped body lines

The gate is `npx --no -- commitlint --from=origin/main --to=HEAD`. The base matters because `--from` takes a git range: a local `main` that lags `origin/main` re-lints commits that already landed, so a finding can belong to someone else's commit (`git rev-parse main origin/main` shows whether the two refs agree).

`footer-leading-blank` is a **warning**, printed as `⚠ footer must have leading blank line [footer-leading-blank]` alongside `found 0 problems, 1 warnings`, and the command still exits 0 (`@commitlint/config-conventional` sets this one rule to warning severity while the ones that fail a gate are errors). It fires when the parser reads a body line as the start of the commit footer and no blank line precedes it. The footer token is the parser's own — `^(?:BREAKING CHANGE|[\w-]+)(?::\s+|\s+#).+/i` given `issuePrefixes: ['#']` — which measures as two tolerated-annoying shapes:

- `Coverage: unchanged` — any line shaped `Word: text`, token case-insensitive, including a wrapped sentence whose continuation line begins that way.
- `issue #100 also closes it` — a word, a space, `#`, then text. `#100` alone and `closes this #100` stay body, because the separator must directly follow the first word.

So a future reader neither panics nor learns to ignore output: it is real, it is not yours to fix in passing, and it does not block. Avoid it without changing meaning by phrasing the line so it is not trailer-shaped (`Coverage is unchanged …`), or by keeping the trailer-shaped content inside a prose sentence. A blank line above it also clears the warning, but that promotes the line to a real footer — do that only when you mean it.

## Changelog

`CHANGELOG.md` `## [Unreleased]` is gated by `scripts/changelog-gate.py` in `changelog-check.yml` (a PR run reads the `Landing:` declaration from the PR body; the `main` run is the durable one); `release.yml` runs `semantic-release`, whose `scripts/release-changelog.mjs` plugin promotes the curated `[Unreleased]` ledger into the versioned section and re-opens an empty `## [Unreleased]`. Never clear `[Unreleased]` before the release runs — the plugin reads it as the release notes. Do not hand-edit versioned sections. Commit a sync as a hidden type (e.g. `chore: sync changelog unreleased section`) so it mints no ledger entry. Hidden types `style|chore|refactor|test|build|ci` only appear when `!`/`BREAKING CHANGE`.

Gates and hooks can probe the ledger read-only with `uv run python scripts/changelog-gate.py ledger --pr <N>` (exit 0 when the PR's entries are attributed, 1 on drift, 2 when the file is absent; nothing is written, staged or committed). A blocked gate can be waived via a `Ledger-Waiver: <reason>` line in the PR body — accepts fixable findings only, never unverified code.

## Reporting Issues
Pick the template that matches your intent — see `.github/ISSUE_TEMPLATE/` (blank issues disabled).
- Bugs: paste-complete input plus the exact args/payload, quote the diff or log; text beats screenshots.
- Features: state the problem and the proposal at minimum; alternatives optional.
Prompt rule: when the model helps file an issue, infer `bug` vs `feat` from intent, ask for any missing `body` field of that form, and render via `gh issue create --template <file>`.

## Before PR

`pnpm run verify` (`lint → format → typecheck → test:coverage`) and `pnpm run audit` must pass. See `AGENTS.md` for agent rules.

### Gate preconditions

A gate is valid only for the tip it measured, so check the tree before starting one:

- `git rev-parse HEAD` — the sha the run's result belongs to.
- `git status --porcelain --untracked-files=all` and `git diff --stat` — both empty.
- `git diff-index --quiet HEAD` — the invariance authority: exit 0 means no tracked path differs from `HEAD`, staged or unstaged (measured: either kind of edit to a tracked file exits 1).
- `git stash list` — empty; stashed work is not the tree under test.
- `uptime` — the host has not just rebooted or woken, and its load at the time of the run is known; a suspend or a load spike mid-run invalidates any timing evidence the run produces.

Two scans cover what those checks cannot see:

- `find . -path ./node_modules -prune -o -name '*-probe*' -print`
- untracked test files: `comm -13 <(git ls-files '*.test.ts' | sort) <(find . -path ./node_modules -prune -o -name '*.test.ts' -print | sed 's|^\./||' | sort)`

**Why the scan is not `git status`.** Worked example from this tranche: a scratch `tmp/pi-on-probe.mjs` was gitignored (`/tmp/` is root-anchored in `.gitignore` — `git check-ignore -v tmp/pi-on-probe.mjs` names the rule that hid it). `git status --porcelain --untracked-files=all` reported the tree CLEAN and `git diff --stat` stayed empty, so both tree checks hid the file; only the `find` scan above found it. General form: the two instruments disagree exactly when the residue is gitignored, and that is precisely the case that matters, because scratch and probe files are the ones a worktree's ignore rules exist to hide. Read the hits rather than counting them: `docs/.archive_issues/*-probe-*.md` match the name scan and are archived issue documents, not residue.

## Pull Requests
Prefer topic branch → PR → squash merge. Keep one concern per PR; link the issue with `Closes #NN` in the description or commit footer.
### Description
PR body is auto-populated from `.github/pull_request_template.md` (GitHub PR template). Keep the four headings — delete `Architecture` when no structural change:
- **Summary** — 2-3 sentences on *why*, not what line changed. Include `**Impact**: X files (Y +, Z -) · **Risk**: Low | Medium | High` (Low = docs/tests only; Medium = isolated feature/fix; High = cross-module contract, migration, or `BREAKING CHANGE`).
- **What Changed** — grouped by system/feature, not by file list. Flag migrations / API / payload / config-format changes.
- **Architecture** — Mermaid `graph LR` / `sequenceDiagram` before → after only for structural seams, layering, or data-flow changes.
- **Checklist** — derived from change categories; start from the template checklist and add items as needed (e.g., tests for regression, absorption notes for upstream sync).
CI (`changelog-check.yml`, `verify`) must be green before requesting review.

