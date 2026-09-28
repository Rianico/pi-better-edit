# feat(hashline): retire served.canons and unify span verification on lease lineage (Option C)

> **Archived from pre-migration issue #151.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-21T03:46:17Z · state CLOSED · labels: enhancement, ready-for-agent, released

## Body

### Is there an existing issue for this?
- [x] I have searched the existing issues

### Problem — is your request related to a problem?
Currently, `pi-better-edit` maintains two parallel storage representations of line content in a session:
1. **The MVCC Storage Tier**: `served_leases` (keyed by `session_id, file_path, anchor`) tracking `line_id`, `canon_hash`, `served_snapshot_hash`, `served_line_number`, and `retired_at`, alongside `line_lineage`.
2. **The Legacy Session Tier**: `served.canons` in the SQLite `served` table (`PRIMARY KEY (session_id, path)`), which stores a positional array of canonical strings.

While Issue #149 resolved the cross-file poisoning bug by stamping `canon` directly from line producers into `ServedRow`, maintaining `served.canons` creates:
- **Dual authority**: Two separate mechanisms for checking whether lines in a span are stale or modified.
- **Divergent verification paths**: The rebased path validates spans using identity leases and line retirement (`verifyRebasedSpan`), whereas the fast path still validates spans using the legacy positional arrays (`verifyServedRange`).
- **Database overhead**: Persisting large JSON arrays of canon strings into `served.canons` on every serve.

### Proposal — describe the solution you'd like
Implement **Option C** from the #149 architectural review:
1. **Retire `served.canons` column**: Deprecate and drop the `canons` column from SQLite table `served`.
2. **Unify span verification on lease lineage**:
   - Replace or deepen the fast-path `verifyServedRange` so that all span verification checks interior line leases (`leaseFor(anchor)`, `lineId`, and `retiredAt`), matching the principled model of `verifyRebasedSpan`.
3. **Derive evidence cleanly**:
   - For non-verification evidence consumers (`findServedHashEcho`, `findServedPrefixMismatches`, `drift`), derive canon identity from `served_leases.canon_hash` / `line_lineage`, or keep in-memory ephemeral producer stamping without persisting parallel arrays to SQLite.

### Alternatives considered
- **Option A (Delete canon tier without lease-backing)**: Rejected in review. Deleting the canon tier from `verifyServedRange` leaves a silent false-accept (miswrite) window when an interior line changes externally and collides on the same 3-character hash across paged reads.
- **Option B (Per-file structural map)**: Rejected. Still retains duplicate state outside of the MVCC lease store.
- **Option D (Status Quo - Landed in #149)**: Stamping `canon` onto `ServedRow` and keeping `served.canons` strictly file-scoped. This is fully working and correct today, but keeps the parallel array in SQLite. Option C is the natural structural evolution of Option D.

### Additional context
- Emerged from the architectural review of Issue #149 (ADR-0022).
- Architecture spec: `docs/spec/content-addressed-line-identity-mvcc.md` §4 (Storage Tier vs Session Tier).
- Relevant ADRs: ADR-0005, ADR-0016, ADR-0018, ADR-0022.

## Comments

### @Rianico — 2026-09-21T04:03:04Z

Scoping notes from the #149 review — these sharpen the acceptance criteria rather than restate the proposal.

## 1. The load-bearing work is the interior-lease check; here is the reproducer

`isUniformLeaseFastPath` (`src/hashline/resolve.ts:59-69`) tests **only** `from` and `to`; `rg servedSnapshotHash src/` shows that is the only comparison site in the tree. So the fast path applies at leased coordinates and interior freshness rests entirely on `verifyServedRange` — the hash tier (anchor equality, `src/hashline/served-verification.ts:678-690`) plus the canon tier.

Counterexample that must become the acceptance test (mixed-snapshot interior + same-anchor collision across paged reads):

1. read lines 1–10 at S₀ → `served`/`servedCanons` populated for 1–10.
2. external edit changes line 5; snapshot rotates to S₁; by chance the new content hashes to the **same 3-char anchor**.
3. partial re-read of lines 1 and 10 only → boundaries re-leased under S₁, line 5 keeps its S₀ entry.
4. edit spanning 1–10: fast path qualifies on the boundaries; gap check passes (`served[4] !== null`); the hash tier passes because of the collision.

Today the canon tier rejects. The point of this ticket is that it must reject **without** canons. Watch out for a false green: a naive stale-mirror test whose hash rotates naturally is caught by the hash tier and proves nothing — the collision must be injected on the interior line.

## 2. This is a spec revision, not just a refactor

Spec §3.5 (`docs/spec/content-addressed-line-identity-mvcc.md:637-641`) states fast-path qualification as an **iff over the two boundaries only**:

```
lease_from.served_snapshot_hash == C  ∧  lease_to.served_snapshot_hash == C
                                      ∧  lease_from.served_snapshot_hash == lease_to.served_snapshot_hash
```

and the failure table assigns interior coverage to `served-verification.ts`. So unifying the fast path on interior leases **changes a normative iff** — §3.5 must be amended, and ADR-0016 / ADR-0018 flagged per the ADR-0019 procedure (flag, never rewrite accepted prose).

Two rationale sentences to correct in the same PR, because they read as if the predicate snapshot-checks the whole span: `src/hashline/resolve.ts:54-57` ("Any mixed-snapshot span … takes the dynamic rebase path") and spec `:641` ("This prevents mixed-snapshot spans from bypassing per-line identity verification").

## 3. Lease coverage is already complete in-tool — no lease-gap fix needed

`grantLeasesForRows` (`src/served-session/session.ts:681-690`) early-returns when no `contentHash` is supplied, and `contentHash` is documented as "MUST be supplied by every caller that knows the served content" (`session.ts:706-710`). The two `contentHash`-absent paths are deliberate, not holes:

- preview serves grant nothing and stay fail-closed (`recordServeFeedback(..., "preview", ...)`, `src/mutation-engine/pipeline.ts:503`);
- undo's mirror-only `recordTruncated` (`src/edit-undo.ts:290`) is safe because the restore transaction granted the leases through `adoptPinnedSnapshotFor(..., { retireLeases: true, leases: { … } })`.

So proposal 3 does not need a lease-gap remedy.

## 4. Evidence substrate, and the constraint on it

`line_lineage` already carries `canon_hash` per `(snapshot_id, line_number, line_id, anchor)` (`src/snapshot-store/index.ts:76,171,387,527`), and `canonHash` drives snapshot pairing (`src/hashline/patience-pairing.ts:179-355`) — but `LeaseIdentityView.canonHash` (`src/hashline/resolve.ts:24`, threaded at `src/mutation-engine/pipeline.ts:308`) is never read for a verdict. Deriving evidence from lineage is therefore feasible.

Two constraints on the evidence tier:

- Canons must be **correct**, not merely present: `findServedHashEcho` (`src/hashline/apply.ts:287`) and `findServedPrefixMismatches` (`:382`) both consume `servedCanons ?? []`, so a poisoned canon yields a false negative or a spurious `E_SUSPICIOUS_TEXT`.
- Absence is **documented policy**, not a bug: "No canon data means no evidence, so the scan stays silent — never a shape refusal" (`src/hashline/apply.ts:281`), and both scans are `if (served)`-gated (`:275`, `:378`). A lease-derived source must preserve silent-on-absence rather than fail closed.

## 5. Stale reference to update in passing

`src/edit-undo.ts:283-285` says the legacy mirror "is still the authority the current `resolve`/`verifyServedRange` path reads, **until #85 lands the lease-only seam**". #85 closed on 2026-09-15 and delivered the boundary-only fast path, so the lease-only seam is currently unowned — this ticket is where it belongs, and that comment should name it.

## 6. Ordering

Land the falsification test from §1 first, in the red state: run the reproducer with `servedCanons` nulled and assert the span still rejects. That test is what licenses dropping the column; without it the deletion is unverifiable.

---

Context: Option D shipped as PR #152 (squash `47a04f7`), #149 closed, record in ADR-0022. Nothing is broken today — this ticket is the structural successor.


### @Rianico — 2026-09-21T06:01:14Z

## Implementation Alignment & Design Decision

Following architectural review against repository standards, *The Philosophy of Software Design*, and *Keel*, we have aligned on the following implementation plan for Option C:

### 1. Span Verification Unification (Option 1.3)
- **Unify onto `verifyRebasedSpan`**: Retire `verifyServedRange` from the leased edit path. All leased edits (whether unshifted fast-path or dynamically rebased) pass through `verifyRebasedSpan`.
- **Equivalence**: For a uniform span on disk, `rebasedStart === fromLine`, `rebasedEnd === toLine`, and `rebasedLineOf(lease.lineId) === currentLine`. This enforces identical interior lease integrity and retirement checks across all spans with $O(N)$ map lookup complexity.
- **Spec & ADR Revision**: Amend Spec §3.5 normative qualification iff (`docs/spec/content-addressed-line-identity-mvcc.md:637-641`) and add reciprocal flags to ADR-0016 / ADR-0018 per ADR-0019 procedure.

### 2. Evidence Substrate (Option 2.1)
- **Retire `served.canons` column**: Drop `canons` from the SQLite `served` table.
- **Derive evidence from `canon_hash`**: `findServedHashEcho` and `findServedPrefixMismatches` (`src/hashline/served-guard.ts`) derive canon identity from `served_leases.canon_hash` / `line_lineage` (`xxh32(canon(candidate)) === lease.canon_hash`), eliminating duplicate string storage from the session database.

### 3. TDD Ordering & Verification
1. **Red**: Land the falsification test from §1 (mixed-snapshot interior + same-anchor collision across paged reads) with `servedCanons` nulled, asserting that the span fails closed with `[E_STALE_RANGE]`.
2. **Green**: Implement the unified `verifyRebasedSpan` path and `canon_hash` evidence derivation; drop the SQLite `canons` column.
3. **Docs & Cleanup**: Update stale reference in `src/edit-undo.ts:283-285` (pointing to #151) and correct rationale sentences in `src/hashline/resolve.ts:54-57` and Spec line 641.

Handoff to agent underway.

### @github-actions — 2026-09-21T16:47:30Z

:tada: This issue has been resolved in version 2.0.0 :tada:

The release is available on [GitHub release](https://github.com/Rianico/pi-better-edit/releases/tag/v2.0.0)

Your **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:
