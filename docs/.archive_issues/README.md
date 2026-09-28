# Archived issues (pre-migration)

## Why this directory exists

On 2026-09-28 this repository was converted from a fork
(`Rianico/pi-better-edit`, fork of `YuGiMob/pi-hashline-edit-pro`) into a
standalone repository. GitHub offers no detach that preserves metadata when a
child fork blocks the one-click option, so the conversion used the documented
manual path: **delete the fork → recreate the repo under the same name → push
the preserved git history**.

Deleting a repository **permanently destroys all of its issues, pull requests,
stars, and watchers**. There is no reserve, transfer, or hold mechanism. This
directory preserves the **120 closed issues** from the pre-deletion export so
their discussions and decisions are not lost to the void.

## What is here

- `NNNN-slug.md` — one file per closed issue, named by its **original** issue
  number (zero-padded) plus a title slug. Each file holds the original title,
  author, creation date, labels, full body, and all comments with authors and
  dates.
- The full machine-readable backup (128 issues, 47 PRs, 13 releases, including
  comment objects) lives outside the repo at `~/.pbe-migrate/`.

## What was re-filed live (not archived here)

The 8 issues that were still **open** at migration time were re-created on the
new repo. GitHub assigns new numbers on re-file, so the mapping is:

- #137 → #1 — Roadmap: pi-lens interoperability
- #138 → #2 — docs: record the pi-lens read/format interaction
- #139 → #3 — test: pin the edit payload wire shape…
- #140 → #4 — feat: flag served state provisional…
- #141 → #5 — feat: report served rows through pi-lens' read bridge
- #142 → #6 — spike: decide whether to record mutations…
- #143 → #7 — probe: measure pi-lens' writes…
- #173 → #8 — [bug] undo summary counts…

Each re-filed issue carries a footer noting its original number and date.

## What could not be preserved

- Original issue numbers (old `Closes #NNN` references and external links dangle).
- Original timestamps, reactions, and edit history.
- Authorship attribution on re-filed issues (all 8 open ones were ours, so no
  third party was misattributed; the same cannot be said of the closed set in
  general — treat archived bodies as quoted records, not live threads).
- Stars and watchers (unrecoverable; contributors must re-star).
- The 47 pull request discussion threads (code itself was already merged, so
  nothing functional is missing; threads remain only in the JSON backup).
