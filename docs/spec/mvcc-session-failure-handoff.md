# Handoff: MVCC session failure triage — 7 edit failures, 11 findings

Status: handed off — one defect fix spec'd ([`stale-identity-reject-and-serve.md`](stale-identity-reject-and-serve.md)), the rest are documentation, wording and one prompt fix.
Sessions: the 2026-09-15 triage session in `~/stowfiles/claude-skills/harness/everything-claude-code` (full log path in Appendix D).
Revision under test: installed `git:github.com/Rianico/pi-better-edit@main` at `bd3a8f2` (*"adopt line-identity MVCC with leases"*). Its `src/hashline/*`, `src/mutation-engine/pipeline.ts` and `src/served-session/session.ts` are byte-identical to the checkout this handoff was written in (`bb049dc`). `main` has since moved to `ba7c8d2` (*"gate reproduced served rows behind a literal declaration"*), which the checkout was fast-forwarded to for re-verification; **the installed extension is still `bd3a8f2`**.
Patch target: [`content-addressed-line-identity-mvcc.md`](content-addressed-line-identity-mvcc.md) (§9 appendix added).

## Scope & Method

1. Enumerated every `edit` call in the session (59 calls) and paired each with its tool result; 7 failed, all recovered by the model.
2. Traced each failure to the producing seam and to the anchor it used.
3. Diffed the class against `bd3a8f2^` (pre-MVCC) to separate **new-design** from **pre-existing**.
4. Reproduced the one defect with scratch vitest integration tests (harness in the patch spec, Appendix A); the tree was left clean and `pnpm vitest run` stayed green (`1339 passed / 1 skipped` on `bb049dc`, `1384 passed / 1 skipped` on `ba7c8d2`).

## Bottom line

| Class | Count | What it means |
| :--- | :--- | :--- |
| **New-design defect** | 1 | `E_STALE_RANGE` for a retired identity serves and leases the *stale coordinate* → silent wrong-line write (finding 1) |
| **New-design gaps** | 3 | contradictory rejection wording (2), self-inflicted staleness guidance (3), misleading cross-file wording (4) |
| **Pre-existing** | 6 | allocation function (5), duplicate count/plural (6), batch-abort repetition (7), doubled `[MODEL]` tag (8), digit anchors (9), `E_BAD_ANCHOR` on bash output (10) — note that the **content** arm of `E_BAD_ANCHOR` is gone on `ba7c8d2` (the code now covers anchor fields only) and `README.md:185` still documents the removed refusal |
| **Third-party** | 1 | pi-lens rewrites `read` windows (11) |

**No failure is caused by MVCC core breakage.** Six of the seven failures are anchor-provenance mistakes the pre-MVCC design also rejected; the seventh (`4FT`) is a correctly retired identity. The defect is in the *recovery payload*, not in resolution.

## Re-verification on `ba7c8d2` (`main`, synced 2026-09-15)

The checkout was fast-forwarded `bb049dc` → `ba7c8d2` (*"gate reproduced served rows behind a literal declaration"*, #134) and every finding was re-measured with fresh scratch repros, deleted afterwards (`git status` clean). Suite on the synced checkout: **1384 passed / 1 skipped**.

| # | Finding | Status on `ba7c8d2` | Evidence |
| :--- | :--- | :--- | :--- |
| 1 | Retired-identity rejection serves **and leases** the stale coordinate | **open — byte-identical** | same `[MODEL] [E_STALE_RANGE] line 3 … Current range: YAz│delta … Retry with these anchors (no read needed).`; the retry is accepted → `alpha\nbeta\nGAMMA_NEW\n` |
| 2 | Two producers, one code, opposite advice | **partly fixed** | `Call read() to get fresh anchors.` is gone from `resolve.ts:202` (batch-abort fallback `pipeline.ts:509` still has it), so `[E_STALE_ANCHOR]` still carries *either* `Re-read the full file…` (unplaceable) *or* `Retry with these anchors (no read needed).` (content-placeable) |
| 3 | Blank-line anchors identical across files | **open — measured** | first blank line is `AuN` in unrelated files; reuse against a path with no lease → `[E_STALE_ANCHOR] anchors "AuN", "AuN" are not present in the served leases for second.ts` |
| 4 | Defect in the recovery payload | **open** | `served-verification.ts` and `served-session/session.ts` were not touched by `ba7c8d2`; the patch spec's D1–D5 apply unchanged |
| 4a | Cross-file reuse wording | **open** | same message as #3 |
| 5 | Anchor allocation | unchanged | pure vs incremental hash lists are still equal |
| 6 | Duplicate count/plural | **open — measured** | `[E_STALE_ANCHOR] 2 stale anchors in sample.ts: "ZZZ", "ZZZ".` for **one** anchor used as both bounds |
| 7 | Batch abort repeats the served block | **open — measured** | `Current range: / YSH│BETA / Retry with these anchors (no read needed). Current on-disk range for edit[1] (unchanged — nothing was written): / YSH│BETA` |
| 8 | Doubled `[MODEL]` tag | open | same wrapper in `pipeline.ts:533` |
| 9 | Digit anchors | **open — quantified** | `ALPHA` is `A-Za-z0-9`, so a 3-char anchor **may** be all digits (`733`; 1 of 400 served anchors in one read) and `parse.ts`'s fast path (`length === 3 && ALPHA_RE`) accepts it — the `^\d+` diagnostic at `parse.ts:13` is unreachable for a 3-char numeric ref (it fires on `12`, `1234`). The residual hazard is only the coincidence: a pasted **line number** that is also a live anchor resolves silently to another line |
| 10 | `E_BAD_ANCHOR` on bash/`sed` output | **changed, not fixed** | shape-based refusal was removed from the content surface on purpose (ADR-0009 revision 2026-09-15, *"the tool never gates on the shape of a line"*): `replace_with` holding `ZZZ│alpha` (never served) is now **written verbatim** and reported `Successfully edited`; a *served* row echo is refused as `[E_SERVED_ECHO]` with a `mode: "literal"` escape |
| 11 | pi-lens read dilation | unchanged | pi-lens still 4.1.6 |
| 12 | **Retired identity rebinds onto re-added identical text** (Probe `P`) | **new — measured** | the rejection headline named **line 4** for an anchor leased at line 2, served `poj│beta` under `Current range:`, and the leased retry wrote line 4 — the `fromContent` arm of `lease-resolve.ts:173-183`; the fourth variant of finding 1 |

New surface to absorb into the wording work: `[E_SERVED_ECHO]` + `mode: "literal"` is a **third** rejection contract alongside "re-read" and "retry with these anchors" (frozen literals per ADR-0009 revision; see the patch spec's Revision check). Findings 1, 3, 6, 7 and 9 were each re-measured with a scratch repro that was run and then deleted — they are evidence for this handoff, not landed regression tests; nothing in the upstream suite regressed.

## Provenance — measured against the pre-MVCC baseline (`9c2538d`, v1.7.0)

One probe file, five cases, run in a detached worktree of `bd3a8f2^` and then on `ba7c8d2`. `bd3a8f2` *is* the MVCC change (parent `9c2538d`; 124 files, +12078/−2023), so the two runs separate what MVCC ***caused*** from what it merely re-worded.

| Probe | pre-MVCC `9c2538d` | MVCC `ba7c8d2` | Attributed to |
| :--- | :--- | :--- | :--- |
| Target line deleted externally, then edited | `[E_STALE_ANCHOR] 2 stale anchors … "6DM", "6DM". Re-read the full file…` — **no rows served**, file unchanged, nothing to retry with | `[E_STALE_RANGE] … Current range: YAz│delta / Retry with these anchors (no read needed).` — the retry **overwrites `delta`** | **MVCC — the finding-1 defect** |
| Anchor unleased but content-placeable (cross-file, unique content) | `[E_UNSERVED_RANGE] cannot verify range against served state … retrying without re-reading cannot clear a stale duplicate outside the echoed window` + current range | `[E_STALE_ANCHOR] … not present in the served leases … Retry with these anchors (no read needed).` + current range | **MVCC** — one code now carries two opposite prescriptions (finding 2) |
| Cross-file blank-line anchor (`8vX` class) | `[E_UNSERVED_RANGE] … anchor_from "AuN" has no served position` — rejected, file unchanged | `[E_STALE_ANCHOR] anchors "AuN", "AuN" are not present in the served leases…` — rejected, file unchanged | **pre-existing** — the served mirror was already per-path; wording only |
| Cross-file reuse against a byte-identical copy (`yHj` class) | `[E_UNSERVED_RANGE] … "WXo" has no served position` — rejected | `[E_STALE_ANCHOR]` + the anchors' current range; the session's byte-identical retry then succeeded | **pre-existing**; MVCC makes the self-heal explicit |
| One anchor as both bounds (count/plural) | `[E_STALE_ANCHOR] 2 stale anchors in a.ts: "ZZZ", "ZZZ". Re-read the full file and copy the fresh 3-char anchors (the 3 chars before │, e.g. "wUp").` | **byte-identical string** | **pre-existing in full** — finding 6 is not half-new |
| In-place change inside the served range | `[E_STALE_ANCHOR]` + `Current context around resolved anchor` rows; retry with the context anchor applies (`alpha\nBETA2\n`) | `[E_STALE_RANGE]` + `Current range:` rows; retry applies | **pre-existing mechanism** — the legitimate case whose remedy MVCC reuses for the deleted case |

**Verdict.** MVCC's identity / snapshot / rebase core caused **no** failure: 6 of the 7 session failures reproduce identically or near-identically on the pre-MVCC baseline, so the session's error *volume* is model-side anchor provenance, not the design. The MVCC commit caused exactly two things — (a) **finding 1**: a *retired or absent* identity is routed into the in-place-drift recovery, which serves and leases a coordinate that identifies nothing (pre-MVCC served **no** rows here and said "re-read"); (b) **finding 2**: two previously distinct codes (`E_UNSERVED_RANGE` "retrying without re-reading cannot clear…" vs `E_STALE_ANCHOR` "Re-read the full file") collapsed into one code with opposite prescriptions. `ba7c8d2` then added a third, unrelated to MVCC: removing the content-surface shape refusal makes never-served anchor-shaped `replace_with` land verbatim.

## Failure inventory

| # | File | Code | Anchor provenance | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `dynamic-workflow-wrapper/references/agents/developer.md` | `E_STALE_ANCHOR "yHj"` | read from **`.pi/agents/developer.md`** (the canonical file); the target is a byte-identical copy | cross-file reuse; byte-identical retry succeeded (valid self-heal — the anchor was content-placeable) |
| 2 | `branch-worktree-pr/scripts/README.md` | `E_STALE_ANCHOR "8Od"` | read from `scripts/changelog-unreleased.py` | cross-file reuse; fixed after `read` |
| 3 | `branch-worktree-pr/SKILL.md` | `E_STALE_ANCHOR "8vX"` | blank line served in `OUT-OF-SCOPE.md:4` **and** `wt-template.toml:26` | cross-file reuse on a blank line (identical by construction — Appendix C) |
| 4 | `dynamic-workflow-wrapper/workflows/converge-tasks.js` (15-item batch) | `E_STALE_ANCHOR "635"` | `grep -n` output (`635:    \`3. Verify…\``) | line number taken for an anchor; model self-diagnosed at L260 |
| 5 | same batch, resubmitted | `E_STALE_ANCHOR "464"` | same `grep -n` output | same mistake, second item |
| 6 | `branch-worktree-pr/scripts/merge_copy.py` | `E_STALE_RANGE` line 34 | `"4FT"` — retired by the model's own earlier edit (L146 item[2] replaced that line) | **correct fail-closed**, but the recovery hint is the defect in finding 1 |
| 7 | `toolchain-wiki/subskills/worktrunk/SKILL.md` | `E_BAD_ANCHOR` | `sed -n`/`grep` output (`wt list --format=json \| jq …`) | bash output used as anchors (no anchors there); pre-existing validation |

## Finding classification

| # | Finding | Class | Where | Action |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **Retired-identity rejection serves the stale coordinate and leases it** → silent wrong-line write (four variants; Probe `P` adds the content-rebind) | **new defect** | `lease-resolve.ts:173-183`, `served-verification.ts:107,128-171`, `pipeline.ts:471-485`, `session.ts:679,953` | [Patch spec](stale-identity-reject-and-serve.md) D1–D6 (new code `[E_TARGET_LOST]` + no-rows), [ADR-0018](../adr/0018-region-scoped-rejection-serves.md) (priority 1) |
| 2 | Two producers emit `E_STALE_ANCHOR` with opposite advice: *"Re-read the full file …"* vs *"not present in the served leases … no read needed"* | **new** — pre-MVCC used two distinct codes (`E_UNSERVED_RANGE` *"retrying without re-reading cannot clear…"* vs `E_STALE_ANCHOR` *"Re-read the full file"*), collapsed into one by `bd3a8f2`; `ba7c8d2` removed the `Call read()` sentence only | `resolve.ts:202` vs `lease-resolve.ts:109-117` | unify wording (priority 2) |
| 3 | Self-inflicted staleness: the model's own edit retires the replaced line's identity; the anchor is dead until a re-read (`4FT`) | new gap | intended per ADR-0016; guidance from finding 1 | fixed by D3 wording |
| 4 | Cross-file reuse rejected with wording that implies the file was never read rather than "this anchor belongs to another path" | pre-existing rejection (`E_UNSERVED_RANGE` "has no served position" on `9c2538d`); the wording is new | `lease-resolve.ts:110-114` | document lease scope in prompts (priority 3) |
| 4a | Blank-line anchors are **identical across files** (first blank line = same anchor by construction), so cross-file reuse is systematic, not rare | measured | Appendix C | same as 4 |
| 5 | Anchor allocation (`lineHashesPure`, `baseIdx = xxh32(canon) >>> 14`, preferred index, probe) | pre-existing (unchanged by `bd3a8f2`; only per-path authority is new) | `hash-identity.ts` | none — no allocation divergence found (Appendix C) |
| 6 | Duplicate count/plural: `"2 stale anchors …: "635", "635""` — one anchor counted twice, plural label from a 2-element array | **pre-existing in full** — the `resolve.ts` string is byte-identical to `9c2538d`; only the lease-path `refused.length > 1` label is new | `resolve.ts:202`, `lease-resolve.ts:103-117` | dedupe by distinct anchor (priority 2) |
| 7 | Batch abort repeats the served block (`Current range:` then `Current on-disk range for edit[i]`) | pre-existing | `pipeline.ts:505` | drop the second render (priority 4) |
| 8 | Doubled tag: `[MODEL] edit[3] (…) failed: [MODEL] [E_STALE_ANCHOR] …` | cosmetic side effect of the intended `batchAbortFor` improvement | `pipeline.ts:533` | strip the inner `[MODEL]` when wrapping (priority 4) |
| 9 | Digit anchors: 3-char digit strings are legal anchors (`ALPHA` includes digits) and are always read as anchors, never as line numbers; the `^\d+` diagnostic only fires for non-3-char numeric refs (`12`, `1234`) | pre-existing — **not a validation bug**; residual coincidence: a pasted line number equal to a live anchor resolves to that line | `alphabet.ts`, `parse.ts:13` after the `length === 3 && ALPHA_RE` fast path | optional hint on unleased all-digit anchors (priority 4) |
| 10 | `E_BAD_ANCHOR` on `sed`/`grep` content: the **content** arm was removed on `ba7c8d2`, so the code now guards **anchor fields only** (`parse.ts`, `resolve.ts:340-358`, still live); `README.md:185` documents the removed `replace_with` refusal — doc drift | pre-existing code, **new doc drift** | `resolve.ts` (content arms deleted), `parse.ts`/`resolve.ts` (anchor fields keep it), `README.md:185` | decide in D4 whether an unserved anchor-shaped `replace_with` deserves a non-blocking note, and split the README row (priority 6) |
| 11 | Served read window ≠ requested window (34 of 84 reads dilated) | third-party | pi-lens 4.1.6, `EXPANSION_LIMIT_LINES = 100` | document the interaction or disable while diagnosing (priority 5) |
| 12 | **Retired identity rebinds onto re-added identical text** (Probe `P`) | **new — measured** | `lease-resolve.ts:173-183` (`fromContent` arm); fourth variant of finding 1 | covered by D5 + the derivable-rows oracle (priority 1) |

## Action items

1. **Implement the patch spec** ([`stale-identity-reject-and-serve.md`](stale-identity-reject-and-serve.md)) — D1 target-lost rejection (no rows), D2 no serve upsert, D3 conditional retry hint, D4 unified wording, D5 content-placement ban, D6 new code `[E_TARGET_LOST]` disjoint from `[E_STALE_RANGE]`; plus the derivable-rows and code-disjointness oracles. *Acceptance:* the 10 verification tests in that spec, all failing on `bd3a8f2`, plus `lint/format/typecheck/test:coverage` green.
2. **One rejection-wording table.** `E_STALE_ANCHOR` / `E_STALE_RANGE` / `E_UNSERVED_RANGE` render from one assembler with `heading` and `hint` parameters; distinct-anchor counts. *Acceptance:* no message repeats an anchor or a served block; each cites either "read" or "retry", never both.
3. **Document lease scope in `prompts/read.md` and `prompts/edit.md`:** an anchor is a `(session, path)` lease, **never portable** — the same content in another file yields the same spelling but no lease; copy anchors only from this path's served rows. *Acceptance:* the cross-file class (3 of 7 failures) disappears from the next session's log; no code change required.
4. **Cheap diagnostic cleanups:** dedupe counts (6), single served block (7), strip the doubled tag (8), split the `README.md:185` `[E_BAD_ANCHOR]` row into anchor-field refusal vs `[E_SERVED_ECHO]` content refusal (10), optional all-digit-anchor hint (9).
5. **Third-party read dilation:** record in the docs that pi-lens mutates `read` args, so "the window the model asked for" ≠ "the window served/leased". Decide whether to pin `no-lsp` for anchor-sensitive sessions.
6. **Domain/decision records:** [ADR-0018](../adr/0018-region-scoped-rejection-serves.md) is written (`proposed`) — it deletes ADR-0016's *Consequences* parenthetical, leaves its Decision intact, and records the region rule plus the derivable-rows oracle. Add the `CONTEXT.md` entry **target-lost rejection**, scope `reject-and-serve`'s *"the retry needs no read"* to region-matched serves, and drop the planned **context serve** term (no non-leasing serve exists under D1).

## Appendix A — Session evidence

| Excerpt | Meaning |
| :--- | :--- |
| `[MODEL] [E_STALE_RANGE] line 34 in …/merge_copy.py no longer resolves to the line identity it was served with. / Current range: / rtW│    "commitlint.config.cjs", / Retry with these anchors (no read needed).` | the finding-1 payload: stale coordinate, unrelated line, retry hint |
| L390 thinking: *"Given the reported current range is `rtW│ "commitlint.config.cjs",` which was part of the COMMITLINT_CONFIG_NAMES tuple … I suspect the issue is that the tool resolves an edit item's anchors by line identity…"* | the model cannot tell what the window means |
| L260 thinking: *"The `635` anchor came from the grep output (`635: …`), which is a line number, not a hash! I mistakenly used the line number as an anchor."* | findings 4/5 |
| L194 `yHj` `E_STALE_ANCHOR` → L197 **identical** call succeeds with no read | reject-and-serve leases its rows (valid here: content-placeable anchor) |
| `8vX│` served as a blank line in two different files; `8Od│    args = parser.parse_args()` served from `changelog-unreleased.py`, used against `README.md` | findings 1–3's provenance |
| `[MODEL] edit[3] (…) failed: [MODEL] [E_STALE_ANCHOR] 2 stale anchors …: "635", "635"` | findings 6 and 8 in one line |

## Appendix B — Read-window dilation (third-party)

pi-lens 4.1.6 mutates the `read` tool input before execution when `limit ≤ EXPANSION_LIMIT_LINES (100)`: `readInput.offset = expansion.newOffset; readInput.limit = expansion.newLimit` (`pi-lens/dist/index.js:~110657-110662`, `tryExpandRead` at `~108980`). The transcript keeps the model's requested args; the served rows (and the leases/`served_line_number`s derived from them) come from the expanded window. Observed dilations:

| Requested | Served | File lines |
| :--- | :--- | :--- |
| `offset=58 limit=40` | `50-124` | 128 |
| `offset=141 limit=26` | `118-211` | 215 |
| `offset=116 limit=6` | `116-211` | 215 |
| `offset=19 limit=30` | `19-63` | 215 |
| `offset=26 limit=3` | `24-31` | 71 |
| `offset=168 limit=60` | `151-230` | 348 |
| `offset=80 limit=14` | `78-93` | 215 |
| `offset=44 limit=10` | `28-45` | 64 |
| `offset=120 limit=3` | `116-129` | 135 |
| `offset=195 limit=14` | `193-209` | 208 |

This is not a pi-better-edit defect (its `fmtReadPreview` honours offset/limit exactly — verified by calling the registered tool directly), but it explains the model's line-number arithmetic in the same session and it is worth documenting, because anchors and leases are derived from the **effective** window.

## Appendix C — Measurements and refuted hypotheses

- **Blank-line anchors are file-independent.** `_lineHashesPure` over four unrelated markdown/config files gave the *same* anchor for each file's first blank line (`AuN`) — the preferred index of `canon("")` is a constant, so blank-line anchors collide across paths by construction. In the session, `8vX` was the first-blank anchor in two unrelated files.
- **A 400-line read served exactly one bare 3-digit anchor** (`733`) — 3-char digit strings are legal anchors by construction (`ALPHA = A-Za-z0-9`) and the parse fast path accepts them, so the digit-anchor coincidence of finding 9 is ~0.25% per served line; the `^\d+` diagnostic in `parse.ts:13` is unreachable for a 3-char ref, i.e. a line number pasted as an anchor is *never* diagnosed as one — it resolves if a lease happens to carry that spelling.
- **No allocation-path divergence for identical content.** Hypothesis: `lineHashesPure(content)` and `mapStableHashes(prior → content)` could disagree for the same bytes (eviction would then re-spell anchors). Measured with a whitespace-variant duplicate pair (`a\n` → `a\na\n`): pure and incremental lists are **equal** — the survivor matcher assigns by canon proximity, which reproduces the pure order. Refuted; no action.
- **MVCC core is intact.** Every failure above is a recovery-payload or provenance issue; the identity resolution paths (`fast`, `rebased`, fail-closed) behaved as specified in all 59 calls.
- **Probe `P` — a retired identity is rebindable by its own content (measured).** `sample.ts` = `alpha\nbeta\ngamma\n`, read, then `beta` (line 2) replaced in place and its text re-added at line 4. The anchor leased for line 2 rejected with a headline naming **line 4** (`line 4 in sample.ts no longer resolves to the line identity it was served with.`), a window of `poj│beta` (the re-added line) under `Current range:`, and `Retry with these anchors (no read needed).`; the retry was leased and wrote line 4. Mechanism: `fromContent ?? fromLease.servedLineNumber` (`lease-resolve.ts:173-183`) prefers a *content* match for a bound whose identity is gone — ADR-0008's healing class, surviving inside the MVCC payload. This is the fourth variant of finding 1 and the reason the fix bans content placement, not just stale coordinates (`stale-identity-reject-and-serve.md` D5, ADR-0018).
- **Suite state:** `pnpm vitest run` → 1339 passed / 1 skipped on `bb049dc`, 1384 passed / 1 skipped on `ba7c8d2`. The defect in finding 1 is *unpinned* on both: `test/integration/served-range-verification.test.ts:36` covers only in-place drift (same coordinates, and it asserts the current-range serve *succeeds*), and `test/integration/served-truncation-external-shrink.test.ts:44` asserts mirror positions rather than the write.

## Appendix D — Reproduce this triage

```bash
S=~/.pi/agent/sessions/--Users-zhengxk-stowfiles-claude-skills-harness-everything-claude-code--/2026-09-15T10-29-25-142Z_01a0a49d-4415-7249-9ba5-e531c30176b1.jsonl
# pair every edit call with its result, list the failures
python3 - "$S" <<'PY'
import json,sys,collections
lines=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
calls, res = {}, {}
for o in lines:
    if o.get("type") != "message": continue
    m = o["message"]
    if m.get("role") == "assistant":
        for c in m.get("content") or []:
            if c.get("type") == "toolCall": calls[c["id"]] = c
    elif m.get("role") == "toolResult":
        res[m.get("toolCallId")] = " ".join(x.get("text","") for x in m.get("content") or [])
for cid, c in calls.items():
    if c.get("name") != "edit": continue
    txt = res.get(cid, "")
    if "[E_" in txt: print(c["arguments"].get("file","?").split("/")[-1], "->", txt[:120].replace("\n"," "))
PY

# what the tool actually received (dilation) vs what the model asked for
rg -o '\[Showing lines [0-9]+-[0-9]+ of [0-9]+' "$S" | sort | uniq -c | sort -rn | head
```
