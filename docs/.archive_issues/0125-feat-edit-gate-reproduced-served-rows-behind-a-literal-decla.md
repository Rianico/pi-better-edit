# feat(edit): gate reproduced served rows behind a literal declaration

> **Archived from pre-migration issue #125.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-15T16:42:04Z · state CLOSED · labels: ready-for-agent

## Body

Repo: `Rianico/pi-better-edit`. Builds on: the glossary/ADR amendment ticket. Downstream context: `Rianico/dsh-better-edit#63`.

## Why
Today's guard refuses on *line shape* and, on the content surface, a catch-all swallows that refusal whenever the prefix happens to be a served anchor — so a **verbatim row or chain copied from another range is written into the file** (reproduced: `one\ntwo\nhvX│one\nn4z│two\n`), while legitimate literal content is refused. Replace the shape trigger with the evidence trigger the ADR specifies, and give the caller a way to declare intent.

## Scope

**Trigger — evidence, never shape.** A candidate line, after skipping an optional leading git diff marker (`+`, `-`, or a single space), begins with `<anchor>│` where `anchor` was served for this session + path at **any** position, AND `canon(remainder) === canon(content served for that anchor)`. One row suffices. No canon data ⇒ no evidence ⇒ no match (silent; never fall back to shape).

**One predicate, both surfaces.** Unify `src/hashline/apply.ts#findEditHashEcho` and `src/write-hook.ts#findServedHashEcho` into one `findServedHashEcho(lines, served, canons, start)` returning the matched candidate index, anchor, and the line that anchor was served for; consumed by both the edit apply path and the write hook. Rename `EditHashEchoError` → `ServedHashEchoError` (`src/hashline/index.ts` re-exports) and the bare `echo` local in `src/write-hook.ts` → `reproduction`. Update `test/arch/terminology-synonyms.test.ts`: `CANONICAL_TOKENS` drops `findEditHashEcho`/`EditHashEchoError` and adds `ServedHashEchoError`; amend its `#108` note to freeze **served-qualified** names only; re-examine the `src/write-hook.ts` allowlist exemption and remove it if no longer needed.

**Payload.** `mode?: "general" | "literal"` — the first optional field on the edit request. `src/payload-contract.ts`: add to `ROOT_KS`, schema `Type.Optional(Type.Union([Type.Literal("general"), Type.Literal("literal")]))`, update the "must be exactly" rejection + hint, thread through `normReq` / `prepareEditArguments`. On `write`, read `input.mode` in `src/write-hook.ts`; pi's builtin schema tolerates the extra top-level field (verified with TypeBox `Compile` — record that dependency in a code comment). Absent = `general`.

**Gate.** Predicate matches and `mode !== "literal"` → refuse `[MODEL] [E_SERVED_ECHO]`, pre-write, file byte-identical. The message must name the offending replacement line, the anchor, the line that anchor was served for, that tool output is not file content, "nothing was written", the literal fragment `mode: "literal"`, and a re-read fallback. It must **not** render a `│`-joined row (the guard's own message must not become a paste source).

**Escape.** `mode: "literal"` → proceed **byte-exact** (never strip or rewrite content), emit a dimmed `[USER]` line ("served-echo check bypassed by literal declaration") and a `literalDeclarations` count in `details.metrics`. On `write`, append the dimmed line via the existing `tool_result` handler (the seam that already appends auto-read rows).

**Counter.** Follow `src/noop-guard.ts`: in-memory map keyed by the refused payload (path + range anchors + offending replacement line), no persistence, cleared like `noopLoopTracker`. The refusal carries the submission count and sharpens from the 2nd identical refusal. **Never auto-force.**

**Prompts.** `prompts/edit.md` documents `mode` in one clause; `prompts/edit-guidelines.md` replaces "never emit `│` anywhere in your call" and "the call is refused when a line echoes a served anchor" with the rule + the declaration. No bullet advertising the escape.

## Acceptance
- Tests: verbatim row and a multi-row chain copied from another position are **refused** on `edit` **and** `write`; same-position verbatim refused; ambiguous case (served prefix, differing content) is **not** refused any more; never-served shape on `write` unaffected; declaration honoured → content byte-exact + dimmed line + metric; counter sharpens wording at the 2nd identical refusal and never auto-forces.
- `mode` absent behaves as `general`; an unknown root field still fails `E_BAD_PAYLOAD` (with `mode` named in the hint).
- Full gate green: `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage`.

## Non-goals
Do **not** delete `stripBarePrefixes`' content arm, the `hasServedCopy` catch, or `stripDiffPrefixes` — that is the next ticket, and it must land only after this gate exists. No ambiguous-tier `[MODEL]` note here. No persistence.


## Comments

### @Rianico — 2026-09-17T16:30:58Z

Landed in #134 — squash `ba7c8d2` on `main` (the PR body's comma-separated `Closes` list only linked the first reference per line).
