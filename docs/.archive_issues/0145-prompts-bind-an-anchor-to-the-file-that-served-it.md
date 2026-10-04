# prompts: bind an anchor to the file that served it

> **Archived from pre-migration issue #145.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-18T09:21:07Z · state CLOSED · labels: enhancement, ready-for-agent

## Body

## Problem

3 of the 7 failures in the 2026-09-15 session were cross-file anchor reuse (`yHj`, `8Od`, `8vX`): an anchor served for one path was submitted for another. The rejection reads as "the file was never read", so the model reads again instead of fixing the anchor source.

The collision is systematic, not rare: the first blank line of unrelated files hashes to the same anchor (`AuN`), because the preferred index of `canon("")` is a constant (measured over four files).

## Fix

State in the model-facing contract that an anchor is bound to the file whose served rows it came from.

- `prompts/edit.md` **and its single source** `EDIT_DESCRIPTION` in `src/payload-contract.ts`.
- `prompts/edit-guidelines.md` **and** `EDIT_GUIDELINES` in `src/payload-contract.ts`.
- `prompts/read.md` — one clause: the 4-char hash is file-scoped.
- Do **not** touch `prompts/read-guidelines.md`: `test/extension/prompts.test.ts` asserts it must not contain the string "re-read".

Wording proposal (must be byte-equal in file and constant):

> edit: an anchor is bound to the file it was served from — its lease is (session, path, anchor), so an anchor copied from another file's rows is refused; copy anchors only from this file's served rows.

## Acceptance

- File and constant stay byte-equal where the tests require it (`test/extension/prompts.test.ts`, `test/core/prompts.test.ts` pass with no weakened assertion).
- Cross-file anchor reuse stops appearing in session logs (observe the next session; no code change).
- Prompt text stays short: the description is model-facing signal in every session.

## Notes

- The constant is the single source for the file, so both must move in one commit (the tests enforce the pairing).
- Related: #136 (same surfaces, different clause).


## Comments

### @Rianico — 2026-09-18T10:23:03Z

## Approved (2026-09-15)

Wording approved as proposed:

> edit: an anchor is bound to the file it was served from — its lease is (session, path, anchor), so an anchor copied from another file's rows is refused; copy anchors only from this file's served rows.

Coupling to respect while implementing: `prompts/edit.md` + `EDIT_DESCRIPTION` and `prompts/edit-guidelines.md` + `EDIT_GUIDELINES` must move in one commit (the tests enforce the pairing), and `prompts/read-guidelines.md` must not gain the string "re-read".


### @Rianico — 2026-09-20T14:32:52Z

Verified on `main` @ `3b22008` (landed as `ddd01f7`).

`prompts/edit.md` now binds the anchor to its source: "copy the 4 chars before `│` in **this file's** served `HASH│content` lines (lease (session, file, anchor))", with the `EDIT_DESCRIPTION` mirror in `src/payload-contract.ts` kept byte-equal by a test. The cross-file case also gained its own code, so the reuse no longer reads as "the file was never read": `[E_FOREIGN_ANCHOR]` names the path where the anchor was actually served (ADR-0021 decision 3).

Closing as resolved.
