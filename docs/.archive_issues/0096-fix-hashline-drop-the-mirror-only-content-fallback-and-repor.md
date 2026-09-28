# fix(hashline): drop the mirror-only content fallback and report E_STALE_RANGE for a retired line

> **Archived from pre-migration issue #96.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T10:41:02Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

Post-implementation review 2, cluster: lease resolution. Two findings, both resolved by the spec plus ADR-0016/0017 (the newest ADRs, which supersede ADR-0008/0013).

## 1. Remove the mirror-only content fallback (`leaseOwned`) — spec + ADR-0016
**Authority**:
- Spec line 89: "If anchor is missing -> throw `[E_STALE_ANCHOR]`. If `retired_at` is set -> throw `[E_STALE_RANGE]`."
- Spec line 637 (section 5.3 table): "Anchor not present in `served_leases` | `resolve.ts` (`valEdit`) | `[MODEL] [E_STALE_ANCHOR]` | Echoes current range; model retries".
- `docs/adr/0016-content-addressed-line-identity-supersedes-healing.md` L21: "**Keep content equality as a fallback when the lease is missing** - rejected: it re-opens the same silent rebind; the fail-closed path plus `reject-and-serve` costs one echo turn, not a corruption."

**Violation**: `src/hashline/apply.ts` L174-188 `leaseOwned` returns false when neither anchor holds a lease, and `src/hashline/resolve.ts` L213-228 then falls back to the legacy content-based `valEdit` plus mirror verification. That is the rejected content-equality fallback.

**Remedy**: delete the mirror-only fallback. An anchor with no lease fails closed with `[MODEL] [E_STALE_ANCHOR]` and the current-range echo. A preview / `noPersist` serve keeps its documented read-only behaviour (ADR-0001) - it simply grants no leases, so an edit resting on unleased anchors rejects instead of content-resolving; a fresh `read` grants the leases.

## 2. Retired anchor absent from content: wrong error code — spec line 89 / 639
**Violation**: `src/hashline/resolve.ts` L96-97 - a retired lease whose `contentLine === undefined` returns `{ kind: "content" }`, and `src/hashline/lease-resolve.ts` L159-168 then raises `[E_STALE_ANCHOR]` via `throwStaleAnchor`. Spec line 89 and the section 5.3 table (line 639: "Leased `line_id` deleted or retired (Probe `E`, `A`) | `resolve.ts` (`valEdit`) | `[MODEL] [E_STALE_RANGE]`") require `[E_STALE_RANGE]` for a retired/deleted leased line.

**Remedy**: a retired lease whose line is gone from content rejects with `[E_STALE_RANGE]` (with the current-range echo), never `E_STALE_ANCHOR`.

## Error-code authority
The spec section 5.3 decision table is normative for which code is emitted: `E_STALE_ANCHOR` = anchor not leased, `E_STALE_RANGE` = leased but retired/deleted or span torn, `E_UNSERVED_RANGE` = interior line never served. ADR-0016's sentence "an anchor with no lease now rejects with `[MODEL] [E_UNSERVED_RANGE]`" describes the never-served interior case. If after implementing this a genuine conflict remains, record the reconciliation in the commit body rather than silently choosing.

## Acceptance criteria
- `leaseOwned` and its legacy `content + mirror` fallback path are gone; the `leaseOwned` call site in `mutation-engine/pipeline.ts` (~L535) is updated accordingly and no unleased anchor reaches content-anchor resolution.
- Unleased anchor -> `[MODEL] [E_STALE_ANCHOR]` with a fresh current-range echo; never-served interior -> `[E_UNSERVED_RANGE]` (unchanged); retired/deleted leased line -> `[E_STALE_RANGE]`.
- Unit tests assert the three codes directly, including the retired-and-absent-from-content case.
- `E_SERVED_ECHO`, `E_REVERSED_ANCHORS` and `E_BAD_ANCHOR` behaviour is unchanged.
- All 15 Stage-0 harness tests pass, including the four fail-closed probes with byte-identical file assertions and the auto-rebase probes B/C/D.
- `test/tools/preview-no-persist.test.ts` and `test/core/read-preview.test.ts` still pass: previews stay read-only and persist nothing.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:39:45Z

Delivered.

Merged into `dev/mvcc-line-identity` and squashed into `main` @ `bd3a8f2` (this remediation is included in that squash). Verified at delivery by the composite gate — `pnpm run lint` / `format` / `typecheck` / `test:coverage` (coverage ≥ 85% lines/statements/functions, ≥ 80% branches) — plus the 15-test Stage-0 harness with the four fail-closed probes keeping their byte-identity assertions.

Closing.
