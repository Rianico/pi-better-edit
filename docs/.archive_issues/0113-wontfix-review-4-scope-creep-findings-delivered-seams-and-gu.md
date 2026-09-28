# wontfix: review-4 scope-creep findings — delivered seams and guards stay

> **Archived from pre-migration issue #113.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-14T14:43:01Z · state CLOSED · labels: wontfix

## Body

Part of #78. **Record of a declined review finding** — filed so review 5 does not have to re-derive it. No code change is requested; this issue is closed as `wontfix` with rationale.

Review 4 flagged three delivered artifacts as unrequested scope creep. Two of them were requested by **earlier rounds of this same review process**, and one is pre-existing. Code stays; the spec is amended by the sibling docs ticket so the layout is no longer off-roadmap.

## (a1) Vacuum ownership in `src/snapshot-store/vacuum.ts`, not `src/served-session/session.ts`

The relocation was **requested by review 3** (ticket #97), whose instruction was quoted verbatim into the remediation issue: *"Split the module into a directory module, per the review: `src/snapshot-store/{index.ts,vacuum.ts,migrate.ts}`."* The operator then decided in review 3 Q2 to keep the code where it is and fix the wording instead. Reverting it now would be ping-pong against the round that asked for it.

Resolution: the Stage 3 seam line in the spec is amended to name `src/snapshot-store/vacuum.ts` (sibling docs ticket). ADR-0017 already records the rationale.

## (b1) Arch verification suites under `test/arch/`

Factual correction: **4 of the 7 files are new, not 5.** `test/arch/c3-served-session-deepening.test.ts` was introduced by `6cbf5da` (#64) and only *modified* by the snapshot-store split; `payload-contract-seam.test.ts` (#64) and `c4-drift-intervals.test.ts` (#76) also predate this work.

The four new suites are guards for seams that review 3 itself asked to create:

| Suite | Introduced by |
| --- | --- |
| `snapshot-store-module-boundary.test.ts` | `9b932b8` (#102, the split review 3 requested) |
| `serve-recording-seam.test.ts`, `undo-schema-seam.test.ts` | `727638a` (#103, review 3 S6/S9 dedup + forwarder removal) |
| `terminology-synonyms.test.ts` | `5f7621e` (#101, review 3 S1-S3 rename) |

The remediation tickets never asked for new suites — the dev agents added them to pin the new seams. Operator decided in review 4 Q2: **keep**. Deleting passing guards would weaken verification, which is the opposite of this project's direction. They are recorded as stage deliverables in the spec (sibling docs ticket).

Note: `terminology-synonyms.test.ts` was too weak (it exempted one file and asserted against two identifiers that never existed); that is fixed as a real defect in the echo-vocabulary ticket, not as scope creep.

## (b2) Module decompositions

- `src/snapshot-store.ts` → package: requested by review 3 (#102), see (a1).
- `src/hashline/lease-resolve.ts`: created by `95fa5f5 feat(edit): resolve anchors via served_leases` (closes #85) in the original MVCC batch — a new module for new functionality, not a refactor of existing code. Review 3 then treated it as the established seam, e.g. its finding *"Two spec deviations in `src/hashline/lease-resolve.ts`"* (ticket #106), and this review's own Standards findings cite the same path as the seam to fix.

Resolution: the seam lists in the spec are amended to name the delivered layout (sibling docs ticket).

**Decision:** declined — no revert, no suite deletion. Rationale: both artifacts were produced by explicit instructions from earlier review rounds, both are guarded by passing tests, and the remaining drift was a documentation gap, which the spec amendment closes.


## Comments

### @Rianico — 2026-09-14T14:43:04Z

Closed as wontfix per the operator decision in review 4 (Q2 = keep). Evidence and rationale are in the body: the vacuum relocation and the snapshot-store split were requested by review 3 (#97/#102), and the arch suites guard those seams — 4 of 7 files in test/arch/ are new, not 5. The remaining drift was documentation and is closed by the sibling spec ticket.
