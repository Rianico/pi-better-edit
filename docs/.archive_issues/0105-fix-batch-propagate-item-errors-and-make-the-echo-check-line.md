# fix(batch): propagate item errors and make the echo check line-relative

> **Archived from pre-migration issue #105.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T16:13:48Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## 1. Scope creep: `E_BATCH_ABORT` relabels payload/validation failures
Spec line 181 and the section 5.3 table (line 642) define `[MODEL] [E_BATCH_ABORT]` strictly for **overlapping or nested spans** across batch items.

`src/mutation-engine/pipeline.ts` `parseEdits` (L637-643) catches general syntax/parsing failures from `resEdit` when `items.length > 1` and relabels them `[MODEL] [E_BATCH_ABORT]`, conflating payload malformations with coordinate overlap.

**Operator decision (review 3, Q1, option (i))**: let the underlying error propagate **unchanged** - `E_BAD_ANCHOR`, `E_REVERSED_ANCHORS`, `E_SERVED_ECHO`, whatever `resEdit` raised - and append the atomicity trailer:

```
The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.
```

Rationale: if `edit[2]` carries a malformed anchor, `E_BATCH_ABORT` misleads the model into hunting for coordinate overlap instead of fixing the anchor string, while the trailer still explains why edits 0 and 1 were not committed.

**Also applies to `batchAbortFor`** (L486-522): the operator's call reserves `E_BATCH_ABORT` "for overlapping spans", so an error raised while *applying* an item in a batch must likewise keep its own code (for example `E_STALE_RANGE`) plus the atomicity trailer, instead of being relabelled. If an existing test pins `E_BATCH_ABORT` for a non-overlap path, update it to assert the underlying code and the trailer - never weaken or delete the assertion. Record the change in the commit body.

`assertBatchSpansDisjoint` keeps `[MODEL] [E_BATCH_ABORT]`: overlap and nesting are exactly its case.

## 2. Contract breach: served-hash-echo check is not line-relative under `leaseRebased`
`CONTEXT.md` **served hash echo** defines the check as range-relative matching - for `edit`, range-relative line `k` vs `served[startLine + k]` - explicitly "not a generic `^[A-Za-z0-9]{3}|` strip", and ADR-0009 makes it a bounded, fail-loud guard.

`src/hashline/apply.ts` L299-309, in the `leaseRebased` branch, scans the replacement for **any** occurrence of `bound[0]` / `bound[1]` followed by the separator:

```ts
for (let k = 0; k < rawReplacementLines.length && !echo; k++) {
  for (const hash of bound) {
    if (rawReplacementLines[k]!.startsWith(hash + HASH_SEP)) { echo = { k: k + 1, hash }; break; }
  }
}
```

That is a free-floating boundary-anchor match, not line-relative alignment, so a replacement that legitimately repeats a boundary anchor's three characters at a non-corresponding line is rejected.

**Remedy**: make the rebased echo check line-relative - each replacement line `k` is compared against the anchor actually served for the line it replaces (through the resolved/rebased span and the leased identity), matching the canonical range-relative contract.

## Acceptance criteria
- `parseEdits` and `batchAbortFor` propagate the original error code with the atomicity trailer; `E_BATCH_ABORT` appears only on the overlap/nesting path (`assertBatchSpansDisjoint`).
- A test asserts a malformed anchor in a multi-item payload surfaces `E_BAD_ANCHOR` (not `E_BATCH_ABORT`) with the trailer, and that nothing was written.
- A test asserts an item failing during apply surfaces its own code plus the trailer.
- The rebased echo check is line-relative: a regression test proves a replacement that legitimately repeats a boundary anchor's three characters at a non-corresponding line is accepted, while a replacement line carrying the exact `HASH|<anchor>` prefix of the anchor served for the line it replaces is still rejected with `E_SERVED_ECHO`.
- `E_SERVED_ECHO` remains a bounded, fail-loud guard (ADR-0009): the four fail-closed probes keep their byte-identity assertions and all 15 Stage-0 probes stay green.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:17Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
