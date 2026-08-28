> [!info] Scaffold git — conventional commits + semantic-release + worktrunk + branch hygiene
> Creates `.releaserc.json` (`conventionalcommits` preset, changelog → github → git), `.github/workflows/release.yml` (pinned SHA, push to main), `commitlint` + `husky` pre-commit, `.gitignore` entries (`.lsz/`), and `CHANGELOG.md` (Keep a Changelog). Worktrunk: `wt` branch-addressed worktrees, `copy-ignored`, `hash_port` per branch. Release: `fix`→PATCH, `feat`→MINOR, `feat!`/`BREAKING CHANGE`→MAJOR via `commit-analyzer`; notes grouped by type with links. Use for new repos or to retrofit existing `v*` history — respects past tags.

> [!tip] Verification — model must run before every push/release

> - **Lint + format:** `npm run lint` / `cargo clippy` / `ruff check` / `biome check`, `cargo fmt --check` / `prettier --check`
> - **Type / build:** `npm run typecheck` (`tsc --noEmit`) / `cargo check`
> - **Tests:** `npm test` / `cargo test` / `pytest` / `go test ./...` — use the repo's `test` script
> If any fails → `BLOCKED` — CI is single-platform sanity only (`ubuntu-latest`/`node 22.19.0`).

Scaffold a git repo with conventional commits, semantic-release, worktrunk, and branch hygiene. Creates `.releaserc.json` (conventionalcommits preset, changelog → npm → github → git), `.github/workflows/release.yml` (pinned SHA, push to main), `commitlint` + `husky` pre-commit, `.gitignore` entries (`.lsz/`), and `CHANGELOG.md` (Keep a Changelog). Worktrunk: `wt` branch-addressed worktrees, `copy-ignored`, `hash_port` per branch. Release: `fix`→PATCH, `feat`→MINOR, `feat!`/`BREAKING CHANGE`→MAJOR via `commit-analyzer`; notes grouped by type with links. Use for new repos or to retrofit existing `v*` history — respects past tags.
