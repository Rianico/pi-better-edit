# docs(context): align the served echo refusal template with the code

> **Archived from pre-migration issue #131.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-16T07:38:28Z · state CLOSED · labels: ready-for-agent

## Body

## Finding (review P3-4, docs axis)

`CONTEXT.md` (the `served hash echo` / `[E_SERVED_ECHO]` entry) describes the edit refusal as ending "…served for this session, path, and **range-relative line**". The code emits "…served for this session, path, and **line ${servedLine}**" (`buildServedEditMessage` / `buildServedWriteMessage`). "range-relative" is retired pre-E2 vocabulary; the refusal names the reproduced row's real coordinate.

## Required behaviour

Update `CONTEXT.md` so the documented refusal template matches the emitted text, keeping the entry's remaining meaning intact: durable-served evidence, deny-not-strip, "Nothing was written.", and the `mode: "literal"` escape.

## Invariants

- Documentation only — no source or test changes in this task.
- The glossary stays the domain authority for vocabulary: do not rewrite the surrounding terms or the `_Avoid_:` lists.


## Comments

### @Rianico — 2026-09-17T16:31:19Z

Landed in #134 — squash `ba7c8d2` on `main` (the PR body's comma-separated `Closes` list only linked the first reference per line).
