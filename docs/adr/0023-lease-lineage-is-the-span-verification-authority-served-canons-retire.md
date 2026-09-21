# ADR-0023 — Lease lineage is the span verification authority; served canons retire

Date: 2026-09-21

## Status

accepted — amends [ADR-0016](0016-content-addressed-line-identity-supersedes-healing.md)'s verification clause (the fast path is no longer a verification exemption), [ADR-0018](0018-region-scoped-rejection-serves.md)'s Consequences (interior coverage is lease identity, not the mirror), and [ADR-0022](0022-file-scoped-canons-and-fresh-read-stale-range.md) decision 1 (the canon no longer travels with the row: it is derived on demand from the lease). Does **not** supersede those Decisions: content-addressed `line_id` leases still decide identity, reject-and-serve still serves the current on-disk range on the same transaction-free path, and `[E_STALE_RANGE]` still serves a fresh read.

Amends [ADR-0016 — Content-addressed line identity supersedes heuristic canon healing](0016-content-addressed-line-identity-supersedes-healing.md)

Amends [ADR-0018 — Region-scoped rejection serves; a retired identity recovers by re-read](0018-region-scoped-rejection-serves.md)

Amends [ADR-0022 — Served canons are file-scoped; `[E_STALE_RANGE]` serves a fresh read](0022-file-scoped-canons-and-fresh-read-stale-range.md) decision 1 (a canon no longer travels with the row: it is derived on demand from the lease)

Amends [ADR-0016 — Content-addressed line identity supersedes heuristic canon healing](0016-content-addressed-line-identity-supersedes-healing.md)

Amends [ADR-0018 — Region-scoped rejection serves; a retired identity recovers by re-read](0018-region-scoped-rejection-serves.md)

## Context

Two live defects, both reachable only with canon evidence in hand.

**1. The fast path verified boundaries, not spans.** Spec §5.3 qualified the $O(1)$ fast path on the two boundary leases' `served_snapshot_hash` alone, and `served-verification.ts` then checked the interior against the *served mirror's anchor strings*. Three characters are a spelling, not an identity: after paged reads leave an interior row leased to $S_0$ while the boundaries were re-leased to $S_1$, an externally rewritten interior line that happens to hash to the same 3-char anchor satisfies the hash tier, so the span was applied at coordinates whose interior identity nobody had checked. `rg servedSnapshotHash src/` showed the boundary predicate was the only snapshot comparison in the tree.

**2. The evidence substrate duplicated canon text.** `served.canons` persisted the whitespace-stripped text of every served line parallel to its hash, while `served_leases.canon_hash` and `line_lineage.canon_hash` already stored the canon *digest* the pairing engine pairs on. The duplicate array was the only source of canon evidence, so the verification verdict depended on a column that can be stale (a mirror row written without its content's snapshot) or poisoned (issue #149 — now fixed by file-scoping, but the duplicate remains).

## Decision

**Three checkable statements.**

1. **One gate for every leased span.** `resolveLeasedEdit` computes the served window once and runs `verifyRebasedSpan` over it on both paths before any write: the fast path is the rigid remap whose rebased coordinates equal the served ones (`rebasedStart === fromLine`, `rebasedEnd === toLine`), the dynamic rebase path is the remap through `line_lineage(C)`. The gate requires, for every row of the window, a served mirror row, a lease for the anchor it names, `retired_at IS NULL`, and `rebasedLineOf(lease.line_id) === rebasedStart + k`. `verifyServedRange` is retired from the leased edit path; it survives only for the library-level `applyEdit` seam, a caller that presents a served mirror and **no** lease source. Check: `test/hashline/mixed-snapshot-interior.test.ts` — mixed-snapshot interior + same-anchor collision + **no** canon evidence still rejects `[E_STALE_RANGE]`; it applies silently on the pre-#151 code.

2. **One canon identity, derived, never stored.** `canonDigest(line)` = `String(xxh32(canon(line)))` is the single definition of the value `line_lineage.canon_hash` / `served_leases.canon_hash` persist. Every canon comparison — the served-row evidence scans, the drift rotated-survivor check, the library-level `verifyServedRange` tier — compares digests derived on demand from the lease that carries them. `served.canons` is read and written by no v7 code path. Check: `test/arch/serve-recording-seam.test.ts` (the shared writer body contains no canon step) and `test/core/serve-recording.test.ts` ("scopes canon evidence per file when two files share one 3-char anchor (#149, #151)").

3. **Absence is silence, not refusal.** With no lease for a position there is no digest, and every evidence scan stays silent — never a shape refusal. The consequence is stricter, not weaker: a rotation the tool cannot evidence is reported as drift instead of being suppressed by an unverifiable canon. Check: `test/core/serve-recording.test.ts` ("an unevidenced rotation is reported, never suppressed").

### Considered Options

- **Keep the fast path boundary-only and add a canon tier to it** — rejected: it re-derives identity from anchor strings, which is exactly the collision the falsification test injects; the canon tier only narrows the window in which the defect is reachable.
- **Verify the fast path against the mirror and the rebase path against `line_lineage` separately** — rejected: two gates that must agree by construction, and the fast path's mirror tier is strictly weaker than the lease tier it would duplicate. A `rebasedStart === servedStart` remap already expresses the fast path's semantics.
- **Keep `served.canons` and derive only the new checks from lineage** — rejected: two canon sources with different staleness, where the weaker one decides the verdict. The duplicate is the defect, not the storage cost.
- **Drop the `canons` column outright** — rejected for the v6 compatibility shell only: an un-restarted v6 process prepares a statement naming `canons` at store open, so removing the column breaks that process's whole mirror, not just its canon sync. The column survives as an unwritten shell; `CONTEXT.md` and the schema comments say so.

## Consequences

- Verification is a lease question on every path, so a mixed-snapshot span cannot ride a boundary qualification into an unchecked interior — the `#151` falsification test is the executable proof.
- `served.canons` holds no v7 data; `ServedRow` carries position and hash only, and no producer stamps a canon. The read path, edit diffs, undo restores, write hooks and drift serves all got smaller.
- `loadCanons` is replaced by `loadCanonDigests` (served mirror positions → their lease's `canon_hash`), which returns `[]` when no lease exists — the documented absence policy.
- Existing stores keep the legacy column, and the v6-shell tests in `test/core/hash-store.test.ts` / `test/core/served-store.test.ts` keep pinning that shell. Revisiting this decision means revisiting the mixed-version contract, not just the schema.
- Load-bearing assumption: a serve that records mirror rows also grants leases for them (spec §3.1.2 — every caller that knows the served content supplies `contentHash`). A mirror row written without a lease now has no evidence at all; the two deliberate `contentHash`-absent paths (preview serves, undo's mirror-only `recordTruncated`) stay fail-closed or already leased by their restore transaction.
