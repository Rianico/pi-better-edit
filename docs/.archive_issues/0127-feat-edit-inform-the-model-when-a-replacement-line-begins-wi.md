# feat(edit): inform the model when a replacement line begins with a served anchor

> **Archived from pre-migration issue #127.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-15T16:42:08Z · state CLOSED · labels: ready-for-agent

## Body

Repo: `Rianico/pi-better-edit`. Depends on: the shape-refusal removal ticket (the tier only exists once the catch is gone).

## Why
The settled tiers are: conclusive evidence → gate; never-served shape → silent; and the middle tier — a replacement line that begins with an anchor served for this path but whose content differs from what was served — currently passes silently. That tier includes pastes the model edited by hand, so the model (not only a human) must be told, in the model's channel, without blocking the write.

## Scope
- When the prefix matches a served anchor for this session + path but the remainder's canon differs from the served content (the predicate's ambiguous outcome): apply the edit, then append a `[MODEL]` note to the result **content** (the `warnBlock` / `modelWarnings` seam in `src/edit-response.ts`). The note states: the edit was applied, the replacement line, the anchor, the line it was served for, that its content differs from what was served, and the corrective action (`undo_last_edit`).
- `write`: the same note through the existing `tool_result` handler.
- No gate, no refusal, no cross-turn state: no suppression registry, no persistence, no re-surfacing, no escalation. The note fires per occurrence; the post-edit diff already carries the written line.

## Acceptance
- Tests: note appears on `edit` and `write` for the ambiguous tier; **no** note when no served-anchor prefix matches; **no** note when the evidence gate fires (that path refuses); the note never alters the written bytes and never blocks.
- Full gate green: `pnpm run lint && rtk pnpm run format && rtk pnpm run typecheck && rtk pnpm run test:coverage`.

## Non-goals
No escalation threshold, no persistence, no `[USER]`-only variant (the model is the audience).


## Comments

### @Rianico — 2026-09-17T16:31:07Z

Landed in #134 — squash `ba7c8d2` on `main` (the PR body's comma-separated `Closes` list only linked the first reference per line).
