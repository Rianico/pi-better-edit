# ADR-0019 — Rename two model-facing error codes

Date: 2026-09-18

## Status

accepted — amends [ADR-0014](0014-user-model-audience.md)'s rename table.
ADR-0014's Decision is **not** superseded: audience routing (`[MODEL]` /
`[USER]`), the `adj+noun` family, and the no-alias precedent stand; this record
extends that table with two further hard renames. ADR-0014 itself is left
untouched as an accepted record.

Amended by [ADR-0021 — Unified error and warning contract: the accepted record](0021-unified-error-and-warning-contract.md)

## Context

ADR-0014 aligned the `E_*` family to `adj+noun` with no alias and recorded the
mapping in its rename table. Two codes kept names the maintainer now replaces
verbatim: the anchor-syntax refusal and the served-row reproduction refusal.
Both names appear on live contract surfaces (`src/`, `test/`, `README.md`,
`CONTEXT.md`, `docs/spec/` living specs); accepted ADR prose and `CHANGELOG.md`
history keep the original codes as historical quotes and are never rewritten.
An intermediate candidate `E_MALFORM_TEXT` for the served-row reproduction
refusal was rejected during review before the branch was pushed, so no
rename-then-rename trail is recorded — the decision below carries the
final names only.

## Decision

Hard rename, no alias (ADR-0014 precedent):

- `E_BAD_ANCHOR` → `E_MALFORMED_ANCHOR`
- `E_SERVED_ECHO` → `E_SUSPICIOUS_TEXT`

No alias is kept: `rg -nw` under `src/` for either original code is empty, and
the suite's error-code assertions are updated for names only. Semantics do not
drift with the names: `E_SUSPICIOUS_TEXT` stays evidence-gated (fires only when
`replace_with` reproduces rows actually served for this session, path, and
line — never for shape alone) with the `mode: "literal"` escape intact, and
`E_MALFORMED_ANCHOR` keeps the exact meaning of an anchor field that is not a
bare 3-char hash. `CONTEXT.md` `_Avoid_` vocabulary gains no deprecated
synonym.

## Consequences

- Live surfaces carry the new codes; mirrors stay in sync
  (`src/payload-contract.ts` `EDIT_DESCRIPTION` / `EDIT_GUIDELINES` ==
  `prompts/**`, test-enforced suites green).
- Behavior is unchanged beyond the code strings in model-facing messages and
  rejection payloads.
- The terminology guard (`test/arch/terminology-synonyms.test.ts`) tracks the
  new code and path-exempts the accepted records above, including this file as
  the rename record itself.

## Rename procedure (2026-09-19)

Retiring a name syncs the live docs in the same task (`CONTEXT.md`,
`README.md`, `src/`, `docs/spec/`), so no accepted record claims a contract
the code does not honor. The same task adds or updates exactly the baseline
entries the retirement needs in `test/arch/terminology-synonyms.test.ts` —
each entry names the file, the retired codes it still quotes, and the record
that retired them. No unattributed growth: a file outside the baseline stays
fully checked, and an entry whose file no longer quotes its declared codes
must be deleted (the arch guard enforces this shrink-only rule).
