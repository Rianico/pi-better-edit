# absorb: upstream v1.6.0 audience split + glossary error-code renames (T1)

> **Archived from pre-migration issue #75.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-05T12:22:22Z · state CLOSED · labels: (none)

## Body

Upstream `dd1a779` (closes pi-better-edit#65, ADR-0014) + `b0bcf0b` prompts alignment. We still emit the full old `E_*` family.

**Scope**
- Rename to adj+noun, no aliases: `E_BAD_SHAPE`→`E_BAD_PAYLOAD`, `E_RANGE_STALE`→`E_STALE_RANGE`, `E_RANGE_UNSERVED`+`E_RANGE_UNVERIFIED`→`E_UNSERVED_RANGE` (with `details.unservedKind`), `E_NOT_TEXT`→`E_UNSUPPORTED_FILE` (trim affordance), `E_FILE_TOO_LARGE`→`E_LARGE_FILE`, `E_WOULD_EMPTY`→`E_EMPTY_RANGE`, `E_EDIT/WRITE_HASH_ECHO`→`E_SERVED_ECHO`, `E_BAD_OP`→`E_REVERSED_ANCHORS`, `E_BARE/INVALID`→`E_BAD_ANCHOR` (throw, not heal), `E_AMBIGUOUS`→`E_STALE_ANCHOR`.
- Display-layer audience only: raw `details.errCode` stays bare `E_*`; error content headers emit `[MODEL] [E_*]`, warnings/driftNotice emit `[USER]` dimmed.
- Drift notice moves to details-only user surface; batch drift note retired from user surface (already filtered from model content in `edit-response.ts` — extend to full routing).
- Glossary realignment in CONTEXT.md (anchor vs served-range staleness, served range alias) + new ADR (upstream ADR-0014 equivalent, adapted to our seams).
- Adapt prompt changes to our `guidance/` system, not verbatim port of their `payload-contract.ts` prompts.

**Acceptance**
- `rg 'E_BAD_SHAPE|E_RANGE_STALE|E_RANGE_UNSERVED|E_RANGE_UNVERIFIED|E_NOT_TEXT|E_FILE_TOO_LARGE|E_WOULD_EMPTY|E_EDIT_HASH_ECHO|E_WRITE_HASH_ECHO|E_BAD_OP|E_BARE_HASH_PREFIX|E_INVALID_PATCH|E_AMBIGUOUS_ANCHOR' src/` returns zero hits.
- Tests updated to new codes + `[MODEL]`/`[USER]` prefixes; `npm run typecheck && npm test` green.

Upstream basis: `pi-better-edit@87a17eb` (v1.6.0). Part of sync audit 2026-09-05.

## Comments

### @Rianico — 2026-09-05T12:22:27Z

Created in the wrong repo by automation — tracked in dsh-better-edit instead.
