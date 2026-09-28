# fix(pairing): embedding-level LCS uniqueness with a brute-force oracle

> **Archived from pre-migration issue #104.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T16:13:46Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## Spec
Section 3.4.4 / lines 298-299: "A pairing `(p, c)` is optimal-path unique iff it lies on **every** maximal traceback path. If multiple traceback paths exist (ambiguous duplicate lines), lines in that interval are marked **UNPAIRED / RETIRED**."

## Finding (verified by the operator, with a counterexample)
`src/hashline/patience-pairing.ts` `computeLCSPaths` decides uniqueness with the `ways` DP, which counts distinct optimal LCS **strings** (its inclusion-exclusion subtracts the diagonal cell when both down and right are optimal), then reconstructs **one embedding** with a traceback that prefers the diagonal transition:

```ts
if (diagonal === target) { i++; j++; continue; }
```

The spec requires embedding/path-level uniqueness - the pairing must lie on every maximal traceback path. String-uniqueness is strictly weaker, so an ambiguous interval can be declared unique and paired anyway.

**Counterexample** (operator-verified, becomes a regression test):

```
prev = [A, B]     curr = [B, B]
ways[0] === 1  ->  isUnique true  ->  pairs {2 <-> 2}
```

`{2 <-> 1}` is equally optimal and equally canon-equal: whether `prev[2]` survived as `curr[1]` or `curr[2]` is underdetermined. Committing to `{2 <-> 2}` is coordinate guessing, which the mandate forbids.

## Remedy
Make uniqueness embedding-level: a pairing is emitted only when it lies on **every** maximal traceback path; when more than one maximal path exists, that interval pairs nothing (its lines stay UNPAIRED / RETIRED and fail closed). Reconcile the `ways` recurrence with the traceback so the uniqueness decision and the reconstruction agree.

**Operator decision (review 3, Q3, option (i))**: implement true embedding-level uniqueness, backed by a brute-force oracle test. The narrower "delete the mismatch-diagonal step" fix is rejected because it does not fix the counterexample above.

## Required evidence
- **Exhaustive oracle test**: a brute-force reference that enumerates maximal traceback paths (or computes their intersection directly) for all small input pairs - every sequence pair up to length ~6 over a 2-3 symbol alphabet - asserting `computeLCSPaths` returns exactly the intersection when one path exists and nothing when several do.
- **Regression case**: `[A, B] -> [B, B]` pairs nothing.
- Keep intact: the dynamic budget guard `MAX(100000, 4*(prev+curr))`, rigid block shift (Phase 2, Probe N), patience LIS pin backbone partitioning, and the strict monotonicity assertion.

## Acceptance criteria
- Uniqueness is path/embedding-level, and the oracle test passes over the exhaustive small-input space.
- `[A, B] -> [B, B]` is retired (no pairing), plus the oracle's own ambiguity cases.
- Probes H, I, K, L, M and N (Probe N via rigid block shift), the pairing unit battery, and all 15 Stage-0 probes stay green. If stricter uniqueness retires a line a probe expects to auto-rebase (C, D, L), investigate whether the LIS pin backbone should have partitioned that interval first - do NOT weaken the probe.
- No pairing is emitted for a line whose `canon` differs from its partner's.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:13Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
