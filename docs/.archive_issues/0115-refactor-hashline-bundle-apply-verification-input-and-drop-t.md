# refactor(hashline): bundle apply verification input and drop the dead epoch seam

> **Archived from pre-migration issue #115.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-15T02:38:42Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78. Review 5, three baseline smells in `src/hashline/apply.ts`.

## 1. `applyEdit` takes 11 positional parameters

`src/hashline/apply.ts:220-238`:

```
applyEdit(content, edit, signal?, precomputedHashes?, filePath?, served?, tombstone?, servedCanons?, epochSnapshotId?, curSnapshotId?, identity?)
```

The trailing cluster (`filePath`, `served`, `tombstone`, `servedCanons`, `identity`) travels together from `ApplyOneEditInput`, and positional booleans/arrays at this arity are exactly the shape that invites a silent argument-order bug.

**Remedy**: bundle the verification cluster into one cohesive descriptor (for example `ApplyVerificationContext`) and pass that; keep the arity small. Pure refactor — behaviour identical.

## 2. Dead epoch parameters (and a dead branch)

Spec/ADR-0017 retired epoch concurrency: *"`strictPos` never fired in production (`epochSnapshotId` stayed unpopulated)"*, *"the edit pipeline never populates an epoch, so `strictPos` no longer gates anything"*.

Verified dead:
- `applyEdit` params at `apply.ts:228-229`, passed through at `:332-333`
- `served-verification.ts` args `:316-317`, `:772-773`, `:789`, and the pass-through at `:377-378`
- the derived `strictPos` at `served-verification.ts:445-448` and the `throwStale` branch it gates (`:450-460`)
- `pipeline.ts:182-183`, `:198-199`, `:205` (`epochSnapshotId = undefined`), `:208`, `:220-221`
- **zero** references in `test/` (verified: `rg 'epochSnapshotId|curSnapshotId' test/` is empty), so nothing covers the branch

**Remedy**: remove `epochSnapshotId` / `curSnapshotId` end to end, including the unreachable `strictPos` branch. Acceptance requires `rg -n 'epochSnapshotId|curSnapshotId' src/ test/` to be empty. If removal exposes a live caller that did pass real values, **stop and report BLOCKED with evidence** — do not keep a half-removed seam.

## 3. Duplicated cascading fallback scan

`src/hashline/apply.ts:290-312` performs five `findEditHashEcho` calls as an early-exit cascade over 3 candidate arrays (`rawReplacementLines`, `resolved.content_lines`, `prefixFixed.content_lines`) × 2 anchor targets (`served`, `fileHashes`).

**Remedy**: extract one helper that walks candidates × targets with early exit, so the policy reads once instead of five times.

**Critical**: #105's fix made this check **line-relative**; the helper must preserve it exactly — for each candidate, range-relative matching against the anchor served for the line it replaces, plus the rebased second target. Never a free-floating scan for either boundary anchor (that rejects legitimate content repeating an anchor's three characters).

## Acceptance criteria

- `applyEdit` arity reduced and its verification inputs carried by one descriptor; no `epochSnapshotId`/`curSnapshotId` anywhere.
- One implementation of the candidate × target echo scan.
- `E_SERVED_ECHO` behaviour unchanged: the #105 regression tests still hold — a replacement legitimately repeating a boundary anchor's three characters at a non-corresponding line is **accepted**, while a replacement line carrying the exact `HASH│` anchor served for the line it replaces is still **rejected**.
- All 15 Stage-0 probes stay green; the four fail-closed probes (A, E, J, K) keep both the rejection code and byte-identical file content. No assertion weakened or deleted.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:51Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
