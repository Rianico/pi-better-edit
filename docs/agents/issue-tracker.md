# Issue tracker: GitHub

Issues and PRDs for `pi-better-edit` live as GitHub issues. Use the `gh` CLI.

## Conventions

- **Create**: `gh issue create --title "..." --body "..."` (heredoc for multi-line bodies).
- **Read**: `gh issue view <number> --comments`.
- **List**: `gh issue list --state open --json number,title,body,labels`.
- **Label**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`, or write `Closes #NN` on its own line
  at the bottom of a PR description so the squash merge closes it automatically.

Infer the repo from `git remote -v`; `gh` does this inside a clone.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", run `gh issue view <number> --comments`.
