## Agent skills

### Issue tracker

Issues and specs for this repo live as GitHub issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`. Env snapshot: `docs/agents/env.yaml`. Toolchain: `docs/agents/toolchain.md`.

The architecture-revision spec lives at `docs/spec/content-addressed-line-identity-mvcc.md`.

### Refining tool prompts

The method for changing a tool's description, snippet or guidelines — map the surfaces, map the pins, probe behaviourally, measure every ambiguity, review, ticket, verify the served text — and the principles behind it: see `docs/agents/refining-tool-prompts.md`.

### Model-facing surfaces

The tool schema the model reads is a cheap surface: the model re-reads it every session and there is no compiled client, so adding or removing a field is a MINOR change at most — never `!`. Two things stay expensive and must not be swept up with it: **recorded history** (transcripts store the arguments actually sent, so renderers keep tolerating shapes that no longer validate) and **pinned removals** (a deleted field needs one test asserting the old shape is now rejected). Reasoning: `docs/adr/0040-read-payload-single-shape.md` and `docs/adr/0041-read-payload-flat-file-target-with-windows-and-top-level-mode.md`.

### Contribution

Conventional commits & changelog: see CONTRIBUTING.md

### Runtime

TypeScript: pnpm v12 + Node 24.0.0+ (`.nvmrc` 26) + TS v7 (Go native) + Vite v8, verify via `pnpm run verify` (lint → format → typecheck → test:coverage; oxlint / oxfmt / tsc / vitest) and `pnpm run audit` for the dependency gate (pinned to the public registry, because a mirror may not serve the audit endpoint). Deps via `pnpm-lock.yaml` (frozen in CI); do not run npm against this repo.
