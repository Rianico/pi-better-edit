# ADR-0044 — Pairing skips a forced unchanged boundary

Date: 2026-10-21

## Status

accepted — an evaluation-order change inside `pairSnapshots`
([spec §5.2](../spec/content-addressed-line-identity-mvcc.md)); the pairing
result, the fail-closed rules and every store invariant are unchanged. Complements
[ADR-0016](0016-content-addressed-line-identity-supersedes-healing.md) (identity
follows content) and [ADR-0043](0043-unchanged-file-adopts-on-stat-identity.md)
(the read path that materializes a changed file).

## Context

When a read materializes content that is not yet in `file_snapshots`, the read
path re-pairs the new content against the latest snapshot so unchanged lines keep
their `line_id`s (`pairAgainstLatest` → `pairSnapshots`). The engine scans the
**whole file**: two canon-count maps, the ∩LIS min-displacement backbone, and a
recursive descent that charges every gap interval.

A one-region change in a large file leaves almost every line identical, and the
engine still pays for all of it. Measured on the fixture (100,000 unique lines,
one line rewritten):

- `pairSnapshots` full scan: **133–145 ms** (6.3× the first materialization's
  identity work on the same fixture);
- a read after the change: **783 ms**, against **~404 ms** for the first
  materialization of the same file — the gap is the pairing scan plus the
  change-specific hashing and lineage write.

The engine's own rules already decide unchanged boundaries cheaply: a canon that
occurs exactly once on each side is a pin, and a run that is positionally
identical is a rigid zip. The scan pays for the generic path anyway.

## Decision

1. **Trim the provably-forced boundary before the engine runs.**
   `pairSnapshots` walks the common prefix and suffix of `prevLines` and
   `currLines` while, at each step, the two canons are equal **and** the canon
   occurs exactly once in the whole previous snapshot and exactly once in the
   whole current snapshot. Those pairs are zipped directly; the engine is called
   only for the remaining middle. `trim?: false` on `PairingOptions` is the
   differential reference (the pre-change full scan), mirroring the existing
   `scanBudget` test seam.

2. **Uniqueness is the safety condition, not merely a heuristic.**
   A canon that is globally unique on both sides must be paired by *every*
   maximum-length alignment: omitting it would allow a strictly longer one.
   Therefore the trimmed pairs lie on every minimal-displacement maximum, and
   the middle's optimum is exactly the whole interval's optimum restricted to
   the middle (prefix pairs add zero displacement; suffix pairs add one constant
   that cannot change an argmin). Ranks shift by a constant, so the
   per-rank-stable pins — and thus every emitted pair, including the rigid-run
   and leaf rules — are identical to the untrimmed engine's.

3. **A duplicated or mismatched boundary falls back to the full scan.**
   The first duplicated canon stops the run; which copy survived is exactly the
   question the engine answers fail-closed, and the shortcut never guesses it.
   No common boundary means no trim and the engine runs exactly as before.

4. **Budget accounting is preserved.** When a trim happens, the top-level
   interval is still charged against `scanBudget` (the scan the full engine would
   have done there) before the middle is aligned and charged like any other
   sub-interval. An injected tiny budget therefore keeps its pre-trim meaning: a
   budget too small for the whole interval pairs nothing. Production callers omit
   the budget.

5. **The result must be provably unchanged, and is pinned by a differential
   corpus.** `test/hashline/patience-pairing.test.ts` asserts
   `pairSnapshots(a, b)` deep-equals `pairSnapshots(a, b, { trim: false })` over a
   seeded randomized corpus that forces shared boundaries, plus the adversarial
   cases the ticket names — duplicates, moved blocks, insertions/deletions at the
   edges, and fully changed files.

## Consequences

Measured with `node scripts/bench-pair-trim.mjs` on the 100k-line fixture
(one line rewritten; medians of five reads, same binary):

| measurement | before (30a71f5) | after |
| --- | ---: | ---: |
| first materialization (reference) | 393.3 ms | 391.9 ms |
| read after the change | 791.1 ms | 689.4 ms |
| pairing, full scan | 157.7 ms | 144.4 ms |
| pairing, trimmed | 132.4 ms (option ignored) | **21.5 ms** |
| pairing speedup | 1.2× (noise) | **6.7×** |
| pairing identical to the full scan | yes | yes |
| unchanged-line anchors that moved | 0 | 0 |

Run-to-run, the trimmed pairing step measured 21.5–25.1 ms (5.3–6.7×) and the read after
the change 672–689 ms (before: 783–791 ms).

- The pairing step is now page-priced in the changed region: the remaining ~23 ms
  is the O(n) uniqueness counting (two canon maps) that decides whether a line may
  be trimmed at all, not the engine.
- The read after a change still pays the changed content's own cost — hashing the
  file and writing its lineage — which is why it stays above the first
  materialization. That cost is not pairing and is out of this ADR's scope.
- No store schema, retention or lease behaviour changes; no caller changes.
  `pairAgainstLatest` and the edit path's preview pairing both inherit the
  shortcut.
- The residual risk is the proof itself: if a future change weakens "globally
  unique ⇒ forced" (e.g. a different backbone rule), the differential corpus
  fails and the trim must be revisited with it.
