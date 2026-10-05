# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (most repos):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Number new ADRs from the trunk

`adr new` allocates the next number by scanning the worktree it runs in, so on a branch it numbers
against that branch's view of the sequence. Two branches opened from the same trunk each see the same
gap and each mint it. That is #48: two records numbered `0027`, authored the same day on separate
branches, one of them explaining the gap it believed it was filling.

Take the number from the trunk, not from your branch:

1. `git fetch origin` and read the highest number on `origin/main`, not the highest in your worktree.
2. Re-check immediately before opening the PR. If the trunk moved, renumber yours to the next free
   number.
3. When two branches still collide, the branch that lands second renumbers, and it moves its heading
   and every citation of its number -- as ADR-0030 and ADR-0031 did when they met the trunk's
   ADR-0029.

`test/arch/adr-numbering.test.ts` enforces the result: numbers are unique, a declared `# ADR-NNNN`
heading agrees with its filename, and records from 0013 on declare their number. It cannot see a
branch that has not landed, which is exactly why step 2 stays manual.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
