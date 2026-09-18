# Spec: Stale-identity rejection never serves the retired coordinate (MVCC Revision 25 patch)

Status: proposed — patches [`content-addressed-line-identity-mvcc.md`](content-addressed-line-identity-mvcc.md) §3.1.1, §5.3 and the ADR-0016 consequence it inherits.
Evidence: the 2026-09-15 triage session against the installed revision `bd3a8f2`; the defect was re-confirmed on `ba7c8d2` (current `main`) — see Revision check (full log path in the companion handoff).
Companion: [`mvcc-session-failure-handoff.md`](mvcc-session-failure-handoff.md) (triage of all 7 session failures + 11 findings).

## Problem Statement

When a lease is **retired or its `line_id` has no coordinate in `line_lineage(C)`**, the `stale` decision correctly fails closed with `[E_STALE_RANGE]` — but the *reject-and-serve* payload that travels with it is built from the lease's **historical** position, not from anything that identifies the model's target:

```ts
// src/hashline/lease-resolve.ts:173-183
const staleLine = fromDecision.kind === "stale" ? fromDecision.line : undefined;
const startLine = fromContent ?? fromLease.servedLineNumber;   // <-- stale served coordinate
const endLine   = toContent   ?? toLease.servedLineNumber;     // <-- stale served coordinate
throw makeServedRejection({ code: "E_STALE_RANGE", startLine, endLine, snapshot, firstOffendingLine: staleLine });
```

`assembleRejectAndServe` renders that window under the heading **`Current range:`** and appends an unconditional **`Retry with these anchors (no read needed).`** (`src/hashline/served-verification.ts:107,128-171`), and `recordRejectionServe` then **leases exactly those rows** (`src/mutation-engine/pipeline.ts:471-485` → `src/served-session/session.ts:679,953`).

For a retired identity there is no coordinate that identifies the model's target, so the served window is *whatever line now occupies the old number*. A model that follows the documented recovery contract replaces that line — a silent wrong-line write, reported as success. This is the class ADR-0016 exists to eliminate, re-opened by the recovery payload rather than by resolution.

> [!warning] Contradicts ADR-0016 (`Consequences`)
> *"A retired anchor is recoverable only by a re-read (or by `reject-and-serve`'s served rows), which is the intended context cost of never miswriting."* The second clause is the defect: for a retired anchor the served rows are **not** the model's range, so recovering through them *is* the miswrite. This spec narrows that clause to live/rebased identities; the ADR needs an amendment (see Appendix D).

### Reproduction (verified)

```text
read  alpha\nbeta\ngamma\ndelta\n            # leases for alpha..delta
# external deletion of `gamma` on disk  ->  alpha\nbeta\ndelta\n
edit  anchor_from=anchor_to=<gamma anchor of line 3>, replace_with="GAMMA_NEW"
  -> [MODEL] [E_STALE_RANGE] line 3 ... no longer resolves to the line identity it was served with.
     Current range:
     YAz│delta
     Retry with these anchors (no read needed).
edit  anchor_from=anchor_to=YAz, replace_with="GAMMA_NEW"    # the model obeys the hint
  -> "Successfully edited 1 file(s) — 1 of 1 edit(s) applied."
file on disk: "alpha\nbeta\nGAMMA_NEW\n"       # `delta` destroyed, no rejection, no warning
```

The live-session instance of the same branch is recorded in the session log: an edit targeting `4FT` (`_ = parser.add_argument("target_branch", …)`, retired by the model's own earlier edit) was rejected with `Current range: rtW│    "commitlint.config.cjs",` — the current line 34, unrelated to the target (`merge_copy.py`, Appendix B).

## Solution

Six normative deltas, two scope rules: **a rejection window may only be emitted for the region the submitted anchors identify** (a live lease identity — never a content match, never a dead lease's historical coordinate), and **when that region cannot be identified the rejection carries no rows at all**. A window for a retired identity is neither a target nor context: it is content that cannot ground the model's decision. D6 gives that case its own code so the remedy is machine-readable. Recorded as [ADR-0018](../../docs/adr/0018-region-scoped-rejection-serves.md).

| # | Delta | Seam |
| :- | :--- | :--- |
| **D1** | The `stale` branch emits a **target-lost** rejection under the new code **`[E_TARGET_LOST]`** (D6): no `Current range:` heading, no retry hint, and **no `HASH│content` rows**. The message names the previously served position in prose only. The branch serves rows **only** when at least one bound is live *and* its rebased coordinate equals its served coordinate — evidence that no shift occurred; then the window is the served coordinates and the code stays `[E_STALE_RANGE]`, exactly as today. | `src/hashline/lease-resolve.ts:175-176,186-209` |
| **D2** | A target-lost rejection performs **no** `recordRejectionServe` upsert — there are no rows to lease — so an accidental retry cannot write. Leasing stays for every window that identifies the model's region (in-place drift, `E_UNSERVED_RANGE`, `E_BATCH_ABORT`, content-placeable `E_STALE_ANCHOR`). Because no non-leasing serve is introduced, ADR-0016's *"serve … does so through the atomic lease upsert"* stays literally true. As-built, the skip is owned solely by the `servedRows.length === 0` length check — no code branch (see the as-built record below). | `src/mutation-engine/pipeline.ts:478-497`, `src/served-session/session.ts:670,705` |
| **D3** | The retry hint stays an unconditional suffix of `assembleRejectAndServe`, which renders only row-carrying rejections. The stale-identity branch bypasses the assembler: `makeTargetLostRejection` carries no retry hint and instead carries the recovery sentence `The line you targeted was deleted or replaced; your anchors describe a version of this file that no longer exists. Read the file and re-target.` (`TARGET_LOST_RECOVERY`). No `retryHint` parameter exists as-built (see the as-built record below). | `src/hashline/served-verification.ts:107,151-170,177-198` |
| **D4** | One wording family across `E_STALE_ANCHOR` / `E_STALE_RANGE` / `E_UNSERVED_RANGE` / `E_SERVED_ECHO`, and anchors are reported **per distinct anchor** (see Appendix C and Revision check). | `src/hashline/resolve.ts:202`, `src/hashline/lease-resolve.ts:103-120`, `src/hashline/served-guard.ts:259` |
| **D5** | **Content placement is banned from the payload.** `uniqueAnchorLine` may not place a rejection window, and neither `firstOffendingLine` nor the headline's line number may be derived from a content match for a retired bound. Probe `P` measured the header naming **line 4** for a line-2 lease; the headline must name the lease's **served** coordinate. As-built, `resolveLineIdentity` takes `(lease, source)` only — the `contentLine` parameter is removed, so no caller can pass a content match into identity resolution. | `src/hashline/lease-resolve.ts:175-176,186-209`, `src/hashline/resolve.ts:77-95,128-131` |
| **D6** | **A new code, `[E_TARGET_LOST]`**, carries exactly the region-unidentifiable rejections of D1. The two codes become disjoint and mutually exclusive by payload shape: **`[E_STALE_RANGE]` always renders rows; `[E_TARGET_LOST]` never does.** A model can therefore choose its remedy from the code alone, which is what finding 2's same-code/opposite-advice collision made impossible. `README.md`'s error table, `CONTEXT.md` and the prompts gain the code; downstream consumers see one new literal. As-built, `makeTargetLostRejection` takes `{ headline, servedLine }` only — the `snapshot` parameter is removed. | `src/hashline/lease-resolve.ts:186-209`, `src/hashline/served-verification.ts:30,186-198` |

Explicitly unchanged: the fast path, the dynamic rebase path, `E_UNSERVED_RANGE`, in-place `E_STALE_RANGE` (tombstone/canon/length mismatch — coordinates there are the model's own and remain servable), `E_STALE_ANCHOR` for a content-placeable unleased anchor (its self-healing retry is what recovered `yHj` in one round trip), and every write-safety gate.

### As-built contract record (`26c3a34`)

Landed `26c3a34` (*"tighten rejection seams, add oracle"*) narrows three seams beyond the sketch above. Every change is internal to the seams — no model-facing promise changed, so `README.md`'s error table, `CONTEXT.md`, and the prompts need no further edit for this task (the `[E_TARGET_LOST]` row and its read-and-retarget remedy are already recorded):

- `resolveLineIdentity(lease, source)` (`src/hashline/resolve.ts:77-95`) — the `contentLine` parameter is removed. Identity resolution is lease-derived only, which is what makes D5 structural rather than conventional.
- `makeTargetLostRejection({ headline, servedLine })` (`src/hashline/served-verification.ts:186-198`) — the `snapshot` parameter is removed. A target-lost payload cannot carry rows by construction.
- `recordRejectionServe` (`src/mutation-engine/pipeline.ts:478-497`) — the `code === "E_TARGET_LOST"` runtime guard is retired in favour of the `servedRows.length === 0` length check, which the oracle below pins (`servedRows: []`). No code branch is needed because the payload invariant is proved.
- `assembleRejectAndServe` keeps its unconditional retry-hint suffix (`src/hashline/served-verification.ts:151-170`); the spec-sketch `retryHint?` parameter was never added — D3 holds because target-lost bypasses the assembler entirely.
- `batchAbortFor({ error, index, path })` and `batchAbortServeBlock({ rows, originalNormalized })` (`src/mutation-engine/pipeline.ts:518-536`) drop the already-rendered span inputs, so a batched rejection renders one serve block with one `[MODEL]` prefix.

## User Stories

1. As a model whose target line was deleted or replaced externally, I want a rejection that says my target is gone, so that I re-read instead of overwriting whichever line took its number.
2. As a model, I want a rejection whose region cannot be identified to carry **no** rows, so that I cannot mistake a diagnostic window for the lines my anchors identify.
3. As a model, I want to be told *why* my anchors no longer work (`your anchors describe a version of this file that no longer exists`), so that a re-read is obviously the only recovery rather than a suggestion.
4. As a model in the in-place drift case (`beta` → `BETA`, same coordinate), I want `Current range:` plus the retry hint exactly as today, so that the common recovery still costs zero reads.
5. As a model whose anchor is content-current but unleased (cross-file reuse), I want the self-healing retry to keep working, so that one round trip still recovers without a read.
6. As a model, I want the same recovery wording for anchors, ranges and never-served spans, so that I do not have to infer which prescription applies.
7. As a developer, I want `retryHint` to be a property of the rejection rather than a suffix of every render, so that a new rejection path cannot inherit the hint by accident.
8. As a developer, I want an architecture test asserting that every rejection payload's rows are derivable from the submitted anchors' live mapping, so that a content-placed window cannot re-enter through a path nobody has thought of.
9. As a maintainer, I want the miswrite pinned by a regression test, so that the ADR-0016 guarantee is asserted by the suite instead of assumed.
10. As a maintainer, I want the ADR-0016 recovery clause amended, so that the docs stop promising a recovery that cannot be safe.

## Implementation Decisions

### Decision table (replaces spec §5.3 rows 3 and 5; rows 1, 2, 4 unchanged)

| Failure condition | Seam | Code | Window | Hint | Leased |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Anchor not present in `served_leases`, content-placeable | `resolveLeasedEdit` | `[E_STALE_ANCHOR]` | the anchors' current range | retry | yes |
| Anchor not placeable by lease or content | `resolveLeasedEdit` (`throwStaleAnchor` fallback) | `[E_STALE_ANCHOR]` | ±1 context of the placeable boundary, or none | read | no (rows already unleased) |
| Target span contains unread interior lines | `verifyRebasedSpan` / `ServedVerification` | `[E_UNSERVED_RANGE]` | current range | retry | yes |
| **Leased `line_id` retired, region unidentifiable** (deleted, or one bound stale and the other shifted) | `resolveLeasedEdit` (`stale` branch) | `[E_TARGET_LOST]` | **none** — the message names the previously served position in prose | **read and re-target** | **n/a (no rows)** |
| **Leased `line_id` retired, text re-added elsewhere (Probe `P`)** | same | `[E_TARGET_LOST]` | **none** — text at another coordinate is not the model's region | **read and re-target** | **n/a** |
| Leased `line_id` retired **in place**, other bound live and unshifted | same | `[E_STALE_RANGE]` | the served coordinates (unchanged; pinned by `test/integration/served-range-verification.test.ts:250`) | retry | yes |
| In-place content/tombstone/canon mismatch at the model's coordinates | `ServedVerification` | `[E_STALE_RANGE]` | current range | retry | yes |
| External insert strictly inside the span (Probe `J`) | `verifyRebasedSpan` | `[E_STALE_RANGE]` | so far: unchanged by this patch (window = served/rebased window) | retry | yes — revisit if Probe `J` can also shift the window |

### Message contract

```text
[MODEL] [E_TARGET_LOST] line <servedLine> in <path> no longer resolves to the line identity it was served with.
The line you targeted was deleted or replaced; your anchors describe a version of this file that no longer exists. Read the file and re-target.
```

No `HASH│content` rows are rendered in the target-lost case, so the payload cannot be used to write anything. `<servedLine>` is the lease's **served** coordinate (D5), never a content match. `[E_STALE_RANGE]` always renders rows; `[E_TARGET_LOST]` never does (D6) — the split is machine-readable, so the two remedies can no longer be confused.

- The `[MODEL] [CODE]` prefix, the `E_STALE_*` code and the byte-identical-on-rejection guarantee are unchanged.
- `assembledRejectAndServe` keeps one renderer; `heading` and `hint` become parameters so the three codes cannot drift (they currently do — Appendix C).
- Distinct-anchor counting: `refused` is deduped by anchor before the label/count are computed; a single anchor used as both bounds reports `1 anchor` with one quoted value.

### Fail-closed ordering

D1–D5 execute before any write and therefore preserve spec §7.1 invariants 1–5 (*Sound Execution* in particular): the patch strengthens it by refusing to *present* a coordinate the model never targeted.

## Verification

New tests (all must fail on `bd3a8f2` and pass after):

1. `test/integration/stale-identity-serve.test.ts` — external deletion of the target line → the rejection is `[E_TARGET_LOST]` with no `Current range:`, no `Retry with these anchors`, and **no `HASH│content` row at all**, and it names the previously served position in prose; the file is byte-identical afterwards.
2. Same file — the rejection leaves the session's leases unchanged: re-submitting the same anchors rejects again identically (nothing was leased), and the file stays byte-identical (D2).
3. Same file — after a `read`, the same edit at the correct anchors applies (recovery still terminates).
4. `test/integration/served-range-verification.test.ts` (extend) — the in-place drift case keeps `Current range:` + retry hint and still applies without a read (regression guard for D3's default).
5. `test/hashline/lease-resolve.test.ts` (extend) — the `stale` branch returns `[E_TARGET_LOST]` with **no** `servedRows` and no retry hint when the region is unidentifiable, and `[E_STALE_RANGE]` with the served-coordinate window when one bound is live and unshifted (D1/D6).
6. `test/core/reject-and-serve-seam.test.ts` (extend) — `recordRejectionServe` performs no lease upsert for a target-lost payload; a content-placeable `[E_STALE_ANCHOR]` payload still does.
7. Diagnostics — `"635"` used for both bounds renders `1 stale anchor …: "635"` (count and plural), and no rendered rejection repeats the same served block twice.
8. **Probe `P`** — retire the target in place and re-add its text elsewhere: the rejection is `[E_TARGET_LOST]`, the headline names the **served** coordinate (not the re-added line) and the payload carries no row for the re-added text (D5).
9. **Oracle (arch):** `test/arch/rejection-payload-region.test.ts` — every rejection payload's rows are derivable from the submitted anchors' live mapping (`served`/rebased coordinates); a row placed by a content match fails the test (D5, ADR-0018 decision 4). As-built, the oracle is a runtime matrix driven through the public edit seam plus a planted-violation negative control. The `assertLivePayload` helper pins the invariant per case: an `[E_TARGET_LOST]` payload carries zero rows and no `Current range:` heading, while every other payload carries rows under that heading, each row's hash reproducing the current on-disk hashes exactly and each row's line inside the caller-named live window. The file never imports the content lookup, and each window is hardcoded from served-coordinate knowledge, so a content-placed window cannot satisfy the check. Scenario matrix: live lease applies with no rejection; in-place retire keeps `[E_STALE_RANGE]` with the served window (lines 1–3); re-added text elsewhere (Probe `P`) rejects `[E_TARGET_LOST]` naming the served line 2, never line 4; deleted target rejects `[E_TARGET_LOST]` naming line 3; interior gap rejects `[E_UNSERVED_RANGE]` with the current window (lines 3–7); unleased boundary rejects `[E_STALE_ANCHOR]` with its current window (lines 4–5); duplicate anchor rejects `[E_STALE_ANCHOR]` with both colliding rows; batched call aborts atomically (`[E_BATCH_ABORT]`, later span served) and a stale item keeps its own `[E_TARGET_LOST]` plus the atomicity trailer. Planted-violation evidence: a misplaced-row payload and a rows-carrying target-lost payload are constructed and asserted to fail the check, proving the oracle can fail. Code disjointness (item 10) is enforced per case by the same helper.
10. **Code disjointness (arch):** every `[E_TARGET_LOST]` payload has zero rows and every `[E_STALE_RANGE]` payload has at least one; the two sets never overlap (D6).

Gates: `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` (unchanged thresholds).

## Appendix A — Reproduction harness

```ts
// test/integration/stale-identity-serve.test.ts (sketch)
const read = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
const gamma = extractHash(getText(read).split("\n").find((l) => l.includes("│gamma"))!);
await writeFile(path, "alpha\nbeta\ndelta\n", "utf-8");          // external delete of `gamma`

const rejected = await editTool.execute("e1",
  { file: "sample.ts", edits: [{ anchor_from: gamma, anchor_to: gamma, replace_with: "GAMMA_NEW" }] },
  undefined, undefined, ctx).catch((e) => e as Error);

expect(rejected.message).toMatch(/\[MODEL\] \[E_STALE_RANGE\]/);
expect(rejected.message).not.toContain("Current range:");            // D1
expect(rejected.message).not.toContain("Retry with these anchors");  // D3
expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ndelta\n");  // nothing written

expect(rejected.message).not.toMatch(/^[A-Za-z0-9]{3}│/m);           // D1 — no rows rendered
await expect(editTool.execute("e2",       // nothing was leased: the same call rejects again
  { file: "sample.ts", edits: [{ anchor_from: gamma, anchor_to: gamma, replace_with: "GAMMA_NEW" }] },
  undefined, undefined, ctx)).rejects.toThrow(/E_STALE_RANGE/);
expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ndelta\n");
```

Observed on `bd3a8f2` (the defect): the hint-window edit was accepted, the tool answered `Successfully edited 1 file(s)`, and the file became `alpha\nbeta\nGAMMA_NEW\n`.

## Appendix B — Live-session evidence

| Fact | Evidence |
| :--- | :--- |
| The model's own earlier edit retires the identity, then re-uses the anchor | `merge_copy.py` edit at L146 item[2] replaces the `4FT` line; L388 edit with `4FT` rejects `[E_STALE_RANGE]` |
| The served window is the stale coordinate, not the target | rejection text: `line 34 … Current range: rtW│    "commitlint.config.cjs",` while the target was `_ = parser.add_argument("target_branch", …)` |
| The model cannot tell what the window means | transcript thinking at L390: *"Given the reported current range is `rtW│    \"commitlint.config.cjs\",` which was part of the COMMITLINT_CONFIG_NAMES tuple … I suspect the issue is that the tool resolves an edit item's anchors by line identity…"* |
| The hint is followed literally elsewhere | `yHj` failed at L194 and the **byte-identical** call succeeded at L197 with no read (valid for a content-placeable unleased anchor, which is why D3 keeps that path's hint) |

## Appendix C — Doc/word drift to fix with D4

| Location | Current | Problem |
| :--- | :--- | :--- |
| `src/hashline/resolve.ts:202` | `"[E_STALE_ANCHOR] N stale anchors … Re-read the full file and copy the fresh 3-char anchors (the 3 chars before │, e.g. "wUp")."` | counts the same anchor twice when `anchor_from === anchor_to`, and advises a re-read where `lease-resolve.ts` promises no read is needed for the same code (`Call read() to get fresh anchors.` was removed on `ba7c8d2`; the divergence remains) |
| `src/hashline/lease-resolve.ts:110-114` | `"anchor(s) … not present in the served leases … Retry with these anchors (no read needed)."` | plural label from a 2-element array; same anchor listed twice |
| `src/mutation-engine/pipeline.ts:505` | batch abort appends `Current on-disk range for edit[i] (unchanged — nothing was written):` after a rejection that already printed `Current range:` | duplicate served block costs tokens and reads as two different windows (re-confirmed on `ba7c8d2`) |
| `README.md:196` | *"`[E_STALE_RANGE]` … the current range is served as fresh `HASH│content` rows; retry with those rows (no `read` needed)"* | must be split three ways: in-place retirement (current range + retry), torn/inserted span (current range + retry), and target-lost (prose only, **no rows**, read) |
| spec §5.3 (line 641) | recovery column says *"Echoes current range; model retries"* for the retired-`line_id` row | replaced by the decision table above |

## Appendix D — Follow-ups

1. **ADR-0016 amendment.** Written as [`../../docs/adr/0018-region-scoped-rejection-serves.md`](../../docs/adr/0018-region-scoped-rejection-serves.md) (status `proposed`): it deletes ADR-0016's Consequences parenthetical (*"or by `reject-and-serve`'s served rows"*), leaves ADR-0016's Decision intact, and records the region rule plus the derivable-rows oracle. Link and accept it with the patch.
2. **`CONTEXT.md` needs one glossary entry** (domain-modeling signal): **target-lost rejection** — a rejection whose region cannot be identified, so it carries no rows and recovery is a re-read. Scope the existing `reject-and-serve` entry's *"the retry needs no read"* to region-matched serves. The previously proposed **context serve** term is dropped: with D1 there is no such operation.
3. ~~Consider serving nothing at all~~ — **resolved**: that is now the decision for the unidentifiable case (D1), while the identifiable case keeps serving (D1's live-and-unshifted condition, which keeps `served-range-verification.test.ts:250` green).
4. **Watch Probe `J`.** `verifyRebasedSpan`'s window is the served/rebased span; if an external insert inside the span can also move the window, the same non-identification argument applies. Not observed in this session — add a probe before claiming it safe.

## Revision check — re-verified on `ba7c8d2` (`main`)

The dev checkout was fast-forwarded from `bb049dc` to `ba7c8d2` (*"gate reproduced served rows behind a literal declaration"*) before this patch was written. The Appendix A harness reproduces the deletion defect **byte-identically** there — same `[MODEL] [E_STALE_RANGE]`, same `Current range:` heading, same `YAz│delta` row, same accepted retry writing `alpha\nbeta\nGAMMA_NEW\n` — and the suite is green (1384 passed / 1 skipped), so the defect is unpinned on `main`.

Probe `P` (run on `ba7c8d2`, scratch test deleted): `sample.ts` = `alpha\nbeta\ngamma\n`, `beta` replaced in place and its text re-added at line 4 → the rejection headline read **`line 4 in sample.ts no longer resolves…`** for an anchor leased at line 2, the window was **`poj│beta`** (the re-added line, labelled `Current range:`), and the leased retry wrote line 4. Confirms the content arm of `fromContent ?? fromLease.servedLineNumber` rebinding a retired identity onto a different `line_id` — ADR-0008's class, with a lease on it. This is what D5 exists to remove.

What `main` changed on these seams:

| Seam | Change | Effect on this spec |
| :--- | :--- | :--- |
| `src/hashline/lease-resolve.ts` | one line: `valEdit(edit, snapshot, undefined)` at `throwStaleAnchor` | none — the `stale` branch and its historical-coordinate window are untouched |
| `src/hashline/served-verification.ts`, `src/served-session/session.ts` | unchanged | D1–D6 apply verbatim; `retryHint()` is still the unconditional suffix (`:107`) |
| `src/hashline/served-guard.ts` (new) | `E_SERVED_ECHO` gate + `mode: "literal"` escape | **adds a third recovery contract** to D4's wording unification — `Remove the copied anchors and retry, or declare intent with mode: "literal"` (`served-guard.ts:259`, `:275`). ADR-0009's 2026-09-15 revision freezes the literals `findServedHashEcho` / `E_SERVED_ECHO` / `served hash echo` |
| content surface (`src/hashline/resolve.ts`, −63 lines) | shape-based refusal removed | `replace_with` containing anchor-shaped lines whose anchors/canons were never served is now **written verbatim** (measured: `ZZZ│alpha` reached disk, `Successfully edited 1 file(s)`). Intentional — ADR-0009 revision: *"the tool never gates on the shape of a line"*; served-row echoes are still refused. It re-opens the session's `[E_BAD_ANCHOR]` failure class as a fail-open write, so D4 should decide whether the unserved case warrants the non-blocking `[MODEL]` note that the served-prefix tier already uses. `README.md:185` was **not** updated: it still documents `[E_BAD_ANCHOR]` for a `replace_with` holding a `HASH│` prefix, a refusal that no longer exists — the row must be split into anchor-field refusal (`[E_BAD_ANCHOR]`, still live in `parse.ts` and `resolve.ts:340-358`) vs content refusal (`[E_SERVED_ECHO]`, served rows only) |

Post-sync reference points for the citations above: `lease-resolve.ts:173-183` (stale branch), `:103-120` (`throwStaleAnchor`), `served-verification.ts:107` (`retryHint`), `:128-171` (`buildRangeServeBlock`/`assembleRejectAndServe`), `:172`/`:195` (the two rejection builders), `pipeline.ts:471-485` (`recordRejectionServe`, call sites `:332` and `:557`), `pipeline.ts:505` (duplicate batch block), `session.ts:679,705,953`, `resolve.ts:202` (`formatNotFound`), `README.md:196`, MVCC spec §5.3 row at `:643`.

## Appendix E — Every `E_STALE_RANGE` producer, audited against the region rule

Producers found by `rg -n 'E_STALE_RANGE' src/` on `ba7c8d2`. “Region-provable” means the window's coordinates come from **the model's own anchors** — `lease-resolve.ts` served/rebased coordinates, or `ServedVerification`'s caller-supplied `startLine`/`endLine` — never from a content search. `resolveServedSpan` (`served-verification.ts:533-560`) looks up the model's anchors in the **served mirror** (`servedPositionsOf`), not in the file's content, so families F and R are region-provable by construction; the only content lookup on a rejection path is `uniqueAnchorLine` in the lease seam (L3).

| # | Scenario | Producer | Window source | Region-provable? | Under the new design |
| :--- | :--- | :--- | :--- | :--- | :--- |
| L1 | retired **in place**, other bound live and unshifted | `lease-resolve.ts:173-183` | served coords | yes — a live bound proves no shift | serve + retry, **`[E_STALE_RANGE]`** (unchanged; pinned by `served-range-verification.test.ts:250`) |
| L2 | retired in place, both bounds the same dead anchor (session `4FT`) | same | served coords | **no** — no live bound to prove it | no rows, read — **`[E_TARGET_LOST]`** |
| L3 | retired, text re-added elsewhere (Probe `P`) | same, `fromContent` arm | **content match** at another coordinate | **no** — a different `line_id` | no rows, read — **`[E_TARGET_LOST]`**; D5 deletes the arm |
| L4 | deleted, neighbour shifts in (Probes `E`, `A`) | same | served coordinate now holding another line | **no** | no rows, read — **`[E_TARGET_LOST]`** |
| L5 | one bound stale, the other live but shifted | same | stale coord → rebased coord | **no** — the live bound moved | no rows, read — **`[E_TARGET_LOST]`** |
| F1 | tombstone boundary (`S@3==S@3`, canon differs) | `served-verification.ts:401` | the model's coordinates | yes | serve + retry, `[E_STALE_RANGE]` (unchanged) |
| F2 | canon collision at the same position | `:449` | the model's coordinates | yes | unchanged |
| F3 | tombstone interior | `:469` | the model's coordinates | yes | unchanged |
| F4 | served span length ≠ current length | `:632` | the model's coordinates | yes | unchanged |
| F5 | stale interior hash | `:644` | the model's coordinates | yes | unchanged |
| R1 | rebased span length ≠ served length | `:252` (`verifyRebasedSpan`) | the rebased span (the model's live coordinates) | yes | unchanged |
| R2 | rebased interior identity retired or moved | `:286` | the rebased span | yes | unchanged |

Result: five fail-open-capable scenarios, all in the lease seam, all fixed by D1/D5/D6; seven sound scenarios, untouched. `E_STALE_RANGE` keeps its rows in every remaining case, so the audit also shows why D6 is safe: no sound producer is row-less, and the row-less case has no sound producer.
