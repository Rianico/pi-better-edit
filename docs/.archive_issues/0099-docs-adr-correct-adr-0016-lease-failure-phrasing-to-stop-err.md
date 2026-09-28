# docs(adr): correct ADR-0016 lease-failure phrasing to stop error-code drift

> **Archived from pre-migration issue #99.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T10:56:35Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## Finding - the ADR conflates the boundary-anchor lookup with the interior-span verifier (error-code drift)
`docs/adr/0016-content-addressed-line-identity-supersedes-healing.md`, Decision paragraph:

> "`tryHealOrphanedSpan` and `src/hashline/healing/*` are deleted, not adapted; an anchor with no lease now rejects with `[MODEL] [E_UNSERVED_RANGE]`, and a retired `line_id` rejects with `[MODEL] [E_STALE_RANGE]`."

The same ADR's Consequences section (L26) shows what was actually meant: "`test/core/served-verification.test.ts` asserts the fail-closed `E_UNSERVED_RANGE` result for un-rebased coordinates" - i.e. the interior-span verifier (`ServedVerification`), not the boundary-anchor lookup in `resolveLeasedEdit`.

The sentence is the origin of the recurring review disagreement about which code an unleased anchor raises.

## Authority
- Spec Revision 22 line 7: "Supersedes: ... Revision 20, and all prior spec drafts. This document is the sole authoritative specification."
- Spec section 3.1 line 89 and the section 5.3 decision table (normative for codes).
- `CONTEXT.md` taxonomy: `anchor staleness` covers the boundary anchors (`anchor_from`/`anchor_to`) -> `[MODEL] [E_STALE_ANCHOR]`; `never-served` / `served-range staleness` covers interior lines strictly between the anchors -> `[MODEL] [E_UNSERVED_RANGE]`; retired/deleted `line_id` or span tearing -> `[MODEL] [E_STALE_RANGE]` with echoed rows (`reject-and-serve`).

## Remedy
Amend that single phrase in the Decision paragraph to separate the two seams, e.g.:

> "an unleased anchor rejects with `[MODEL] [E_STALE_ANCHOR]` (or `[MODEL] [E_UNSERVED_RANGE]` when unread interior spans are verified)"

Keep the amendment to this one phrase. ADR-0016 is itself part of this unpushed delivery (added by `8632012`), so correcting its wording is not rewriting a released record. Its role as the superseding record for ADR-0008/0013 is unchanged.

## Acceptance criteria
- The Decision paragraph no longer states that an anchor with no lease rejects with `E_UNSERVED_RANGE`; the three error codes are attributed to their correct seams (`E_STALE_ANCHOR` = unleased boundary anchor, `E_UNSERVED_RANGE` = unread interior span, `E_STALE_RANGE` = retired/deleted `line_id` or torn span).
- No other part of the ADR changes: status, context, considered options (including the rejected content-equality fallback), consequences and references stay byte-identical.
- The amended wording agrees with `CONTEXT.md` and with the spec section 5.3 decision table, and no other file is touched.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:39:55Z

Delivered.

Merged into `dev/mvcc-line-identity` and squashed into `main` @ `bd3a8f2` (this remediation is included in that squash). Verified at delivery by the composite gate — `pnpm run lint` / `format` / `typecheck` / `test:coverage` (coverage ≥ 85% lines/statements/functions, ≥ 80% branches) — plus the 15-test Stage-0 harness with the four fail-closed probes keeping their byte-identity assertions.

Closing.
