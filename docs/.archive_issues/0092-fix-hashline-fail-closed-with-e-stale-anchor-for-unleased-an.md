# fix(hashline): fail closed with E_STALE_ANCHOR for unleased anchors

> **Archived from pre-migration issue #92.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T08:03:10Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## Rule (spec Revision 22)
Spec section 3.1: "If anchor is missing -> throw `[E_STALE_ANCHOR]`". The section 5.3 failure table: "Anchor not present in `served_leases`" is owned by `resolve.ts` (`valEdit`) and must output `[MODEL] [E_STALE_ANCHOR]`, with recovery "Echoes current range; model retries". Fallback to content-anchor resolution is exactly the pre-MVCC behaviour the spec retires.

## Violation
- `src/hashline/lease-resolve.ts` L63 - `resolveLeasedEdit` returns `{ status: "fallback" }` whenever either anchor has no lease, and its own doc comment states the caller then "keeps the legacy content-anchor resolution".
- `src/hashline/apply.ts` L201-203 - the caller takes that fallback path and calls `valEdit(edit, fileLines, fileHashes, [], signal)` against disk hashes.

An unleased anchor can therefore still be satisfied by content-anchor resolution instead of failing closed, which is the class of silent miswrite the MVCC delivery exists to remove.

## Remedy
Make the unleased case fail closed in the lease path itself:
- an anchor with no active lease (or a lease whose identity cannot be resolved) is rejected with `[E_STALE_ANCHOR]` and a fresh-context echo of the current range;
- keep `[E_UNSERVED_RANGE]` for a never-served interior line (the model was shown no row for it) - do not collapse the two codes into one;
- the legacy content-anchor fallback must no longer be reachable for a session whose serve carried leases; document why in a comment that names the invariant.

## Acceptance criteria
- `resolveLeasedEdit` no longer returns `fallback` for an unleased anchor; the unleased case throws the fail-closed rejection with the correct code.
- A direct unit test asserts `E_STALE_ANCHOR` for an unleased anchor and `E_UNSERVED_RANGE` for a never-served interior line.
- Every existing rejection contract is preserved: `E_SERVED_ECHO`, `E_REVERSED_ANCHORS`, `E_BAD_ANCHOR` still behave as before.
- All 15 Stage-0 harness tests pass, including the fail-closed probes with their byte-identity assertions (file bytes unchanged on disk), and the auto-rebase probes B, C, D still apply cleanly.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:39:33Z

Delivered.

Merged into `dev/mvcc-line-identity` and squashed into `main` @ `bd3a8f2` (this remediation is included in that squash). Verified at delivery by the composite gate — `pnpm run lint` / `format` / `typecheck` / `test:coverage` (coverage ≥ 85% lines/statements/functions, ≥ 80% branches) — plus the 15-test Stage-0 harness with the four fail-closed probes keeping their byte-identity assertions.

Closing.
