# ADR-0018 — Region-scoped rejection serves; a retired identity recovers by re-read

Date: 2026-09-15

## Status

accepted — amends [ADR-0016](0016-content-addressed-line-identity-supersedes-healing.md)'s Consequences recovery clause. ADR-0016's Decision is **not** superseded: no non-leasing serve is introduced, so `serve` remains the only operation that presents an anchor and it still does so through the atomic lease upsert.

**Acceptance timing (decided 2026-09-15): accepted in the same commit that lands decisions 1–4.** This record stays `proposed` until the behavior changes, so no accepted ADR claims a contract the code does not honor — the exact condition that let ADR-0016's recovery clause outlive its correctness. The implementation is deliberately not started yet: the open questions in [`../spec/stale-identity-reject-and-serve.md`](../spec/stale-identity-reject-and-serve.md) are resolved first.

## Context

ADR-0001 founded reject-and-serve: a rejection carries **fresh range content**, its rows **count as serves**, and "the model is never asked to supply verification data or to re-read". The reason is structural, not an optimization — anchors are content-derived, so an external write invalidates the model's entire address vocabulary for that region, and the tool re-mints anchors rather than spending a read. ADR-0016 then layered immutable `line_id`s and leases on those rows and banned content resolution for edits.

The model's side of that contract is the load-bearing part: **a model's decision is a function of the content it was served.** A rejection serve is therefore not a token refresh; it *replaces the inputs of a decision*. It is sound only while it refreshes the inputs of the *same* question.

MVCC's `stale` branch violated that. Its payload window is `src/hashline/lease-resolve.ts:173-183`:

```ts
const startLine = fromContent ?? fromLease.servedLineNumber;
const endLine   = toContent   ?? toLease.servedLineNumber;
```

For a bound whose identity is known to be gone, either arm is evidence-free. The content arm (`uniqueAnchorLine`) can name a *different* `line_id` that happens to carry the same text — ADR-0008's content search, surviving inside the payload, the one place ADR-0016's ban did not reach. The served arm names whatever line inherited the old number. Four variants follow:

| Variant | Window lands on | Verdict |
| :--- | :--- | :--- |
| retired in place, coordinate unchanged (`beta` → `BETA`) | the model's own coordinates | **sound** — same region, current content shown |
| retired in place, text re-added elsewhere | a **different `line_id`** | unsound (Probe P) |
| deleted, neighbour shifts in | the shifted-in neighbour | unsound — the miswrite |
| one bound stale, other live but shifted | spans a stale coordinate | unsound |

Probe P (2026-09-15, `sample.ts` = `alpha\nbeta\ngamma\n`): `beta` is replaced in place and its text re-added at line 4. The anchor leased for line 2 rejects with `line 4 … no longer resolves to the line identity it was served with.` / `Current range:` / `poj│beta` / `Retry with these anchors (no read needed).` — the header names a line the model never targeted, the window is the re-added line, and the retry is leased and writes line 4. That is ADR-0008's rebind with a lease on it.

The pre-MVCC baseline (`9c2538d`) served **no** rows for a deleted target and said "Re-read the full file"; MVCC routed the same case into the in-place-drift recovery. The defect is not the identity machinery — that machinery is what knows the identity is gone. It is the payload using a licence (ADR-0001's re-serve) in the one case where the licence's precondition fails.

Analysis: [`../spec/stale-identity-reject-and-serve.md`](../spec/stale-identity-reject-and-serve.md), [`../spec/mvcc-session-failure-handoff.md`](../spec/mvcc-session-failure-handoff.md).

## Decision

**Invariant — a rejection payload carries rows only for the region the submitted anchors identify. A serve refreshes the model's inputs for that region and never substitutes another region for those anchors. When the region cannot be identified, the grounding is void and only a read restores it.**

1. The `stale` branch serves the model's coordinates **iff** at least one bound is live *and* its rebased coordinate equals its served coordinate — evidence that no shift occurred. The window is then the served coordinates, the code stays `[E_STALE_RANGE]`, and the rows are leased as today.
2. Otherwise the rejection is emitted as **`[E_TARGET_LOST]`** and carries **no rows**. The message names the previously served position and states that the anchors describe a version of this file that no longer exists, so a re-read is required. The two codes are disjoint by payload shape — `[E_STALE_RANGE]` always renders rows, `[E_TARGET_LOST]` never does — so a model can choose its remedy from the code alone.
3. **Content-based placement is removed from the payload.** `uniqueAnchorLine` may not place a rejection window, and neither the window nor `firstOffendingLine` may be derived from a content match for a retired bound.
4. **Verification oracle:** an architecture test asserts that every rejection payload's rows are derivable from the submitted anchors' live mapping (served / rebased coordinates) — never from a content match. This is the guard that keeps variant 2 from re-entering through a path nobody has thought of.

Unchanged: the fast path, the dynamic rebase, `E_UNSERVED_RANGE`, in-place `E_STALE_RANGE` for torn or inserted spans (region identifiable, current content served), the content-placeable `E_STALE_ANCHOR` self-heal for an unleased anchor, and the `E_SERVED_ECHO` / `mode: "literal"` surface.

### Considered Options

- **Serve nothing for the whole `stale` branch** — rejected. It also removes the case where the region *is* identifiable and the served rows are the model's question refreshed; it contradicts ADR-0001's mechanism and inverts `test/integration/served-range-verification.test.ts:250` (`records [E_STALE_RANGE] current-range rows as serves for edits over that territory`). Safety was never the same thing as refusing to serve.
- **Keep serving context rows, unleased** (the first draft of the fix) — rejected. A context row grounds no decision, so it costs tokens to invite a retry that must fail closed; and it forces a `serve` that grants no lease, contradicting ADR-0016's Decision sentence for no decision-quality gain.
- **Content-preferred window placement (status quo)** — rejected by Probe P: the header named line 4 for a line-2 lease and the leased retry wrote line 4.
- **Keep `E_STALE_RANGE` and distinguish the remedies by prose** — rejected. The code is the only machine-readable signal a model has, and finding 2 is exactly the failure of one code carrying two opposite prescriptions ("Re-read the full file" vs "no read needed"). Prose is the layer that already failed.
- **Revoke all leases for the path on a target-lost rejection** — rejected for now. The residual (a model re-addressing the shifted-in neighbour with the neighbour's own, still-live anchor) is not tool-caused; revisit only on observation.

## Consequences

- **ADR-0016:** the Consequences clause *"A retired anchor is recoverable only by a re-read (or by `reject-and-serve`'s served rows)"* **deletes the parenthetical** — "recoverable only by a re-read" becomes literally true. Its Decision stands because no non-leasing serve exists. Its Status line gains `amended by ADR-0018 (recovery clause)` when this ADR is accepted.
- **`CONTEXT.md`:** `reject-and-serve` is scoped to region-matched serves; **target-lost rejection** is added (a rejection whose region cannot be identified, so its payload carries no rows); the previously planned **context serve** term is dropped — no such operation exists.
- **Spec:** the §5.3 retired-`line_id` row is replaced; §3.1.1 step 1 carries the region rule. The Core Architectural Mandate's *"0 retries"* still holds for every case where the region is identifiable; the one case where it does not is the case where no cheaper sound option exists.
- **Tests:** `served-range-verification.test.ts:250` must keep passing (in-place); new tests pin (i) a deleted target → `[E_TARGET_LOST]` with no rows + re-read, (ii) Probe P → `[E_TARGET_LOST]`, no line-4 window, (iii) the derivable-rows oracle of decision 4, and (iv) code disjointness (`[E_TARGET_LOST]` ⇒ 0 rows, `[E_STALE_RANGE]` ⇒ ≥ 1 row).
- **New public literal:** `[E_TARGET_LOST]` must be added to `README.md`'s error table, `CONTEXT.md`, and the prompts; downstream consumers keyed on error codes (e.g. `dsh-better-edit`) see one additional code and no changed meaning for `[E_STALE_RANGE]`. The full producer audit lives in the patch spec's Appendix E.
- **Cost:** a target-lost rejection costs one read. The pre-MVCC baseline shows this is a *restoration* of the deleted-target behavior, not a new expense.
- **Not in scope:** the `E_SERVED_ECHO` / `mode: "literal"` surface and the fail-open verbatim write of never-served anchor-shaped `replace_with` (ADR-0009 revision 2026-09-15), and the rejection-wording unification (duplicate counts, two prescriptions for one code).
