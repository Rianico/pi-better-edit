# fix(edit): target-lost rejections must not serve or lease the retired coordinate

> **Archived from pre-migration issue #136.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-18T05:14:08Z · state CLOSED · labels: bug, ready-for-agent

## Body

## Defect

A rejection for a **retired or absent** leased line identity (`resolveLeasedEdit`'s `stale` branch, `src/hashline/lease-resolve.ts:173-183`) builds its window from the lease's *historical* coordinate or from a *content match* (`fromContent ?? fromLease.servedLineNumber`), renders it as `Current range:` with `Retry with these anchors (no read needed).`, and leases those rows. A model that follows the hint overwrites whichever line now occupies that coordinate, and the tool reports success.

Four variants, all reproduced:

| Variant | Window lands on | Status |
| :--- | :--- | :--- |
| retired in place, other bound live and unshifted | the model's own coordinates | sound — unchanged |
| retired in place, both bounds the same dead anchor (session `4FT`) | the model's coordinates, with no evidence | fail-open |
| retired, text re-added elsewhere | a **different `line_id`** (Probe `P`) | fail-open |
| deleted, neighbour shifts in | the shifted-in neighbour (Probe `E`/`A`) | fail-open, miswrite |

Probe `A` on `ba7c8d2`: read `alpha/beta/gamma/delta`, external delete of `gamma`, edit `gamma` →

```
[E_STALE_RANGE] line 3 in sample.ts no longer resolves to the line identity it was served with.
Current range:
YAz│delta
Retry with these anchors (no read needed).
```

retry accepted → `alpha\nbeta\nGAMMA_NEW\n`. The pre-MVCC baseline (`9c2538d`) served **no** rows for this case and said "Re-read the full file", so the fail-open window is new.

## Fix spec

- [`docs/spec/stale-identity-reject-and-serve.md`](docs/spec/stale-identity-reject-and-serve.md) — D1–D6: target-lost rejection carries **no rows**; no `recordRejectionServe` upsert; conditional retry hint; unified wording; content placement banned from the payload (`uniqueAnchorLine` may not place a window *or* the headline coordinate); new code `[E_TARGET_LOST]`, disjoint from `[E_STALE_RANGE]` by payload shape. Appendix E audits all 12 `E_STALE_RANGE` producers against the region rule.
- [`docs/adr/0018-region-scoped-rejection-serves.md`](docs/adr/0018-region-scoped-rejection-serves.md) — `proposed`; amends ADR-0016's *Consequences* recovery clause and leaves its Decision intact.
- [`docs/spec/mvcc-session-failure-handoff.md`](docs/spec/mvcc-session-failure-handoff.md) — triage of the 7 session failures and 12 findings, with pre-MVCC provenance.

## Acceptance

- The 10 tests in the spec's Verification section fail on `bd3a8f2`/`ba7c8d2` and pass after.
- `test/integration/served-range-verification.test.ts:250` (in-place drift) keeps passing: the identifiable case keeps its zero-read recovery.
- Row/leasing contracts: `[E_TARGET_LOST]` renders no rows and leases nothing; `[E_STALE_RANGE]` always renders rows.
- `pnpm run lint && rtk pnpm run format && rtk pnpm run typecheck && rtk pnpm run test:coverage` green.
- With the fix lands ADR-0018's acceptance (status `accepted`, ADR-0016 status line gains `amended by ADR-0018`), the `README.md` error table gains `[E_TARGET_LOST]`, and `CONTEXT.md` gains **target-lost rejection**.

## Scope note

Out of scope here: the `E_SERVED_ECHO` / `mode: "literal"` surface and its fail-open verbatim write for never-served anchor-shaped `replace_with` (ADR-0009 revision 2026-09-15), and the rejection-wording cleanups (duplicate anchor counts, duplicated batch served block) — see the handoff's action items 2 and 4.


## Comments

### @Rianico — 2026-09-18T09:21:43Z

## Review decisions recorded (2026-09-15)

The handoff is committed (`d528c0f`): triage, revision-25 patch spec, the §9 MVCC appendix, ADR-0018 and the error-code consistency audit. Implementation is deliberately **not** started.

- **ADR-0018 timing = option B**: accepted in the same commit that lands decisions 1–4. The ADR stays `proposed` and now says so (`docs/adr/0018-region-scoped-rejection-serves.md`, Status).
- **Scope split from the review** — this ticket keeps decisions D1–D6 plus the ADR/CONTEXT/prompt surface; three follow-ups were filed so they do not enlarge this change:
  - #144 — make the `[E_UNSERVED_RANGE]` contract true (phantom `details.unservedKind`, the glossary code in `CONTEXT.md:70`, the must-read variant)
  - #145 — bind an anchor to the file that served it (prompt contract)
  - #146 — soft-hint a never-served anchor-shaped `replace_with` (this is the A1 decision: write verbatim, warn, never refuse outside `[E_SERVED_ECHO]`)
  - #147 — unify rejection diagnostics (findings 6, 7, 8, F3a, F3b)
- **Probe J — closed, R1 is region-provable** (the last unprobed producer). `sample.ts` = `a\nb\nc\nd\ne\n`, read, then an external insert **strictly inside** the served range (`a\nb\nc\nNEW\nd\ne\n`), then an edit over the served anchors:

  ```
  [MODEL] [E_STALE_RANGE] served span (5 lines) no longer matches the rebased range (6 lines) in sample.ts.
  Current range:
  Wot│a  rKa│b  BkM│c  GQG│NEW  Rzv│d  EaX│e
  Retry with these anchors (no read needed).
  ```

  Code `[E_STALE_RANGE]` (R1, `src/hashline/served-verification.ts:251-258`), window = the submitted anchors rebased through `line_lineage` (no content match), rows served and leased. The D1 discriminator keeps it: `a` is live and unshifted, so the region is provable. This confirms the audit's Appendix E by observation; no seam is missing from D5's ban.
- **Audit**: `docs/spec/error-code-consistency-audit.md` (10-agent workflow, 18 codes, adversarial re-check, reviewer verification table). Confirmed: F2b HIGH, F1 MED (scope corrected), F2a MED, F3a/F3b LOW; four claims refuted (`E_UNDO_STALE`, `E_UNKNOWN`, `E_BATCH_ABORT`, the `[USER]` notices).

Acceptance for this ticket is unchanged: the 10 verification tests, `served-range-verification.test.ts:250` still green, ADR-0018 → `accepted` with `adr link 18 Amends 16 "Amended by"`, ADR-0016's *Consequences* parenthetical deleted, `CONTEXT.md` gains **target-lost rejection**, README gains `[E_TARGET_LOST]`, prompts updated.


### @Rianico — 2026-09-18T10:32:06Z

## Wording conflict with the no-prescription rule (2026-09-15)

D3 currently specifies the target-lost message as:

> `The line you targeted no longer exists — read the file and re-target.`

That prescribes a read. Under the maintainer rule recorded on #144 ("messages must not say `full read` / `re-read`; the tool states the state, the model decides"), D3 must be reworded to state only:

> `[E_TARGET_LOST] the line you targeted no longer exists — these anchors describe a version of this file that no longer exists. Nothing was written.`

Same edit applies to the copies of D3 in `docs/spec/content-addressed-line-identity-mvcc.md:784` and Appendix E's decision table in `docs/spec/stale-identity-reject-and-serve.md`. The code `[E_TARGET_LOST]` plus "no rows" already carry the remedy as data.


### @Rianico — 2026-09-18T10:41:36Z

## D3 and the prescription rule (2026-09-15)

The wording half of this ticket changes under the new rule *a warning states state, never action* (see the #144 comment, §4):

- **D3** currently prescribes `The line you targeted no longer exists — read the file and re-target.` Replace it with a state statement. The code plus the absence of rows already carry the remedy as data — the model draws the conclusion, so no prose remedy belongs in the payload.
- Same fix for the §9 appendix row in `docs/spec/content-addressed-line-identity-mvcc.md:784`, and for the overstatement in `src/hashline/served-verification.ts:692-693` ("retrying without re-reading cannot clear a stale duplicate outside the served window" both prescribes and overstates).
- Related sweep, owner #144: `docs/adr/0014-user-model-audience.md:25` still specifies a `[USER]` line reading "retry with these anchors, no read needed".

This ticket's acceptance already requires `[E_TARGET_LOST]` to carry no rows; with D3 neutralized, nothing in the payload commands an action.


### @Rianico — 2026-09-20T14:32:45Z

Verified on `main` @ `3b22008` (PR #148, squash of the `dev/mvcc-followups` line).

A row-less rejection records no serve and no lease: `src/mutation-engine/pipeline.ts:496` returns early when `args.error.servedRows.length === 0`, and `src/served-session/session.ts:942` does the same inside the transaction. A retired coordinate now reports `[E_TARGET_LOST]` with zero rows and no `Current range` heading, so an accidental retry cannot write. Recorded as ADR-0018 decisions 1–2 and amended by ADR-0020; pinned by `test/arch/rejection-payload-region.test.ts` (rows-carrying target-lost payloads are planted as negative controls and asserted to fail the check).

Closing as resolved.
