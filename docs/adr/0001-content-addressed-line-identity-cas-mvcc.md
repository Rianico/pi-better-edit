# 0001. Content-Addressed Line-Identity CAS MVCC & Dynamic Rebase

Date: 2026-10-30

## Status

Accepted

## Context

Autonomous coding agents struggle with coordinate tracking when editing files. Traditional tools rely on line numbers, which rot immediately after any insertion or deletion, or verbatim search-and-replace strings, which force the model to emit 30–50 lines of unchanged code ($O(S+R)$) and burn scarce context tokens.

Earlier iterations in this repository explored several intermediate mechanisms that failed in practice:
1. **Strict position equality (`strictPos`, [`docs/.archive_adrs/0013-pos-free-roundtrip-optimization.md`](../.archive_adrs/0013-pos-free-roundtrip-optimization.md))** enforced coordinate equality across edits. It caused false rejections on harmless exterior shifts (e.g. formatters) while failing to detect silent corruptions when identical lines shifted into identical line numbers.
2. **Heuristic canon healing ([`docs/.archive_adrs/0008-orphaned-serve-healing.md`](../.archive_adrs/0008-orphaned-serve-healing.md))** scanned for same-canon lines when an anchor went missing. This created a critical P0 defect: when duplicate functions existed (e.g. `f1` and `f2` sharing guard clauses) and an external edit deleted `f1`, the tool eagerly healed `f1`'s deleted anchors onto `f2`'s surviving twins, silently corrupting code.
3. **Monolithic epoch invalidation (OCC)** failed closed on every filesystem change, burning model context on unnecessary full re-reads.

A principled solution was required to decouple line identity from line numbers, guarantee watertight verification, and silently rebase valid edits across exterior shifts without burning tokens.

## Decision

We will identify file lines across versions using (File, Content)-Addressed Line-Identity MVCC backed by an immutable SQLite Content-Addressed Store (CAS).

1. **Immutable Line Identity**: Every distinct line content within a file version is assigned an immutable `line_id`. Versions are materialized into `file_snapshots` and indexed in `line_lineage(snapshot_id, line_number) -> (line_id, canon_hash, anchor)`.
2. **Session-Keyed Leases**: When lines are served to a model session, leases are upserted into `served_leases(session_id, file_path, anchor) -> (line_id, served_snapshot_hash, retired_at)`. An edit resolves its boundary anchors strictly against this table.
3. **Dynamic Rebase via Patience LIS**: When an edit is submitted against a file whose content shifted exteriorly, the engine pairs the served snapshot against the current disk snapshot using scaled Patience Longest Increasing Subsequence (LIS) alignment with a bounded dynamic programming fallback (`pairSnapshots`). Harmless exterior shifts rebase silently with zero tokens burned and zero retries.
4. **Unique-Embedding LCS Leaf Rule**: Leaf interval alignment pairs strictly unique anchors. Ambiguous, duplicate intervals pair nothing, guaranteeing that contested reorders fail closed cleanly without heuristic guessing. Leaf pairing is bounded by `MAX_LEAF_LINES = 2000` and `MAX_LEAF_CELLS = 4_000_000`, with whole-pairing execution gated by a minimum scan floor `MIN_SCAN_BUDGET = 100_000` (`pairingScanBudget = Math.max(100_000, 4 * (prev + curr))`).
5. **Stat-Identity Adoption**: Unchanged files are adopted directly on stat identity (`stat_key`: `ino:size:mtimeMs:ctimeMs`), avoiding redundant line walks and snapshot derivation while verifying `canon_hash` on access.

### Considered Options

- **Strict position equality (`strictPos`)** — rejected: falsely rejects valid exterior shifts (such as formatting or earlier non-overlapping edits) and fails on line duplication.
- **Heuristic canon healing (`tryHealOrphanedSpan`)** — rejected: fatally relocates deleted anchors to surviving duplicate twins elsewhere in the file, enabling silent miswrites.
- **Monolithic epoch invalidation (OCC)** — rejected on the context-preservation boundary: burns 500–2,000 tokens on avoidable retry turns when shifts are exterior and harmless.
- **Rigid context window ($k=2$, M2)** — rejected: fails on low-entropy boilerplate (`}`, `{`, blanks) and causes false rejections at partial-read window edges.

## Consequences

- Replaces coordinate-based editing with immutable line identity.
- Enables $O(R)$ edit payloads: the model emits only two boundary anchors and replacement text, never existing code.
- Eliminates retry turns for harmless external edits (e.g., Prettier, Black, git branch switches).
- Contested interior edits fail closed cleanly without file corruption.
- Requires local SQLite database storage for snapshot and lineage persistence. Deep technical specification and proof matrices are documented in `docs/spec/content-addressed-line-identity-mvcc.md`.
