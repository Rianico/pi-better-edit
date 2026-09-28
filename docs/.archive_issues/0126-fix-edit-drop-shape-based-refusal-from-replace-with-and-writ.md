# fix(edit): drop shape-based refusal from replace_with and write content

> **Archived from pre-migration issue #126.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-15T16:42:06Z · state CLOSED · labels: ready-for-agent

## Body

Repo: `Rianico/pi-better-edit`. Depends on: the evidence gate + literal declaration ticket. Downstream context: `Rianico/dsh-better-edit#63` (this ticket is what closes it, upstream).

## Why
The evidence gate now owns the trigger, so the shape authority must go. Verified defects it causes: literal content that merely *looks* like tool output is refused (`zzz│text`, `   abc│text`, a markdown bullet `- wUp│    pass`), the refusal is total (atomic batch, nothing written), the message claims "stripped …" when nothing was stripped, and the `hasServedCopy` catch at `src/hashline/apply.ts:282-302` swallows the refusal exactly when the prefix *is* served — inverting the guard. Both strippers also carry unreachable `return` statements (the two `no-unreachable` lint warnings at `src/hashline/resolve.ts:405` and `:428`).

## Scope
1. Delete `stripBarePrefixes`' **content** arm and its dead `return` (`src/hashline/resolve.ts`). **Keep** the `anchor_from`/`anchor_to` bounds refusal in the same file and keep `swapReversedRanges`: on a bounds field the value space *is* anchors, so shape genuinely is the error, and its message is already correct.
2. Delete the catch at `src/hashline/apply.ts:282-302` (`hasServedCopy` swallow + `warnings.length = 0`).
3. Delete `stripDiffPrefixes` (and its dead `return`) — marker tolerance now lives inside the unified predicate.
4. Drop parameters left unused (`_warnings`), tidy `prepareEdit`.
5. Flip the pinned tests to the settled semantics: `test/tools/edit.test.ts` (the "refuses served hash echo … (deny, not strip)" case), `test/integration/batch-legacy-tombstone.test.ts`, the `E_BAD_ANCHOR` shape cases in `test/core/hashline-strict-input.test.ts` / `test/core/hashline.recovery.test.ts`, and **`test/integration/downstream-issue-verification.test.ts` — its `it.fails` pin for downstream #63 must become a plain `it`** (literal `abc│text` now writes through byte-exact).

## Acceptance
- Byte-exact writes for literal content: `abc│text`, `   abc│text`, `KEY│value`, the markdown bullet `- wUp│    pass`, and ASCII `abc|text`.
- Verbatim reproduction of a served row is still refused (evidence gate), and `mode: "literal"` still escapes it.
- `anchor_from`/`anchor_to` carrying a `HASH│` prefix still throws `[E_BAD_ANCHOR]` with the existing message.
- No content is ever rewritten: `replace_with` bytes reach disk unchanged.
- Lint shows zero `no-unreachable` warnings; full gate green: `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage`.

## Non-goals
No ambiguous-tier note (next ticket). No behavior change beyond removing shape refusal. Do not touch the evidence predicate or the gate.


## Comments

### @Rianico — 2026-09-17T16:31:03Z

Landed in #134 — squash `ba7c8d2` on `main` (the PR body's comma-separated `Closes` list only linked the first reference per line).
