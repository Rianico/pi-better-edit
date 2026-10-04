# docs: make the E_UNSERVED_RANGE contract true (phantom unservedKind, glossary code, must-read variant)

> **Archived from pre-migration issue #144.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-18T09:21:04Z · state CLOSED · labels: bug, ready-for-agent

## Body

## Problem

Three documented claims about `[E_UNSERVED_RANGE]` do not match the code on `ba7c8d2`. Source: `docs/spec/error-code-consistency-audit.md` (F1, F2a, F2b, LOW rows), re-verified by the commissioning session.

| Artifact | It claims | The code does | Severity |
| :--- | :--- | :--- | :--- |
| `README.md:197` | `details.unservedKind` is `interior` or `boundary` | no producer emits it (`rg -n unservedKind src/` → 0 hits); origin is the unimplemented rename plan in `docs/adr/0014-user-model-audience.md:21,33` | HIGH |
| `CONTEXT.md:70` (**orphaned serve**) | "an **anchor** with no lease now rejects fail-closed (`[E_UNSERVED_RANGE]`)" | the lease path throws `[E_STALE_ANCHOR]`: `src/hashline/lease-resolve.ts:150-155` (`if (!fromLease \|\| !toLease) throwStaleAnchor(…)`); its module comment `:22-24`, `:133-134` states the same | MED |
| `README.md:197`, `CONTEXT.md:48-49` | one remedy: retry with the served rows, no read | `src/hashline/served-verification.ts:690-693` requires a full read ("retrying without re-reading cannot clear a stale duplicate outside the served window"); `:619` appends `retryHint()` ("no read needed") | MED |
| `README.md:186`, `:191`, `:194` | coarse Meaning rows | `src/validation.ts:23,28,32` carry per-variant remedies; `src/read.ts:87,91,95` vs `src/validation.ts:43,48,53` differ in audience and remedy | LOW |

## Decision taken (2026-09-15)

- `details.unservedKind`: **do not leave an unconditional promise.** Either delete it, or state it conditionally — only a provable, fail-closed rejection may carry a kind — and list the provable cases in the docs.
- Fit check (done): the distinction is derivable at every producer. Boundary = the `throwUnverified` path (`src/hashline/served-verification.ts:678`, `:683`, `anchor_from "…" has no served position`). Interior = the loop miss (`:265`, `:276`, `:619`). The field is therefore implementable — but it is **not emitted today**, so the README claim is false as written.
- Choose one in review: (a) keep the doc conditional ("reserved; not emitted yet") — recommended for this ticket; or (b) emit the field where provable as a separate small change.
- Glossary: scope `CONTEXT.md:70` — "an **anchor** with no lease rejects `[E_STALE_ANCHOR]`; a line inside the span that was never served rejects `[E_UNSERVED_RANGE]`".
- Prose: document both `[E_UNSERVED_RANGE]` variants and name when a full read is required.

## Acceptance

- `README.md` and `CONTEXT.md` state only behavior a producer implements; no code or `details` field is promised without a producer.
- The provable `unservedKind` cases are listed in the docs next to the row.
- Docs-only unless option (b) is chosen; `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-18T10:23:01Z

## Maintainer decision (2026-09-15) — machine-readable, option (b)

The ticket text changes: **do not delete the field, and do not settle for a vague "conditional".** Emit it, and list in the docs exactly where it is emitted.

Rules for this ticket:

1. **Reservation requires proof.** Only a provable, fail-closed case may serve rows and grant leases, so the model can retry with no read. Everything else rejects with no rows and requires a read. This is ADR-0018's rule (decision 1 and the D1 discriminator) applied to `[E_UNSERVED_RANGE]` — keep the two records consistent.
2. **Amend ADR-0014.** The unbounded promise originates at `docs/adr/0014-user-model-audience.md:21` (`E_RANGE_UNSERVED`+`E_RANGE_UNVERIFIED`→`E_UNSERVED_RANGE`, "with `details.unservedKind=\"boundary\"|\"interior\"`"); the rename plan is implemented only in part. Give the field's contract a durable home — amend ADR-0014, or supersede that clause in a new ADR — rather than leaving it in a README cell.
3. **A machine-readable remedy is the deliverable.** The tool exposes a precise error code plus, where provable, `details.unservedKind`; the model chooses its remedy from the code and the field alone, never from prose.
4. **Ambiguity is the defect, not list length.** A long code list is fine. A code or warning that can carry two opposite remedies, or that misleads, is what must be fixed — F2a is the model case (`[E_UNSERVED_RANGE]` carries both "retry with these anchors, no read needed" at `src/hashline/served-verification.ts:619` and "a full read will re-sync the served mirror" at `:690-693`). Acceptance: every code maps to exactly one remedy, and no surface offers contradictory guidance.

### Fit check (unchanged)

The interior/boundary distinction is derivable at every producer — boundary: `src/hashline/served-verification.ts:678`, `:683`; interior: `:265`, `:276`, `:619`. The field is implementable; only its contract and the docs are missing.

### One open question

The unresolvable-span producer (`src/hashline/served-verification.ts:690-693`) is neither interior nor boundary, and its own message requires a full read. Under rule 1 it must not reserve rows. Choose: (a) `unservedKind` is absent and the code alone carries the read remedy; or (b) a third value (e.g. `"span"`) names it. Recommendation: **(b)** — the remedy stays machine-readable, which is the point of this decision.


### @Rianico — 2026-09-18T10:26:22Z

## Verified fact that sharpens this ticket: the read-required case still reserves rows

`src/hashline/served-verification.ts:655-698` (`throwUnverified`) emits **one** `[E_UNSERVED_RANGE]` for three problem shapes:

1. `anchor_from`/`anchor_to` "has no served position" (`:678`, `:683`);
2. an anchor "was served at N positions" (`:680`, `:685`) — ambiguous;
3. "No served span matched the current range (N lines)" (`:691`).

All three attach `servedRows`/`servedBlock`, and `src/mutation-engine/pipeline.ts:331-336` calls `recordRejectionServe` for **every** `ServedRejectionError` with no code filter. So cases 1–3 are all served **and leased**, while the message for 2–3 says *"a full read will re-sync the served mirror … retrying without re-reading cannot clear a stale duplicate outside the served window"*.

Consequences for this ticket:

- The remedy is not machine-readable: the same code and the same reserve carry "retry, no read needed" (interior miss) and "read first" (ambiguous / unreconcilable span).
- The `unservedKind` plan (`docs/adr/0014-user-model-audience.md:21`) only ever defined `"boundary" | "interior"`, so it cannot name case 2–3 either.
- This is **not** a miswrite: the window is the model's own resolved range (provable), so a retry writes the intended lines. It is a contract inconsistency — the advice says "verify first" while the mechanism says "retry freely".

## Recommendation, restated

Encode the **remedy**, not the kind: `details.remedy = "retry" | "read"` (or `details.retryable: boolean`), derived from the one rule — a provable, fail-closed range may reserve rows and be retried without a read; anything else requires a read.

- It makes this ticket's rule literal and testable, instead of a mapping the model must learn from prose (the layer that already failed, F2a).
- It generalises to #136: `[E_TARGET_LOST]` emits no rows and therefore `remedy: "read"`; `[E_STALE_RANGE]` always emits rows and therefore `remedy: "retry"`. One machine rule across both codes.
- If the `unservedKind` field survives, the third value must be documented — and the name is a misnomer for cases 2–3, whose lines *were* served.

Question: adopt `details.remedy` (recommended), or keep `unservedKind` with a third value?


### @Rianico — 2026-09-18T10:32:03Z

## Maintainer rule (2026-09-15): messages must not prescribe a read

No model-facing message may say "full read" / "re-read the file" / "read the file and …". The tool states the **state**; the model decides the action.

Verified hit list on `ba7c8d2` (all currently command a read):

| Kind | Location | Current text |
| :--- | :--- | :--- |
| rejection message | `src/hashline/resolve.ts:202`, `:231` | "Re-read the full file and copy the fresh 4-char anchors…" |
| rejection message | `src/hashline/served-verification.ts:692-693` | "A full read will re-sync the served mirror — … retrying without re-reading cannot clear a stale duplicate outside the served window." |
| rejection message | `src/mutation-engine/pipeline.ts:360`, `:506` | "Re-read the full file…" / "Call read() to get fresh anchors." |
| refusal message | `src/hashline/served-guard.ts:263`, `:279` | "Re-read the file for fresh anchors if needed." |
| prompt text | `src/payload-contract.ts:92`, `:97` (`EDIT_GUIDELINES`) | "…re-read the file and copy fresh anchors." / "…re-read to sync." |
| drift notice | `src/drift.ts:284`, `:306` | "re-read to refresh" / "re-read to see" |
| glossary | `CONTEXT.md:23` (`anchor staleness`) | "The model must re-`read` for fresh anchors." |

Rewording rule: replace the command with the fact that makes the action obvious — e.g. "the served rows no longer describe the current file" instead of "re-read the full file". A factual statement about what the tool did is still allowed ("the diff serves fresh rows", "these rows are current content") — that is information, not an instruction.

## Consequence for the code question — split by remedy, not by cause

`CONTEXT.md` defines a **model-facing signal** as a correctness signal the tool must put in `content`, and a **user-facing signal** as `details`/`warnings` (human). So `details.remedy` is **not** the model's remedy channel — my earlier suggestion (comment above) was wrong on that ground. The code word in `content` is the model's only machine-readable remedy channel.

Therefore one code carrying two remedies is the contract defect (F2a), and ADR-0014's merge premise is falsified: it merged `E_RANGE_UNSERVED` + `E_RANGE_UNVERIFIED` because "model retry identical" (`docs/adr/0014-user-model-audience.md:33`) — the audit shows the retry is not identical.

Proposal (remedy axis, one code per decision shape):

| Code | State | Reserve | Model's decision |
| :--- | :--- | :--- | :--- |
| `[E_UNSERVED_RANGE]` | a line inside the model's own range was never served (`details.unservedKind = interior\|boundary`) | rows + lease | retry is valid |
| `[E_RANGE_UNVERIFIED]` (resurrect the name ADR-0014 retired) | no served span matched the range, or an anchor was served at 2+ positions | rows, see the open choice below | the range is current content, but served state is not reconciled |
| `[E_TARGET_LOST]` (#136) | the leased identity is gone | none | fresh ground is required |

Keep `details` for the *where*/*why* (`unservedKind`, `cause = "no-span" | "ambiguous-anchor"`) — machine data for downstream, never the remedy.

### Open choice

Does `[E_RANGE_UNVERIFIED]` keep its rows? (a) **Yes, rows without a verification claim** — the rows are the model's own anchors at current content, so a retry is bounded by the model's own range and cannot miswrite; only the prose changes, plus the new code. (b) **No rows, fail-closed** — maximal reading of "only a provable case may reserve". Recommendation: **(a)** — fail-closed governs writes, and there is no wrong-line write available here; withholding the rows costs a read for no safety gain.


### @Rianico — 2026-09-18T10:38:38Z

## Probe K (2026-09-15): a reserved `[E_UNSERVED_RANGE]` retry is accepted — the rows are meaningful

Setup: `sample.ts` = `a\nb\nc\nd\ne\nf\n`, full read, then an external move (`c` leaves line 3, lands on line 5), then a partial read of the new position, then an edit anchored on `b..c`.

```
[E_UNSERVED_RANGE] line 3 in sample.ts was never served.
Current range:
rKa│b  Rzv│d  EaX│e  BkM│c
Retry with these anchors (no read needed).
```

Retry with exactly those reserved rows (`rKa..BkM` → `Z`):

```
Successfully edited 1 file(s) — 1 of 1 edit(s) applied. Added 1 line(s), removed 4 line(s).
```

So for the interior-never-served arm the reserve is not a trap: the retry verifies and writes the intended range. "Always fails" is false there.

## Proposed invariant for this ticket (from the review question)

**Every rejection that reserves rows must be usable: a same-window retry with its own served rows is accepted and writes that window.** If a case cannot satisfy that, it must not reserve — it fails closed instead.

- This is exactly the reviewer's question: "if the model retries the reserved anchors from rows and always fails, then it is meaningless".
- It is testable per code: rejection → parse the served rows → resubmit a single edit over the first..last served row → expect `applied`, and the file equals the expected content. Add it to the acceptance criteria alongside the remedies table.
- Still unobserved for the `throwUnverified` arm (the `[E_RANGE_UNVERIFIED]` candidate): I could not construct `enumerateExactCandidates !== 1` with an external move + partial read (that path produced the interior arm instead). Code reading says the rows there come from `buildServeBlock(startLine, endLine, fileHashes, fileLines)` — the current file at the caller's own coordinates — so a same-window retry should reconcile; but that is reading, not observation. Pin it with a probe before choosing option (a).

## Consequence for the open choice

- If the invariant holds for the unverified arm too → **(a) keep the rows** is safe; the old "retrying without re-reading cannot clear a stale duplicate outside the served window" sentence is the part that is wrong (it prescribes and it overstates the risk).
- If it does not hold → **(b) no rows**, because a reserve the model cannot use invites a loop; and the loop hazard then also needs naming (compare `E_NOOP_LOOP`, which only catches 3 identical no-change resubmissions).


### @Rianico — 2026-09-18T10:41:34Z

## Adopted: option (a) — `[E_RANGE_UNVERIFIED]` reserves rows (2026-09-15)

### 1. Split the code by remedy, not by cause

ADR-0014:33 merged `E_RANGE_UNSERVED` + `E_RANGE_UNVERIFIED` on the premise "model retry identical" (`docs/adr/0014-user-model-audience.md:33`); the audit falsifies it. Three codes, each with exactly one remedy:

| Code | State | Rows | Remedy |
| :--- | :--- | :--- | :--- |
| `[E_UNSERVED_RANGE]` | a line in the range (interior or boundary) was never served | rows + lease | retry over the model's own range |
| `[E_RANGE_UNVERIFIED]` (**resurrect the retired name**) | no served span matched, or an anchor sits at 2+ positions | rows + lease — **option (a)** | retry over the model's own range; the served state stays unreconciled |
| `[E_TARGET_LOST]` | the leased identity is gone (ADR-0018) | none | fresh grounding required |

This supersedes the open question in my earlier comment: the third case becomes its own **code**, not a third `unservedKind` value. Cost: one new public literal (README, `CONTEXT.md`, prompts, downstream `dsh-better-edit`).

### 2. The reservation rule becomes mechanical — this is the acceptance criterion

> Every rejection that reserves rows must be usable: a same-window retry with its own served rows is accepted and writes that window. A case that cannot satisfy this must not reserve — it fails closed.

One test per reserving code: reject → parse the served rows → resubmit one edit over first..last → expect `applied` and the expected bytes. Pin it in this ticket.

### 3. `details` carries no remedy

The earlier `remedy: "retry" | "read"` proposal is **retracted**: `CONTEXT.md` defines model-facing signals as correctness signals in `content`, while `details`/`warnings` are the user-facing channel — so `details` cannot carry a remedy to the model. The **code word is the model's only machine-readable remedy channel**. `details` keeps `unservedKind` (`interior` | `boundary`) for `[E_UNSERVED_RANGE]` and gains `cause = "no-span" | "ambiguous-anchor"` for `[E_RANGE_UNVERIFIED]`.

### 4. New rule for the ADR-0014 amendment: a warning states state, never action

Never "read the file", never "call read()" — the model chooses the action. Statements about what the tool did ("these rows are current content") stay. Hit list, spot-verified against the tree: `src/hashline/resolve.ts:202`, `:231`; `src/hashline/served-verification.ts:692-693`; `src/mutation-engine/pipeline.ts:360`, `:506`; `src/hashline/served-guard.ts:263`, `:279`; `src/payload-contract.ts:92`, `:97`; `CONTEXT.md:23` ("must re-`read`"); `docs/adr/0014-user-model-audience.md:25`; `docs/adr/0008-orphaned-serve-healing.md:11`.

**Open scope question:** does the rule cover the dimmed user-facing drift notices (`src/drift.ts:284`, `:306`) and the prompt guidelines, or only model-facing rejection messages?

### 5. Evidence status

- Lease-without-filter premise **confirmed**: `src/mutation-engine/pipeline.ts:331-336` calls `recordRejectionServe` for any `AnchorMismatchError` or `ServedRejectionError`, with no code filter — every reserving arm leases.
- Interior arm **observed** (Probe K): `a\nb\nc\nd\ne\nf\n`, full read, external move of `c` from line 3 to 5, partial read, edit on `b..c` → `[E_UNSERVED_RANGE] line 3 in sample.ts was never served.` with rows `b d e c`; the same-window retry (`rKa..BkM → Z`) applied: "Added 1 line(s), removed 4 line(s)."
- The `throwUnverified` arm is **not probed**. Reading suggests its rows come from `buildServeBlock(startLine, endLine, …)` at the caller's coordinates and are leased, so a same-window retry should reconcile — but that is reading, not observation. It must pass the criterion in §2 before the invariant is asserted globally; if it cannot, it fails closed and does not reserve.


### @Rianico — 2026-09-18T10:55:10Z

## Scope decision + the `throwUnverified` probe (2026-09-15)

### 1. Scope of the new rule (recorded)

*A warning states state, never action* applies to **model-facing rejection/refusal content only** — the `content` of `[E_*]` refusals and their payloads. Out of scope: the dimmed user-facing drift notices (`src/drift.ts:284`, `:306`), the prompt guidelines, and the `[USER]` audience line specified at `docs/adr/0014-user-model-audience.md:25`. Changing any of those later is a separate audience/aesthetic question, not this rule.

### 2. Probe result (dynamic workflow: 3 read-only recon agents → 3 sequential probes → 1 verifier)

Reached the arm in **all three** cases, but **only at the library level** (`applyEdit(…)` with no `identity`) — never through a tool call. Verbatim headlines:

- no-position: `[MODEL] [E_UNSERVED_RANGE] cannot verify range against served state in t.txt: anchor_from "mV0" has no served position.`
- ambiguous-anchor: `[MODEL] [E_UNSERVED_RANGE] cannot verify range against served state in t.txt: anchor_from "Wot" was served at 2 positions; anchor_to "BkM" has no served position.`
- library-level: `… anchor_from "Wot" has no served position; anchor_to "BkM" has no served position.`

Rows are carried (`[{"position":1,"hash":"mV0"},…]`), and **they are not leased**: the errors are `ServedRejectionError`s thrown from `src/hashline/served-verification.ts:655-697` via `src/hashline/apply.ts:218`, which bypasses the tool-seam catch at `src/mutation-engine/pipeline.ts:331-336`. Zero store writes.

Criterion in that setup: **not satisfiable, and vacuous** — a same-window retry with the rejection's own rows against the unchanged mirror re-throws the identical rejection (nothing was served, so the mirror is unchanged). With `served := own rows` the retry applies (`no-position → "a\nZ\n"`, the others → `"Z\n"`).

### 3. What this does not prove

It does **not** prove the arm is structurally library-only. On the fast path `resolveLeasedEdit` returns `{status: "fast"}` (`src/hashline/lease-resolve.ts:200`), so `leaseRebased` is false and `applyEdit` runs `verifyServedRange` (`src/hashline/apply.ts:320-323`) — this decision table sits on the tool path whenever the lease seam resolves *fast*. Firing there needs an **inconsistent mirror**: a boundary anchor with 0 or ≥2 mirror positions while the lease lookup still resolves fast. No recipe for that was constructed in this pass.

Therefore: **option (a) remains the target contract, but it is unproven for this arm.** Do not implement `[E_RANGE_UNVERIFIED]` as "reserves rows" until a tool-seam probe passes.

### 4. Next probe — pin this test

Through the tool seam: a partial read plus an external move, so the served mirror holds one hash at two positions (serve the new position via a narrow window while the old slot survives), then submit an edit whose anchor has a live lease. Assert:

1. the rejection is `cannot verify range against served state` with `was served at 2 positions`;
2. its rows are recorded as serves/leases (`src/mutation-engine/pipeline.ts:331-336`);
3. a same-window retry with those rows applies and writes that window.

If (3) fails, this arm must fail closed and reserve nothing.

Tree after the run: clean; every scratch file deleted by the workflow.


### @Rianico — 2026-09-20T14:32:49Z

Verified on `main` @ `3b22008` (PR #148).

All three claims are gone rather than reworded: `rg -n unservedKind src/ README.md CONTEXT.md` returns zero hits (the phantom `details.unservedKind` is deleted, not implemented); `[E_UNSERVED_RANGE]` is retired by ADR-0020 and appears only as a retirement note where the glossary and README name what replaced it; and the no-lease anchor path now reports `[E_STALE_ANCHOR]` when a row exists for this file, or `[E_UNKNOWN_ANCHOR]` / `[E_FOREIGN_ANCHOR]` when none does — the three-way split is recorded in ADR-0021 decision 3 with the precedence pinned by tests.

Closing as resolved.
