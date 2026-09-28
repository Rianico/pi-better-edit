# docs(adr): amend ADR-0009 with served-row evidence and the literal declaration

> **Archived from pre-migration issue #124.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-15T16:42:02Z · state CLOSED · labels: ready-for-agent, released

## Body

Repo: `Rianico/pi-better-edit`. Downstream context: `Rianico/dsh-better-edit#63`.

## Why
A design session settled how the `edit` / `write` guard must treat tool output reproduced as file content. Record being amended: `docs/adr/0009-bounded-hash-echo-guard.md`. Settled guarantee: **never unwittingly** — reproduced served rows reach disk only under an explicit declaration by the caller.

## Scope — docs only, no code

`CONTEXT.md`:
1. **`served hash echo`** — redefine the condition: *a candidate line that begins with a served anchor **and** reproduces the content that anchor was served with, at any position*. Keep "detected before dispatch/write, file stays byte-identical" and "Not a generic `^[A-Za-z0-9]{3}│` strip". ADD the invariant: *detection is evidence-only — the tool never gates on the shape of a line.* ADD the qualifier note: `_Avoid_: hash echo (without served qualification)` targets the unqualified **condition** name; a served-qualified identifier (`findServedHashEcho`) is canonical, a surface-qualified one (`findEditHashEcho`) is not.
2. **NEW `literal declaration`** — the caller's explicit assertion, via `mode: "literal"`, that bytes reproducing served rows are intended file content; the sole escape from `E_SERVED_ECHO`. `_Avoid_: force, override, bypass`.
3. **`│`** — amend the prohibition: never emitted "in `anchor_from`/`anchor_to`, or anywhere in the call — **except** under a `literal declaration`, which asserts the bytes are content".
4. **`E_SERVED_ECHO`** — refusal names the reproduced row's real coordinate, states "nothing was written", and carries the literal fragment that escapes it.

`docs/adr/0009-bounded-hash-echo-guard.md` — add a dated revision section recording: (1) the refined condition (position-agnostic, content-matched, one row suffices, optional leading `+`/`-`/space git diff marker tolerated, no canon data ⇒ no evidence ⇒ silent); (2) **this ADR's own deferred option E2 is closed** in evidence-based form — the deferral reason was false-positive cost on docs, which content matching removes; (3) `literal declaration` is the sole escape, so the guarantee reads "never unwittingly"; (4) shape-based refusal on the content surface is removed — record that the shipped code had drifted from the ADR's own "never generically strip / `Zz9│literal` stays valid" decision; (5) the `#108` "MUST NOT rename" freeze now covers served-qualified names only; (6) the declaration is auditable (dimmed `[USER]` line + a `literalDeclarations` metric).

## Acceptance
- Both terms exist with exactly those clauses; `│` and `E_SERVED_ECHO` carry the amendment.
- ADR-0009 gains a dated revision section, amending in place (no new ADR) and naming the clause it supersedes.
- `pnpm run lint && rtk pnpm run format && rtk pnpm run typecheck && rtk pnpm run test` green. **Gotcha:** `test/arch/terminology-synonyms.test.ts` audits binding docs (`CONTEXT.md` + `docs/adr/**`) — after canonical-token stripping no `/echo/i` may remain, so use canonical phrases only.
- `CONTEXT.md` stays a glossary: no implementation detail.

## Non-goals
No code, prompts, or test changes. Do not touch ADR-0014/0016/0017.


## Comments

### @github-actions — 2026-09-21T16:47:42Z

:tada: This issue has been resolved in version 2.0.0 :tada:

The release is available on [GitHub release](https://github.com/Rianico/pi-better-edit/releases/tag/v2.0.0)

Your **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:
