# Spec: Line Identity across File Versions via Content-Addressed Line-Identity MVCC (Revision 24)

> [!info] Revision 25 patch proposed — the retired-identity reject-and-serve payload can silently miswrite the line that took the target's old number. Normative deltas D1–D5 are in [§9](#9-appendix--revision-25-patch-stale-identity-rejection); full analysis in [`stale-identity-reject-and-serve.md`](stale-identity-reject-and-serve.md) and [`mvcc-session-failure-handoff.md`](mvcc-session-failure-handoff.md).

Status: ready-for-agent
Revision: 24 — Production-Grade Line-Identity CAS MVCC with Pre-Allocation Snapshot Cache Verification, Universal Counter-Routed Commits, Explicit S_latest Predecessor Pairing & Watertight ID Invariants, reconciled with the delivered implementation (embedding-level optimal-pairing uniqueness, batch-overlap and item-error attribution, and the delivered module layout). Revision 24 clarifies the delivered seams without changing behavior: leased-anchor resolution lives in `lease-resolve.ts`, the preceding-delta closed form is normative semantics materialized by the working buffer, and pinned snapshots are never evicted (soft overflow is reported, never resolved by eviction).
Core Architectural Mandate: **Model context headroom is the single most precious resource. Tool runtime compute, diffing, and storage are effectively free.** The tool absorbs all complexity required to silently auto-rebase valid edits across external file shifts and internal batch edits (0 tokens burned, 0 retries), reserving fail-closed intercepts strictly for true semantic conflicts (interior span tearing, contested non-monotone reorders, duplicate ambiguity, and retired anchors).

Supersedes: ADR-0008 (heuristic canon healing / `tryHealOrphanedSpan`), ADR-0013 (epoch `strictPos`), Revision 20, and all prior spec drafts. This document is the sole authoritative specification.

Fixes: Upstream P0 (§2), Downstream #61 (silent miswrite on duplicate canons), Downstream #62 (anchor reshuffle). Anchor space exhaustion (`E_LARGE_FILE`) is decoupled and tracked in its own dedicated issue (§8).

---

## 1. Adopted Design vs. Rejected Designs

| Design Candidate | Core Mechanism | Reason for Rejection / Adoption | Verdict |
| :--- | :--- | :--- | :--- |
| **Strict Position Equality (`strictPos`)** | Enforces `from === startLine - 1` across edits | Probe `E`: position is identical (`1 === 1`), so check passes and corrupts code. Probe `C`: falsely rejects valid exterior shifts. Dead code today. | **REJECTED** |
| **Rigid Context Window ($k=2$, M2)** | Validates $\pm k$ neighbor anchors | Fails on low-entropy boilerplate (`}`, `{`, blanks); causes false rejections at partial-read window edges. | **REJECTED** |
| **Heuristic Canon Healing (ADR-0008)** | Relocates orphaned anchors by scanning for same-canon lines | **Fatal flaw**: Eagerly relocates deleted anchors to surviving duplicate twins, enabling the P0 silent miswrite. | **REJECTED & SUPERSEDED** |
| **Monolithic Epoch Invalidation (Path 1 / OCC)** | Coarse file-level lease; fail-closed on any external change | Sacrifices model context: burns 500–2,000 tokens on avoidable retry turns when external changes are harmlessly exterior (formatters, linters). | **REJECTED** |
| **Production Line-Identity MVCC (Rev 17)** | Normalized CAS snapshots + Immutable Leases with Re-Serve Upsert + Patience LIS Pin Backbones + Working Buffer | Decouples line identity from coordinates. Leases bind immutably to `line_id` during edits, re-serve safely updates leases, LIS pins isolate reorders, and preceding batch deltas eliminate coordinate drift. | **ADOPTED** |

---

## 2. Verified Problem (Reproduction on `main`)

Environment: `pi-better-edit` 1.7.0 @ `9c2538d`, tool-level harness (`test/support/fixtures.ts` `setupIntegrationTest`), external writer simulated via raw filesystem write (`fs.writeFile`).

Fixture (`small.cpp`, 13 lines) consists of two byte-identical function groups:

```text
int f1(int x) {          int f2(int x) {
\tif (x > 0) {            \tif (x > 0) {
\t\treturn x;             \t\treturn x;
\t}                       \t}
\treturn -x;              \treturn -x;
}                        }
```

### 2.1 P0 — Silent Miswrite to a Different Line Sharing Canon (Probe `E`)

1. Model executes full `read` of `small.cpp`:
   - Line 2 (`f1` guard): served anchor `psM│\tif (x > 0) {`
   - Line 9 (`f2` guard): served anchor `AKU│\tif (x > 0) {`
2. External writer modifies disk, deleting lines 1–7 (`f1` group).
   - On-disk content now contains only `f2`.
   - Content hash changes $\implies$ cache miss in `snapshotIO.get` $\implies$ falls back to `lineHashesPure` (`hash-identity.ts:407`), where the first occurrence of `\tif (x > 0) {` in the new file (`f2`'s guard) receives the base hash `psM`.
3. Model issues `edit` targeting `psM` (the anchor it saw for `f1`'s guard):
   - **Current Bug**: Tool accepts the edit, reports success, and mutates line 2 of the new file (`f2`'s guard!).
   - **Result**: Silent corruption of code in an unread function.

Probe `A` reproduces the exact same miswrite under a partial read (`offset=1, limit=6`). Partial reads are not a precondition.

### 2.2 Guardrail Matrix — The Twelve Canonical Probes (Empirically Verified on `main`)

| Probe | Sequence | Verified `main` Behavior | Revision 16 Required Behavior | Context Impact |
| :--- | :--- | :--- | :--- | :--- |
| **`B`** | Read full $\to$ external delete `f1` $\to$ edit with `AKU` (`f2`'s surviving anchor) | Throws `[E_STALE_ANCHOR]` (anchor collision on `main`) | **Auto-rebases** silently to line 2; applies edit | **0 tokens burned, 0 retries** |
| **`C`** | Read full $\to$ external insert 7 lines at top $\to$ edit with `AKU` | Auto-rebases to shifted line 16 | **Auto-rebases** silently to line 16; applies edit | **0 tokens burned, 0 retries** |
| **`D`** | Read full $\to$ external edit inside `f1` $\to$ edit with `AKU` | Auto-rebases to line 9 | **Auto-rebases** silently to line 9; applies edit | **0 tokens burned, 0 retries** |
| **`H`** | `aaa│ a`, `bbb│ b`, `ccc│ a` $\to$ insert `ddd│ d` before `ccc` $\to$ edit `ccc` with `ccc│ mod` | Throws `[E_STALE_ANCHOR]` (anchor `sLb` collision) | **Auto-rebases** to line 4; line 1 remains `a`, line 4 becomes `mod` | **0 tokens burned, 0 retries** |
| **`I`** | Read full $\to$ tool edit 1 inserts 5 lines at line 50 $\to$ tool edit 2 replaces line 10 | Auto-rebases cleanly ($\Delta = 0$ for line 10) | **Auto-rebases** via preceding working-buffer delta ($\Delta = 0$ for line 10) | **0 tokens burned, 0 retries** |
| **`L`** | Read 30k-line file $\to$ external insert 5 lines at line 0 $\to$ edit line 25,000 | Auto-rebases cleanly to line 25,005 | **Auto-rebases** silently to line 25,005 via scaled budget | **0 tokens burned, 0 retries** |
| **`M`** | External insert 7 lines at line 0 $\to$ batch: edit 1 at line 10 (+5 lines), edit 2 at line 15 | Auto-rebases cleanly to 17 & 27 | **Auto-rebases** edit 1 to 17, edit 2 to $15 + 7 + 5 = 27$ | **0 tokens burned, 0 retries** |
| **`N`** | 3,000 identical lines bounded by unique header/footer $\to$ exterior insert 5 lines at line 0 $\to$ edit line 1,500 | Auto-rebases cleanly via sequential hash assignment | **Auto-rebases** silently to line 1,505 via rigid block shift | **0 tokens burned, 0 retries** |
| **`E`** | Read full $\to$ external delete `f1` $\to$ edit with deleted line's anchor `psM` | **Miswrites** line 2 | **Intercepts** fail-closed (`[E_STALE_RANGE]`), file bytes unchanged | Cures P0 silent corruption |
| **`A`** | Partial read $\to$ external delete `f1` $\to$ edit with `psM` | **Miswrites** line 2 | **Intercepts** fail-closed (`[E_STALE_RANGE]`), file bytes unchanged | Cures P0 partial variant |
| **`J`** | Read lines 10–20 $\to$ external insert between line 12 and 13 $\to$ edit lines 10–20 | Rejects fail-closed (`[E_STALE_RANGE]`) | **Intercepts** fail-closed (`[E_STALE_RANGE]`), file bytes unchanged | Prevents clobbering external edits |
| **`K`** | Read full $\to$ external swap of two equal-length unique functions $\to$ edit either function | Auto-rebases moved function via ADR-0008 healing (`tryHealOrphanedSpan`) | **Intercepts** fail-closed (`[E_STALE_RANGE]`), file bytes unchanged | Prevents applying to reordered code |

---

## 3. First-Principles Architectural Solutions

#### 3.1 Immutable Lease `line_id` & Dynamic Rebase Resolution (Fixing B1 & B3 Review Gaps)

- **The Invariant**: A lease binds `(session_id, file_path, anchor) -> line_id` immutably for the duration of an edit.
- **Seam Separation: Edit vs. Serve Operations**:
  1. **Edit Operation (`resolve.ts` / `pipeline.ts`)**:
      - Strictly **READ-ONLY** on `served_leases`. Zero lease re-stamping.
      - To resolve an anchor:
        1. Retrieve `lease.line_id` from `served_leases` verifying `retired_at IS NULL`:

           ```sql
           SELECT line_id FROM served_leases
           WHERE session_id = :session_id AND file_path = :file_path AND anchor = :anchor AND retired_at IS NULL;
           ```

           If anchor is missing $\implies$ throw `[E_STALE_ANCHOR]`. If `retired_at` is set, the leased identity is gone and the **boundary rule** (`src/hashline/lease-resolve.ts:198-231`) owns the payload: exactly one bound stale with the survivor live and unshifted (its rebased coordinate equals its served coordinate — evidence that no shift occurred) $\implies$ throw `[E_UNVERIFIED_RANGE]` — the named window (served coordinates clamped to the file) served as a fresh read under the exact heading `Current range (fresh read):` with no retry hint, the rows leased through the normal serve seam; both bounds stale, a shifted survivor, or a clamped window that collapses or misses the file $\implies$ throw `[E_TARGET_LOST]` with no rows and no heading. The named coordinate is always lease-derived (`lease.servedLineNumber`); content placement never names it.

        2. Query `line_lineage` of current snapshot $S_{curr}$:

           ```sql
           SELECT line_number FROM line_lineage 
           WHERE snapshot_id = :curr_snapshot_id AND line_id = :lease_line_id;
           ```

        3. If found at line $p'$: the line survived and shifted to $p'$.
        4. If NOT found: the line was deleted or retired. The edit enters the same **boundary rule** as a retired lease: `[E_UNVERIFIED_RANGE]` (fresh read to decide from) for a live unshifted survivor, otherwise `[E_TARGET_LOST]` with no rows (`src/hashline/lease-resolve.ts:198-231`).
      - An in-flight edit cannot alter or adopt a fresh `line_id`, eliminating P0 silent miswrites from first principles.
  2. **Serve Operation (`read.ts`, `recordDiff`, `recordEcho`, `recordTruncated`, `undo_last_edit`)**:
      - Serving an anchor presents an authoritative *new contract* to the model for that session and path.
      - When an anchor is re-served (e.g. after external change where presentation assigns an anchor to a new line), the tool executes an atomic upsert that replaces the prior lease:

        ```sql
        INSERT INTO served_leases (
            session_id, file_path, anchor, line_id, canon_hash,
            served_snapshot_hash, served_line_number, updated_at, retired_at
        ) VALUES (
            :session_id, :file_path, :anchor, :line_id, :canon_hash,
            :served_snapshot_hash, :served_line_number, :updated_at, NULL
        )
        ON CONFLICT (session_id, file_path, anchor) DO UPDATE SET
            line_id = excluded.line_id,
            canon_hash = excluded.canon_hash,
            served_snapshot_hash = excluded.served_snapshot_hash,
            served_line_number = excluded.served_line_number,
            updated_at = excluded.updated_at,
            retired_at = NULL;
        ```

      - This breaks the fail-closed retry loop (where an un-replaced lease would keep pointing to a dead `line_id`) while preserving edit-time immutability.
      - **Snapshot Adoption on `undo_last_edit`**: When `undo_last_edit` reverts a file, its restored content by definition matches a prior committed snapshot pinned in CAS by `file_undo.snapshot_hash`. The restore transaction executes `SELECT snapshot_id FROM file_snapshots WHERE path = :path AND snapshot_hash = :hash AND committed = 1` inside `BEGIN IMMEDIATE` to adopt the canonical `snapshot_id` and `line_lineage` directly (zero new counter allocations). It executes the authoritative retirement update (§3.1.3.3) on lines removed by the revert, and re-serves the restored lines into `served_leases` with `retired_at = NULL` and `served_snapshot_hash = :hash`, fulfilling §7.2.9 without requiring an intermediate `read`.
  3. **Materialization Protocol & Authoritative Writer for `retired_at` (`read.ts` / `pipeline.ts`)**:
      - Materialization executes inside a SQLite transaction with `BEGIN IMMEDIATE` (wrapped with `withBusyRetry`):
        1. Compute content checksum $C = \text{CANON\_VERSION:xxh64}(\text{content})$.
        2. Query `file_snapshots` for existing `(path, C)`:
           - **Cache Hit**: Read back canonical `snapshot_id` and `line_lineage`; zero new allocations.
           - **Cache Miss**:
             - **First-Ever Read Branch**: Even if `file_snapshots` has no prior row for `path`, `line_id_counters` may already exist if a surviving lease was held for an evicted snapshot. The engine atomically allocates $N$ consecutive IDs starting from the persisted counter:

               ```sql
               INSERT INTO line_id_counters (path, next_id)
               VALUES (:path, :N + 1)
               ON CONFLICT(path) DO UPDATE SET
                   next_id = line_id_counters.next_id + :N
               RETURNING (next_id - :N) AS start_id;
               ```

               The allocated IDs are $[start\_id \dots start\_id + N - 1]$. `next_id` is strictly monotonic and **never rewinds**, guaranteeing that surviving leases can never have their `line_id`s recycled or collided. It inserts `file_snapshots(committed = 1)` and `line_lineage(start_id .. start_id + N - 1)`.
             - **Subsequent Materialization Branch**: If a prior committed snapshot exists for `path`, the engine selects the most recently created snapshot for the path (`S_latest`, defined by `ORDER BY created_at DESC, snapshot_id DESC LIMIT 1` as in §3.6.2). It runs `pairSnapshots(S_latest_lines, currLines)`. Paired lines inherit their `line_id` from $S_{latest}$. Unpaired new lines allocate fresh sequential `line_id`s from `line_id_counters(path)` via the atomic upsert (`next_id = next_id + unpaired_count`). Insert `file_snapshots(committed = 1)` and `line_lineage`.
             - **Authoritative Writer for `retired_at`**: Materialization is the single authoritative source of truth for line survival. Immediately after writing `line_lineage`, it sets `retired_at = :now` on any active lease on `file_path` whose leased `line_id` is absent from the newly materialized snapshot:

               ```sql
               UPDATE served_leases
               SET retired_at = :now
               WHERE file_path = :file_path
                 AND retired_at IS NULL
                 AND line_id NOT IN (
                     SELECT line_id FROM line_lineage WHERE snapshot_id = :curr_snapshot_id
                 );
               ```

               This leaves `line_id` completely immutable, preserves the read-only contract of the edit path's resolution logic, and provides the exact timestamp needed for the 1-hour vacuum unpinning rule.
        3. **Concurrency / Conflict Resolution**:
           `INSERT INTO file_snapshots (path, snapshot_hash, ...) VALUES (...) ON CONFLICT (path, snapshot_hash) DO NOTHING;`
           If a concurrent session committed `(path, C)` concurrently, roll back local allocations and read back the canonical `snapshot_id` and `line_lineage`.
        4. **Authoritative Anchor Persistence**:
           `materializeSnapshot(db, path, content, hashes)` receives the authoritative presentation anchor array `hashes` computed/presented for this snapshot. It persists each anchor string **verbatim** into `line_lineage.anchor` ($1 \dots N$). The engine **never** recomputes anchors using an independent hash assignment function (such as `lineHashesPure`) during materialization. This guarantees that `getSnapshot` returns the exact anchors presented to the model, eliminating Downstream #62 anchor reshuffling on identical content.
        5. **Authoritative Lease Upsert**:
           Served lines are upserted into `served_leases` with `retired_at = NULL`.
        6. `COMMIT`.
  4. **`HashSnapshotIO` Contract Replacement (`src/snapshot-store.ts`)**:
      - `HashSnapshotIO` (`snapshotIOFor`, consumed by `hash-identity.ts:hashesFor` and `pipeline.ts`) is retained as the internal snapshot access seam, but its backing implementation in `src/snapshot-store.ts` is replaced by normalized `file_snapshots` and `line_lineage` (dropping legacy serialized JSON blobs):
        - `getSnapshot(store, path, content)`: Computes `snapshot_hash = cacheKey(contentChecksum(content))`. Queries `SELECT snapshot_id FROM file_snapshots WHERE path = :path AND snapshot_hash = :snapshot_hash AND committed = 1`. If found, queries `SELECT anchor FROM line_lineage WHERE snapshot_id = :snapshot_id ORDER BY line_number ASC` and returns `string[]`. Returns `undefined` on cache miss.
        - `upsertSnapshot(store, path, checksum, lineCount, hashes)`: Passes `hashes` to `materializeSnapshot` to persist normalized CAS snapshot and verbatim lineage anchors.
        - This preserves stable presentation anchors across re-reads on unchanged files without JSON serialization or separate cache tables.

### 3.2 In-Memory Working Buffer Preceding Deltas (Fixing B2)

For multi-edit batches (`edits: [e_0, e_1, \dots, e_N]`):

1. **Rebased Baseline Coordinates**:
   Each edit $e_k$ first resolves its rebased baseline coordinate $s'_k$ in $S_{curr}$ via its immutable lease `line_id`.
2. **Preceding Delta Formulation**:
   The active working buffer position is computed by shifting $s'_k$ by **only preceding edits**:
   $$\Delta_k = \sum_{\substack{j < k \\ s'_{end, j} < s'_{start, k}}} \left( |R_j| - (s'_{end, j} - s'_{start, j} + 1) \right)$$
   $$p_{buffer} = s' + \Delta_k$$
   Edits that do not strictly precede the target span do not contribute to its coordinate shift (Probe `I`, Probe `M`).
   The closed form above is the normative *semantics* of the shift: an implementation may materialize the equivalent shift by sequentially rebasing the working buffer over the preceding items (`src/mutation-engine/pipeline.ts:728-733`, `:851-857`) — the coordinate reached must be identical, and Probes `I` and `M` are the conformance evidence.
3. **Overlapping Batch Rejection**:
   If any two items in an `edits[]` array overlap or nest ($s'_{start, a} \le s'_{end, b} \land s'_{start, b} \le s'_{end, a}$), the entire batch is rejected with `[MODEL] [E_BATCH_ABORT]`.
4. **WAL Lineage Persistence, Pre-Allocation Cache Verification & Counter Integration**:
   `served_leases` is NOT mutated mid-batch. Upon batch completion, the in-memory working buffer commits to disk, and $S_{final}$'s persistence executes inside a SQLite transaction with `BEGIN IMMEDIATE` (wrapped with `withBusyRetry`):
   - **Step 1: Compute Final Content Checksum**:
     Compute $C_{final} = \text{CANON\_VERSION:xxh64}(\text{final\_content})$.
   - **Step 2: Check Existing Snapshot Cache Guard (Zero Allocation on Reversion)**:
     Query `file_snapshots` for an existing committed snapshot matching `(path, C_{final})`:

     ```sql
     SELECT snapshot_id FROM file_snapshots
     WHERE path = :path AND snapshot_hash = :snapshot_hash AND committed = 1;
     ```

     - **Cache Hit (Reversion / Cyclical Edit / Undo Revert)**:
       If the edit reverted the file to a prior state still within CAS retention (e.g., editing `bar` $\to$ `foo` where `foo` was previously committed, or `undo_last_edit` restoring prior content):
       1. Adopt the existing canonical `snapshot_id` and its `line_lineage` rows directly from the store.
       2. Discard in-memory provisional allocations (zero counter allocations from `line_id_counters`, preventing counter lag or surrogate key waste).
       3. Run the authoritative retirement update on `served_leases` (§3.1.3.3) for lines absent from the canonical snapshot:

          ```sql
          UPDATE served_leases
          SET retired_at = :now
          WHERE file_path = :file_path
            AND retired_at IS NULL
            AND line_id NOT IN (
                SELECT line_id FROM line_lineage WHERE snapshot_id = :canonical_snapshot_id
            );
          ```

       4. Upsert newly served diff lines into `served_leases` with `retired_at = NULL` and `served_snapshot_hash = :snapshot_hash` pointing to the canonical `line_id`s.
       5. Complete transaction without inserting into `file_snapshots`, eliminating `UNIQUE (path, snapshot_hash)` constraint violations and avoiding deferred-sync warnings.
     - **Cache Miss (Novel Content)**:
       1. **Survivor Line ID Preservation**: Surviving unmodified lines preserve their exact `line_id`s from the working buffer map (0% diffing, 100% exact).
       2. **Inserted Line ID Allocation via Universal Counter**: For all lines inserted or replaced by the batch ($N_{inserted}$ total new lines), allocate fresh `line_id`s strictly through the universal `line_id_counters(path)` atomic upsert:

          ```sql
          INSERT INTO line_id_counters (path, next_id)
          VALUES (:path, :N_inserted + 1)
          ON CONFLICT(path) DO UPDATE SET
              next_id = line_id_counters.next_id + :N_inserted
          RETURNING (next_id - :N_inserted) AS start_id;
          ```

          The newly inserted lines receive $[start\_id \dots start\_id + N_{inserted} - 1]$. The counter is the sole, universal allocator across all write paths, preventing counter lag or duplicate ID issuance.
       3. **Commit Snapshot & Lineage**:
          Insert `file_snapshots (path, snapshot_hash, line_count, created_at, committed = 1)`. On concurrent conflict (`ON CONFLICT (path, snapshot_hash) DO NOTHING`), roll back local allocations and adopt the canonical `snapshot_id` and `line_lineage`.
          Insert `line_lineage` rows mapping each line coordinate ($1 \dots N$) to its `(line_id, canon_hash, anchor)`.
       4. **Authoritative Retirement Update**: The commit transaction executes the authoritative retirement update (§3.1.3.3) on `served_leases` for any active leases on `file_path` whose leased `line_id`s were deleted by the batch:

          ```sql
          UPDATE served_leases
          SET retired_at = :now
          WHERE file_path = :file_path
            AND retired_at IS NULL
            AND line_id NOT IN (
                SELECT line_id FROM line_lineage WHERE snapshot_id = :final_snapshot_id
            );
          ```

          This ensures that lines deleted by an edit are immediately marked retired, unpinning their snapshots after 1 hour in vacuum and maintaining identical line survival invariants across both edit commits and read-path materializations.
       5. **Authoritative Lease Upsert**: Upsert newly served diff lines into `served_leases` with `retired_at = NULL` and `served_snapshot_hash = :snapshot_hash`.

### 3.3 Retirement of ADR-0008 & Disposal of ADR-0013 (Fixing B3)

1. **Retirement of ADR-0008 (Canon Healing)**:
   In `src/hashline/served-verification.ts:239`, `tryHealOrphanedSpan` and the strategies in `src/hashline/healing/*` eagerly relocated unresolvable anchors by scanning for matching canons. In lease-based MVCC, this is completely retired: an unleased or orphaned line is retired fail-closed, never heuristically relocated. ADR-0008 is formally superseded.
2. **Disposal of ADR-0013 (Epoch Concurrency)**:
   ADR-0013's dead `strictPos` and unpopulated `epochSnapshotId` are formally superseded by Content-Addressed Line-Identity MVCC.
3. **Root-Cause Citation**:
   In Probe `E`, the external deletion of `f1` causes a cache miss in `snapshotIO.get`, falling through to `lineHashesPure` (`hash-identity.ts:407`), where the first occurrence of `\tif (x > 0) {` in the new file (`f2`'s guard) receives the base hash `psM`.

### 3.4 Decisive Pairing Engine & Patience LIS Pin Backbone (Fixing B4, B6 & Rev 14 Gaps)

1. **`findUniquePins`**:
   Counts occurrences of `canon_hash` in `prev[pStart..pEnd]` and `curr[cStart..cEnd]`. A line is a candidate Anchor Pin iff its `canon_hash` appears **exactly once** in both intervals.
2. **Inversion / Crossing Definition**:
   Two candidate pins $(p_i, c_i)$ and $(p_j, c_j)$ form a **crossing / inversion** iff:
   $$(p_i < p_j \land c_i \ge c_j) \quad \lor \quad (p_i > p_j \land c_i \le c_j)$$
3. **Patience LIS Pin Backbone with Displacement Tie-Breaking**:
   - Given candidate pins $(p_1, c_1), \dots, (p_m, c_m)$ sorted by $p_1 < \dots < p_m$, a non-crossing backbone is a strictly increasing subsequence in $cLine$ ($c_{i_1} < c_{i_2} < \dots$).
   - The engine computes the Longest Increasing Subsequence (LIS) on candidate pins in $O(m \log m)$ time via patience sorting.
   - **Tie-Breaking via Minimal Displacement**: If multiple maximal increasing subsequences exist, they are ranked by minimum total coordinate displacement ($\sum |p_i - c_i|$). Lines that did not move at all ($p_i = c_i$) or shifted uniformly have minimal displacement.
   - **Unconditional Intersection across Minimal-Displacement LIS Candidates**:
     When multiple maximal-length increasing subsequences tie for minimum total displacement ($\mathcal{LIS}_{\min \Delta}$), the stable backbone is defined as their **unconditional intersection**:
     $$\text{stablePins} = \bigcap_{S \in \mathcal{LIS}_{\min \Delta}} S$$
     - In `prev = [H, A, B, T]` $\to$ `curr = [H, B, A, T]` (with unmoved unique anchors `H` and `T`):
       The two maximal subsequences with minimal displacement ($\Delta = 1$) are $\{H, A, T\}$ and $\{H, B, T\}$ (a non-disjoint tie).
       Their intersection is $\{H, T\}$. `H` and `T` are unanimously stable and partition the file.
       The gap between `H` and `T` contains `[A, B]` $\to$ `[B, A]`, where candidate LISs are $\{A\}$ and $\{B\}$ with intersection $\emptyset$.
       Falling through to leaf LCS, non-unique traceback paths mark both `A` and `B` as `UNPAIRED / RETIRED`.
       Editing either `A` or `B` fails closed under the §3.1.1 boundary rule (both bounds stale, so `[E_TARGET_LOST]` with no rows), while editing `H` or `T` auto-rebases cleanly.
     - In a bare symmetric swap `prev = [A, B]` $\to$ `curr = [B, A]`:
       $\mathcal{LIS}_{\min \Delta} = \{\{A\}, \{B\}\}$. The intersection is $\emptyset$.
       `stablePins` is empty $\implies$ falls through to leaf LCS $\implies$ both `A` and `B` are retired fail-closed.
   - **Topological Boundary Partitioning & Progress Guarantee**:
     - When `stablePins.length > 0`, each stable pin acts as an authoritative topological boundary. Sub-intervals strictly between adjacent stable pins are recursively aligned via `alignRecursive(pCur, pin.pLine - 1, cCur, pin.cLine - 1)` and `alignRecursive(pCur, pEnd, cCur, cEnd)`. Because each sub-interval is strictly smaller than the parent interval ($pin.pLine - 1 - pCur + 1 < pEnd - pStart + 1$), progress is guaranteed.
     - When `stablePins.length === 0`: The interval contains only contested/crossing candidate pins (or zero pins). The engine **never recurses on identical bounds** (eliminating the self-recursion / budget starvation defect). Instead, it falls through directly to leaf handling (Phase 2 rigid block shift $\to$ Phase 3 leaf budget guard $\to$ Phase 4 bounded LCS optimal-path uniqueness). If no unique pairing exists, lines in that contested interval remain UNPAIRED / RETIRED.
   - **Equal-Length Contested Swaps (Probe `K`) vs. Unequal Reordering**:
     - **Equal-Length Contested Swaps (Probe `K`)**: In a symmetric swap of equal-sized blocks (e.g. `alpha` of 3 lines and `beta` of 3 lines), neither block dominates in length or displacement $\implies$ $\bigcap \mathcal{LIS} = \emptyset \implies$ both blocks are retired fail-closed (an edit inside either rejects `[E_TARGET_LOST]` — both bounds stale, no rows), preserving code bytes on disk. Probe `K` specifically scopes this symmetric contested reorder.
     - **Unequal-Length Reordering**: When two blocks of unequal length swap without intervening stable pins (e.g. `alpha` of 3 lines and `beta` of 7 lines), standard patience alignment naturally identifies the longer monotonic block (`beta`, length 7) as the dominant LIS backbone. `beta` auto-rebases to its new coordinates, while the displaced minority block (`alpha`, length 3) falls outside the LIS backbone and is retired fail-closed (an edit inside it rejects `[E_TARGET_LOST]` — both bounds stale, no rows).
     - **Preservation of Untouched Spans**: In `prev = [A, M1..M100, B]` $\to$ `curr = [B, M1..M100, A]`, $M_1 \dots M_{100}$ forms the unique LIS of length 100 with displacement 0, dominating the swapped endpoints ($100 > 1$). All 100 middle lines are selected as stable backbone pins and preserved! Only the swapped endpoints (`A` and `B`) are retired.
   - **Polynomial Two-Pass DP Implementation of $\bigcap \mathcal{LIS}_{\min \Delta}$**:
     Enumerating all subsequences would risk combinatorial explosion. Instead, the intersection is computed deterministically in $O(m \log m)$ time:
     1. **Forward Pass**: Compute for each candidate pin $i \in [1..m]$:
        - $L[i]$: length of the longest increasing subsequence in $cLine$ ending at pin $i$ (via patience binary search).
        - $D[i]$: minimum total coordinate displacement ($\sum |p - c|$) among length-$L[i]$ subsequences ending at $i$.
     2. **Backward Pass**: Compute for each candidate pin $i \in [m..1]$:
        - $R[i]$: length of the longest increasing subsequence in $cLine$ starting at pin $i$.
        - $D_{rev}[i]$: minimum displacement among length-$R[i]$ subsequences starting at $i$.
     3. **Global Optima**:
        - $L^* = \max_i L[i]$
        - $D^* = \min \{ D[i] + D_{rev}[i] - |p_i - c_i| : L[i] + R[i] - 1 = L^* \}$
     4. **Unconditional Intersection Predicate**:
        A pin $i$ lies on an optimal $(L^*, D^*)$ subsequence iff $L[i] + R[i] - 1 = L^*$ and $D[i] + D_{rev}[i] - |p_i - c_i| = D^*$.
        Pin $i$ belongs to $\bigcap_{S \in \mathcal{LIS}_{\min \Delta}} S$ **if and only if**:
        Pin $i$ is an optimal candidate, AND pin $i$ is the **UNIQUE** optimal candidate achieving rank $k = L[i]$ (i.e. $\operatorname{count}(\{j : L[j] = L[i] \land j \text{ is optimal}\}) == 1$).
        Pins that tie at rank $k$ are excluded. Total runtime: strictly $O(m \log m)$, fully polynomial and scale-free for 30,000+ line files (Probe `L`).
4. **`computeLCSPaths` & Optimal-Path Uniqueness**:
   Within leaf intervals without crossings, dynamic programming computes the LCS matrix $D[i, j]$ on `canon_hash` sequences. A pairing $(p, c)$ is optimal-path unique iff it lies on **every** maximal optimal **pairing** (embedding) of the interval's LCS. Distinct DP traceback walks that only permute down/right skips around identical matches yield the *same* pairing and are therefore not ambiguous — e.g. `[A, X, B]` vs `[A, Y, B]` has exactly one embedding $\{(1,1),(3,3)\}$, so `A` and `B` stay paired (raw traceback-path counting would wrongly retire them). If two or more distinct optimal pairings exist (ambiguous duplicate lines, e.g. `[A, B]` vs `[B, B]`, where the single `B` could pair with either duplicate), lines in that interval are marked **UNPAIRED / RETIRED**.
5. **Probe `H` Precision**:
   Fixture: `aaa│ a`, `bbb│ b`, `ccc│ a`. Edit `ccc` with `ccc│ modified`.
   `bbb` forms an Anchor Pin. In the sub-interval after `bbb`, `a` appears only once, uniquely pairing `ccc` to shifted line 4. Line 1 remains `a` and line 4 becomes `modified` (zero collision with `aaa`).

### 3.5 High-Duplication Files & Rigid Shift Preservation (Fixing B5 Review Gap)

1. **Rigid Block Shift Preservation**:
   If an interval has duplicate lines with $pCount == cCount$ and the canon sequence matches identically:
   The run has simply shifted without internal modification. Line $p$ is uniquely and unambiguously paired to $cStart + (p - pStart)$ (Probe `N`).
2. **Interior Modification Ambiguity**:
   Only when $pCount \neq cCount$ (lines inserted/deleted inside the repetitive run) AND the leaf bound is exceeded ($pCount > MAX\_LEAF\_LINES$ or $pCount \times cCount > MAX\_LEAF\_CELLS$) is it an information-theoretic impossibility to align duplicate lines without guessing. In that case, lines within the ambiguous interval fail closed under the §3.1.1 boundary rule (`[E_TARGET_LOST]` when no bound survives live and unshifted — no rows, read and re-target).

### 3.6 Coherent Storage Bounds & Post-Write Failure Semantics (Fixing B7 Review Gap)

1. **Storage Sizing & Global Eviction Ordering**:
   - Total global CAS database budget: **50 MB**.
   - Per-path retention: $\min(10, \max(2, \lfloor 10\text{MB} / \text{snapshot\_lineage\_bytes} \rfloor))$ where $\text{snapshot\_lineage\_bytes} \approx 40\text{ bytes} \times \text{line\_count}$.
    - **Eviction Priority**:
      - Pinned snapshots: Snapshots referenced by active `served_leases` (within 7-day TTL), `file_undo` restored targets (`file_undo.snapshot_hash`), or `retired_at` within 1 hour are **PINNED** and never evicted.
      - Unpinned snapshots: Eviction runs across all paths globally in order of **oldest `created_at`** until total size $\le 50\text{ MB}$ and per-path limits hold.
      - If all snapshots are pinned and budget is exceeded, eviction is deferred until lease expiration and the store temporarily soft-overflows: pinned snapshots are **never** evicted (a pin is the only copy of the lineage a live anchor resolves through), the deferred state is **reported** (`VacuumResult.deferredBytes` / `overSoftOverflow`, surfaced as an operator warning) and is expected to lapse as leases expire. The 100 MB figure is the tolerated soft-overflow window, not a threshold that unlocks eviction of pinned rows; a hard cap that evicts pins is a **rejected** option (ADR-0017, Considered Options).
2. **Post-`writeAtomic` Failure Recovery**:
    - If `writeAtomic` succeeds on disk but SQLite post-write transaction fails (busy/disk-full):
      The tool reports **success** (the file was written to disk) along with a warning that store synchronization is deferred. On the next tool call, `contentChecksum(disk) !== S_latest.snapshot_hash`, triggering automatic on-demand materialization from disk.
3. **ID Reuse Invariant**:
    `line_id_counters` is strictly monotonic and **never reset or dropped** while any snapshot or lease for that path exists. `pruneMissingAll` drops counter rows only when a path has zero snapshots, zero leases, and is absent from disk.

### 3.7 Decoupling `E_LARGE_FILE` (Fixing B8)

`E_LARGE_FILE` ($> 238,328$ lines exceeding 3-char base62 space) is an anchor-space encoding constraint, not a line-identity concurrency defect. It is removed from the header "Fixes:" and scoped out as a separate tracking issue.

### 3.8 Verification Rigor (Fixing B9)

- In Stage 0, the fail-closed probes assert both the boundary-rule code (probes `A`, `E`, `K` assert `rejects.toThrow(/E_TARGET_LOST/)`; probe `J` asserts `rejects.toThrow(/E_STALE_RANGE/)`) **AND** `expect(await readFile(path, 'utf-8')).toBe(originalBytes)` to verify zero file corruption.
- Monotonicity is verified by asserting $curr_i > curr_{i-1}$ across all pairs sorted by $prev_i$.

---

## 4. System Architecture & Seams Map

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                STORAGE TIER                                      │
│  src/hash-store.ts & src/snapshot-store/{index.ts,vacuum.ts,migrate.ts}          │
│  - file_snapshots: (snapshot_id PK, path, snapshot_hash, line_count, committed)  │
│  - line_lineage: (snapshot_id, line_number PK) -> (line_id, canon, anchor)       │
│  - line_id_counters: (path PK, next_id) [Atomic integer block allocation]       │
│  - served_leases: (session_id, path, anchor PK) -> (line_id, retired_at)         │
│  - file_undo: (path PK, snapshot_hash [restored], content, ...) [Pinned by Vacuum]│
│  - PRAGMA foreign_keys = ON; Proportional LRU Vacuum (50MB global cap)           │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│                                SESSION TIER                                      │
│  src/served-session/session.ts                                                   │
│  - Span Authority: served / servedCanons arrays (enforces contiguity)            │
│  - Identity Authority: served_leases registration & TTL management               │
│  - Universal Serve Hooks: read, diff, echo, truncated, undo_last_edit            │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│                       RESOLUTION & REBASE TIER                                   │
│  src/hashline/resolve.ts & src/hashline/lease-resolve.ts                         │
│  & src/hashline/served-verification.ts                                           │
│  - On-Demand S_current Materialization on Read and Edit (inside BEGIN IMMEDIATE) │
│  - Scaled Patience Pairing: dynamic budget MAX(100k, 4*(prev+curr))              │
│  - LIS Pin Backbone: crossing pins retire strictly within non-LIS spans          │
│  - Span Contiguity Gate: asserts interior span is not torn (Probe J)             │
│  - Preserved Guards: E_SUSPICIOUS_TEXT (rejects), E_REVERSED_ANCHORS, E_MALFORMED_ANCHOR   │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│                               MUTATION TIER                                      │
│  src/mutation-engine/pipeline.ts & src/hashline/apply.ts                         │
│  - In-Memory Working Buffer: preceding delta rebase for batches (Probe I, M)     │
│  - WAL Lineage Commit: writes S_final lineage directly from in-memory map       │
│  - src/lifecycle-hooks/index.ts: startup pruning for deleted paths               │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Mechanism Specification

### 5.1 SQLite DDL & Migrations (`src/hash-store.ts`)

```sql
PRAGMA foreign_keys = ON;

-- 1. Normalized File Snapshots
CREATE TABLE IF NOT EXISTS file_snapshots (
    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,          -- CANON_VERSION:xxh64(content)
    line_count INTEGER NOT NULL,          -- Total physical line count
    created_at INTEGER NOT NULL,          -- Epoch timestamp (ms)
    committed INTEGER NOT NULL DEFAULT 1, -- Committed atomically on write
    UNIQUE (path, snapshot_hash)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_created
ON file_snapshots (created_at);

-- 2. Transactional Sequence Counter per Path
CREATE TABLE IF NOT EXISTS line_id_counters (
    path TEXT PRIMARY KEY,
    next_id INTEGER NOT NULL
);

-- 3. Normalized Line-Level Identity & Lineage
CREATE TABLE IF NOT EXISTS line_lineage (
    snapshot_id INTEGER NOT NULL,
    line_number INTEGER NOT NULL,         -- 1-based coordinate in this snapshot
    line_id INTEGER NOT NULL,             -- Monotonic integer surrogate
    canon_hash TEXT NOT NULL,             -- xxh32(canon)
    anchor TEXT NOT NULL,                 -- Authoritative presentation anchor of record (persisted verbatim)
    PRIMARY KEY (snapshot_id, line_number),
    FOREIGN KEY (snapshot_id) REFERENCES file_snapshots(snapshot_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lineage_snapshot_line_id
ON line_lineage (snapshot_id, line_id);

-- 4. Active Served Leases per Session (Upsert Contract on Re-Serve)
CREATE TABLE IF NOT EXISTS served_leases (
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    anchor TEXT NOT NULL,                 -- Authoritative anchor shown to model
    line_id INTEGER NOT NULL,             -- Line identity leased (IMMUTABLE during edit)
    canon_hash TEXT NOT NULL,             -- Expected canon hash (O(1) check)
    served_snapshot_hash TEXT NOT NULL,   -- Snapshot when served
    served_line_number INTEGER NOT NULL,  -- Original line coordinate
    updated_at INTEGER NOT NULL,          -- Epoch timestamp (ms)
    retired_at INTEGER,                   -- Set when line retired (unpins after 1hr)
    PRIMARY KEY (session_id, file_path, anchor)
);

CREATE INDEX IF NOT EXISTS idx_leases_line 
ON served_leases (session_id, file_path, line_id);

CREATE INDEX IF NOT EXISTS idx_leases_line_num
ON served_leases (session_id, file_path, served_line_number);

CREATE INDEX IF NOT EXISTS idx_leases_file_retired
ON served_leases (file_path, retired_at);

-- 5. Session Drift Notice Metadata (Preserving `reported` dedup set)
CREATE TABLE IF NOT EXISTS served_session_meta (
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    reported TEXT,                        -- JSON array of already-reported drift hashes
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, file_path)
);

-- 6. Normalized File Undo Table (Isolated from v6 Drops)
CREATE TABLE IF NOT EXISTS file_undo (
    path TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    bom TEXT NOT NULL,
    ending TEXT NOT NULL,
    hashes TEXT NOT NULL,
    result_content TEXT NOT NULL,
    snapshot_hash TEXT,
    updated_at INTEGER NOT NULL
);

-- 7. Operational Upgrade Policy & Backward-Compatible Table Staging:
-- To prevent breaking active, un-restarted v6 sessions or concurrent worktrees sharing ~/.config/pi-better-edit/hash-store.sqlite,
-- buildStore does NOT drop legacy tables. Instead, it creates/maintains complete v6 compatibility shells:
--   CREATE TABLE IF NOT EXISTS snapshots (path TEXT PRIMARY KEY, checksum TEXT NOT NULL, line_count INTEGER NOT NULL, hashes TEXT NOT NULL, updated_at INTEGER NOT NULL);
--   CREATE TABLE IF NOT EXISTS served (session_id TEXT NOT NULL, path TEXT NOT NULL, hashes TEXT NOT NULL DEFAULT '[]', reported TEXT, retired TEXT, canons TEXT, snapshotId TEXT, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_id, path));
--   CREATE TABLE IF NOT EXISTS undo (path TEXT PRIMARY KEY, content TEXT NOT NULL, bom TEXT NOT NULL, ending TEXT NOT NULL, hashes TEXT NOT NULL, result_content TEXT NOT NULL, updated_at INTEGER NOT NULL);
--
-- Complete schema alignment prevents lingering v6 processes from failing with "no such column: retired" on their startup query,
-- and prevents v6's internal migration from triggering "DELETE FROM snapshots; DELETE FROM undo".
-- Furthermore, isolating v7's undo state in `file_undo` ensures that when an un-restarted v6 process executes its version-change drop
-- ("DROP TABLE IF EXISTS undo"), v7's undo history is 100% immune from deletion.
--
-- Operational Cutover:
-- Upgrading to v7 requires all active editor and agent sessions on the host to be restarted.
-- In mixed worktree / multi-agent environments, table isolation (file_snapshots, file_undo, line_lineage, served_leases)
-- ensures zero cross-version corruption even during rolling upgrades.

-- 8. v7 Idempotent Initialization Contract (Zero Drops on Version Flap):
-- When legacy v6 processes open the shared store, they detect meta.version != 6, drop legacy tables, and rewrite meta.version = '6'.
-- When v7 subsequently opens, it detects meta.version != '7'.
-- MANDATE: v7's buildStore MUST NEVER drop its own normalized tables (file_snapshots, line_id_counters, line_lineage,
-- served_leases, served_session_meta, file_undo) on version mismatch.
-- v7 initialization is strictly additive and idempotent:
--   1. Executes CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS for all normalized v7 tables and compatibility shells.
--   2. Executes non-destructive column migrations (e.g. ALTER TABLE ... ADD COLUMN ...).
--   3. Rewrites meta.version = '7'.
-- This guarantees that when meta.version flaps in mixed-version / multi-worktree environments, active v7 sessions NEVER suffer
-- lease drops, lineage destruction, or spurious E_STALE_RANGE re-read penalties.
```

### 5.2 Scaled Recursive Patience Pairing with Patience LIS Pin Backbone (`src/hashline/patience-pairing.ts`)

```ts
const MAX_LEAF_LINES = 2000;
const MAX_LEAF_CELLS = 4_000_000;

export interface LineDescriptor {
  lineNumber: number;
  canonHash: string;
}

export function pairSnapshots(
  prevLines: LineDescriptor[],
  currLines: LineDescriptor[]
): Map<number, number> { // prevLineNumber -> currLineNumber
  const pairing = new Map<number, number>();
  let scanBudget = Math.max(100_000, 4 * (prevLines.length + currLines.length));

  function alignRecursive(
    pStart: number, pEnd: number,
    cStart: number, cEnd: number
  ): void {
    if (pStart > pEnd || cStart > cEnd) return;

    // Budget guard
    const intervalLen = (pEnd - pStart + 1) + (cEnd - cStart + 1);
    if (scanBudget < intervalLen) return;
    scanBudget -= intervalLen;

    // Phase 1: Identify Locally Unique Pins
    const candidatePins = findUniquePins(prevLines, currLines, pStart, pEnd, cStart, cEnd);
    
    if (candidatePins.length > 0) {
      // Phase 1b: Extract Stable LIS Pin Backbone (Tie-broken by min displacement)
      const stablePins = findStablePinBackbone(candidatePins);
      
      if (stablePins.length > 0) {
        let pCur = pStart, cCur = cStart;
        for (const pin of stablePins) {
          alignRecursive(pCur, pin.pLine - 1, cCur, pin.cLine - 1);
          pairing.set(pin.pLine, pin.cLine);
          pCur = pin.pLine + 1;
          cCur = pin.cLine + 1;
        }
        alignRecursive(pCur, pEnd, cCur, cEnd);
        return;
      }
      // If stablePins is empty: candidate pins in this interval are contested/crossing.
      // Do NOT recurse on identical bounds! Fall through directly to leaf processing.
    }

    const pCount = pEnd - pStart + 1;
    const cCount = cEnd - cStart + 1;

    // Phase 2: Rigid Block Shift for Pinless Duplicate Intervals (Probe N)
    if (pCount === cCount) {
      let identical = true;
      for (let i = 0; i < pCount; i++) {
        if (prevLines[pStart - 1 + i]!.canonHash !== currLines[cStart - 1 + i]!.canonHash) {
          identical = false;
          break;
        }
      }
      if (identical) {
        for (let i = 0; i < pCount; i++) {
          pairing.set(pStart + i, cStart + i);
        }
        return;
      }
    }

    // Phase 3: Leaf Interval - Bound Checks for Interior Modifications
    if (pCount > MAX_LEAF_LINES || cCount > MAX_LEAF_LINES || (pCount * cCount) > MAX_LEAF_CELLS) {
      return; // Over-budget leaf interval -> leave unpaired
    }

    // Phase 4: Minimal-Cost LCS Alignment & Uniqueness Predicate
    const lcs = computeLCSPaths(prevLines, currLines, pStart, pEnd, cStart, cEnd);
    if (lcs.isUnique) {
      for (const [pLine, cLine] of lcs.uniquePairs) {
        pairing.set(pLine, cLine);
      }
    }
  }

  alignRecursive(1, prevLines.length, 1, currLines.length);

  // Assert Monotonicity Invariant
  const sortedPairs = [...pairing.entries()].sort((a, b) => a[0] - b[0]);
  let lastCurr = 0;
  for (const [prev, curr] of sortedPairs) {
    if (curr <= lastCurr) throw new Error(`Pairing monotonicity violation: ${prev} -> ${curr} <= ${lastCurr}`);
    lastCurr = curr;
  }

  return pairing;
}
```

### 5.3 Resolution State Machine & Error Code Decision Table

```
                         Edit Arrives targeting [anchor_from, anchor_to]
                                                │
                                 Look up anchors in served_leases
                                                │
                                 ┌──────────────┴──────────────┐
                                 ▼ Found                       ▼ Not Leased
                       Retrieve leased line_ids           Throw [E_STALE_ANCHOR]
                       and snapshot hashes                (Echo fresh anchors)
                                                │
                                 Compute C = contentChecksum(disk)
                                                │
                     ┌──────────────────────────┴──────────────────────────┐
                     ▼ S_from === C && S_to === C && S_from === S_to       ▼ Any S !== C || S_from !== S_to
                 FAST PATH (Uniform Snapshot)                          ON-DEMAND REBASE (Mixed Snapshots / Drift):
             Validate Span Contiguity                                  BEGIN IMMEDIATE:
             in served_leases over the                                  1. Materialize C if needed
             whole served window                                       2. Query line_lineage(C) for line_ids
                     │                                                 3. Rebase line coordinates to s'
             ┌───────┴───────┐
             ▼ Valid         ▼ Torn/Never-Served                                   │
         APPLY EDIT      Throw [E_STALE_RANGE]                         Are leased line_ids in S_current?
                                                                                   │
                                                                       ┌───────────┴───────────┐
                                                                       ▼ YES                   ▼ NO (Retired/Torn)
                                                               Validate Span Contiguity    Boundary rule (§3.1.1): exactly
                                                                       │                   one stale + survivor live and
                                                                       │                   unshifted ⇒ [E_UNVERIFIED_RANGE]
                                                                       │                   (fresh read, decide from rows);
                                                                       │                   otherwise ⇒ [E_TARGET_LOST]
                                                                       │                   (no rows; read and re-target)
                                                               ┌───────┴───────┐
                                                               ▼ Valid         ▼ Torn (Probe J)
                                                           APPLY AT s'     Throw [E_STALE_RANGE]
                                                       (0 Context Retries)
```

**Fast-Path Qualification across Incremental / Mixed-Snapshot Leases**:
When an edit spans multiple anchors, each anchor carries its own `served_snapshot_hash`. In incremental sessions (e.g. following `recordDiff` or partial re-serves), `anchor_from` and `anchor_to` may originate from different snapshots.
An edit qualifies for the $O(1)$ fast path (direct coordinate application using the served buffer) **if and only if**:
$$\text{lease}_{from}.\text{served\_snapshot\_hash} == C \quad \land \quad \text{lease}_{to}.\text{served\_snapshot\_hash} == C \quad \land \quad \text{lease}_{from}.\text{served\_snapshot\_hash} == \text{lease}_{to}.\text{served\_snapshot\_hash}$$
If any anchor originates from a different snapshot, or disk content has drifted ($S \neq C$), the edit **MUST** execute the Dynamic Rebase Path through `line_lineage` to resolve rebased coordinates $s'$ for each leased `line_id`.

The iff selects the coordinate space, never the verification: the fast path is the rigid remap whose rebased coordinates happen to equal the served ones ($rebasedStart = servedStart \land rebasedEnd = servedEnd$), so **both** paths run the same whole-window identity gate in `src/hashline/served-verification.ts` (`verifyRebasedSpan`) before any write. For every row $k$ of the served window the gate requires a served mirror row, a lease for the anchor it names, `retired_at IS NULL`, and `rebasedLineOf(lease.line\_id) = rebasedStart + k$. A mixed-snapshot span therefore cannot bypass per-line identity verification: the gate rejects it on the interior row whose lease is retired or whose `line_id` no longer lives at its expected coordinate, whether or not the current content happens to present the same 3-char anchor.

| Failure Condition | Seam Responsible | Output Error Code | Recovery Action |
| :--- | :--- | :--- | :--- |
| Anchor not present in `served_leases` | `src/hashline/lease-resolve.ts` (`resolveLeasedEdit`) | `[MODEL] [E_STALE_ANCHOR]` | Echoes current range; model retries |
| Target span contains unread interior lines, an unleased interior anchor, or an interior lease retired / moved | `served-verification.ts` (`verifyRebasedSpan`, both paths) | `[MODEL] [E_STALE_RANGE]` | Echoes current range; model retries with those rows |
| Leased `line_id` deleted or retired (Probe `E`, `A`) | `src/hashline/lease-resolve.ts` (`resolveLeasedEdit`) | `[MODEL] [E_UNVERIFIED_RANGE]` (survivor live and unshifted: fresh read to decide from) or `[MODEL] [E_TARGET_LOST]` (otherwise: read and re-target) | Serves the named window or nothing |
| External insert strictly inside span (Probe `J`) | `served-verification.ts` | `[MODEL] [E_STALE_RANGE]` | Echoes current range; model retries |
| External swap/reorder of code blocks (Probe `K`) | `src/hashline/lease-resolve.ts` (`resolveLeasedEdit`, stale branch — both bounds retired) | `[MODEL] [E_TARGET_LOST]` | No rows; prose names the previously served position | Read and re-target |
| Overlapping/nested spans in multi-edit batch | `pipeline.ts` (`assertBatchSpansDisjoint`, on lease-resolved baseline spans) | `[MODEL] [E_BATCH_ABORT]` | Rejects batch; model separates edits |
| Malformed payload or apply-time failure inside a multi-item batch | `pipeline.ts` | the item's **own** code (`E_MALFORMED_ANCHOR`, `E_REVERSED_ANCHORS`, `E_SUSPICIOUS_TEXT`, `E_STALE_RANGE`, …) | Rejects the whole call — nothing was written; the message carries the atomicity trailer |
| Replacement text contains `HASH│` prefix | `apply.ts` | `[MODEL] [E_SUSPICIOUS_TEXT]` | Rejects literal echoed prefix (`EditHashEchoError`) |
| Inverted anchors (`anchor_from` after `anchor_to`) | `resolve.ts` | `[MODEL] [E_REVERSED_ANCHORS]` | Heals or rejects reversed anchors |
| Dangling lease (snapshot evicted by vacuum) | `src/hashline/lease-resolve.ts` (`resolveLeasedEdit`) | `[MODEL] [E_UNVERIFIED_RANGE]` or `[MODEL] [E_TARGET_LOST]` (boundary rule) | Serves the named window or nothing |

**Tombstone's two live jobs.** `tombstone` is never a lease state and never a second identity authority — ADR-0017 explicitly rejected that; `tryHealOrphanedSpan`, `removedByContent` and epoch/`strictPos` are retired (§3.3). Its first job is the hash-allocation guard: `src/hashline/hash-identity.ts:202-209` (`lineHashesPure`) and `:348-349` (`mapStableHashes`) mark every tombstoned hash used, so a freed anchor never re-binds for the session (plumbed via `src/hashline/hash.ts:105-134`, stored as `served.retired` in `src/served-session/session.ts:804-815`). Its second job is the verification signal, and it is now confined to the library-level seam: `src/hashline/served-verification.ts` rejects a tombstoned boundary hash as `[E_UNVERIFIED_RANGE]` (fresh read, `details.cause: "tombstone"`) and a tombstoned interior as `[E_STALE_RANGE]` (retry, same cause) only for a caller that presents a served mirror and **no** lease source. A session edit resolves every span through `served_leases`, where a retired lease supersedes the tombstone with `details.cause: "retirement"` (issue #151).

**Rejection payloads carry `details.cause`.** Every range-family producer emits it as a user-facing diagnosis — never the model remedy, the code alone selects that (`src/mutation-engine/engine.ts:35-47` preserves it onto the failure). As built (`src/hashline/served-verification.ts:36-44`): the `stale` branch reports `retirement` for both its codes (`src/hashline/lease-resolve.ts:216-230`); the tombstone checks report `tombstone` (`served-verification.ts:512,582`); an unleased anchor reports `never-served` (`lease-resolve.ts:130`), as do a never-served interior (`served-verification.ts:734`) and an unplaceable bound (`:790`); drift, length and hash mismatches report `served-range staleness` (`:356,393,561,748,761`); a content-path mismatch reports `anchor staleness` (`src/hashline/apply.ts:266`). `served span` stays a reserved glossary value with no current producer.

Leased-anchor resolution lives in `src/hashline/lease-resolve.ts` (`resolveLeasedEdit`, `:148-231`); `valEdit` (`src/hashline/resolve.ts:448-497`) is the pure content-resolution seam for callers with no served mirror and no lease source. Only that library-level seam still reads `verifyServedRange` (`src/hashline/served-verification.ts`) — its mirror-vs-mirror decision table, including the canon-digest and tombstone tiers, is retired from the leased edit path (issue #151).

---

## 6. Deliverables & Staging Roadmap

### Stage 0 — Empirical Pin (No Behavior Change)

- File: `test/integration/p0-drift-line-identity.test.ts` (renamed by #88 to the glossary's `drift` term)
- Implement all twelve canonical probes (`A, B, C, D, E, H, I, J, K, L, M, N`) plus the three normative contract deliverables (§3.1.2 re-serve upsert, §3.6.2 post-write failure recovery, §7.2.9 undo usability without intermediate read). Total: 15 tests.
- Pinned baseline failures on `main` via `it.fails`:
  - `A, E`: P0 silent miswrites on `main`
  - `B, H`: Anchor collision / reshuffle rejections on `main` before leases
  - `K`: External swap heals and auto-rebases on `main` instead of rejecting fail-closed
  - `Undo Usability (§7.2.9)`: `undo_last_edit` does not grant leases in session store on `main`, rejecting with `E_STALE_ANCHOR`
- Normal passing tests on `main`: `C, D, I, J, L, M, N`, §3.1.2 re-serve upsert, §3.6.2 post-write failure recovery.
- Suite status: 100% green (9 passed, 6 expected fail).

### Stage 1 — CAS Storage, Migrations & Universal Leases

- Seams: `src/hash-store.ts`, `src/snapshot-store/{index.ts,vacuum.ts,migrate.ts}`, `src/undo-store.ts`, `src/served-session/session.ts`, `src/edit-undo.ts`, `src/read.ts`, `src/constants.ts`
- Bump `HASH_STORE_VERSION = 7` in `src/constants.ts`. To avoid breaking concurrent/pre-existing v6 sessions across worktrees, `buildStore` maintains full v6 compatibility shells (`snapshots`, `served`, `undo`) rather than dropping them.
- Implement `PRAGMA foreign_keys = ON;`, create normalized tables (`file_snapshots`, `line_lineage`, `line_id_counters`, `served_leases`, `served_session_meta`, `file_undo`), and add indexes (`idx_leases_file_retired`, `idx_leases_line_num`, `idx_snapshots_created`).
- Re-architect `src/snapshot-store/{index.ts,vacuum.ts,migrate.ts}` to implement `HashSnapshotIO` (`getSnapshot` / `upsertSnapshot`) backed directly by normalized `file_snapshots` and `line_lineage` (ordered by `line_number ASC`), replacing legacy serialized JSON blobs while preserving verbatim presentation anchors across reads (`index.ts` re-exports, so every existing import path still resolves).
- Re-architect `src/undo-store.ts` and `src/edit-undo.ts` to persist undo history in `file_undo` (including `snapshot_hash` pinning), structurally isolated from v6 version drops.
- Standardize checksum on `CANON_VERSION:xxh64`.
- Retain drift notice deduplication by writing/reading the `reported` set in `served_session_meta`.
- Implement transactional read-path materialization in `read.ts` (`recordEpoch`) with `retired_at` writer and strictly monotonic, non-rewinding `line_id_counters` allocation (`next_id = start_id + N`).
- Wire universal lease granting across all five serve paths with atomic upsert:
  1. `recordEpoch` (reads)
  2. `recordDiff` (post-edit diffs)
  3. `recordEcho` (rejection echo rows)
  4. `recordTruncated` (drift notices)
  5. `undo_last_edit` (file reverts — unlocking §7.2.9: adopts pinned canonical snapshot via cache lookup, zero counter allocations, and upserts restored leases)
- **Stage 1 Test Modernization**:
  - Modernize `test/tools/served-session.test.ts` (lines 27, 85) to assert `served_leases` upsert and `retired_at` lifecycle instead of legacy mirror nulling on duplicate hashes.
  - Modernize `test/core/served-store.test.ts` (update raw SQL queries targeting deprecated `served` table to `served_leases` / `served_session_meta`).
  - Modernize `test/core/snapshot-store.test.ts:98,138` (update raw SQL queries targeting deprecated `snapshots` table to `file_snapshots` / `line_lineage`).
  - Modernize `test/tools/preview-no-persist.test.ts:90,106` (update corrupt helper targeting `snapshots` to `line_lineage`).
  - Modernize `test/core/whitespace-insensitive-canon.test.ts:119,135` (semantic rewrite: query `file_snapshots.snapshot_hash` and assert standardized `CANON_VERSION:xxh64` format).
  - Modernize `test/core/hash-store.test.ts:202` (update concurrent immediate transaction test from `snapshots` to `file_snapshots` / `line_lineage`).
  - Modernize `test/core/undo-store.test.ts:143,227,250` (update raw SQL queries targeting `undo` to `file_undo`).
  - Seam guards delivered with these stages (not incidental extras): `test/arch/snapshot-store-module-boundary.test.ts` (the package split), `test/arch/serve-recording-seam.test.ts` and `test/arch/undo-schema-seam.test.ts` (the shared serve writer and the dropped undo-schema forwarder), `test/arch/terminology-synonyms.test.ts` (the `serve` vocabulary rule).

### Stage 2 — Pairing Engine, Working Buffer & Rebase Seams

- Seams: `src/hashline/patience-pairing.ts`, `src/hashline/resolve.ts`, `src/hashline/served-verification.ts`, `src/hashline/lease-resolve.ts`, `src/mutation-engine/pipeline.ts`, `src/hashline/healing/*` (`policy.ts`, `single-canon.ts`, `boundary.ts`, `orphan.ts`, `helpers.ts`, `types.ts`, `index.ts`)
- Implement `pairSnapshots` with scaled dynamic budget (`MAX(100k, 4*(p+c))`), Patience LIS pin backbone with unconditional intersection tie-breaking across minimal-displacement candidates (via polynomial two-pass DP), progress-guaranteed leaf fall-through, rigid block shift preservation (Probe `N`), and bounded leaf LCS.
- Wire edit-path on-demand materialization inside `BEGIN IMMEDIATE` in `pipeline.ts` with `retired_at` writer.
- Implement in-memory working-buffer preceding delta rebase for multi-edit batches (Probes `I`, `M`).
- Re-architect `valEdit` in `resolve.ts` to resolve via rebased `served_leases`, preserving `E_SUSPICIOUS_TEXT` (rejects), `E_REVERSED_ANCHORS`, `E_MALFORMED_ANCHOR`.
- **ADR-0008 Healing Subsystem Deprecation & Test Modernization**:
  - Delete `tryHealOrphanedSpan` and the heuristic canon healing module `src/hashline/healing/*`.
  - Retire unit test files dedicated to deprecated heuristic healing: delete `test/hashline/healing.test.ts` and `test/hashline/healing-policy.test.ts`.
  - Update `test/core/served-verification.test.ts:71` ("single-candidate canon heal"): directly calling `ServedVerification.verify` with un-rebased coordinates must now assert fail-closed rejection (`result.ok === false`, `code: "E_UNVERIFIED_RANGE"`), while full-pipeline coordinate shifts are asserted end-to-end in `test/integration/p0-drift-line-identity.test.ts` Probe `C`.
  - Re-align integration test expectations in `test/integration/hash-heal-tdd.test.ts` and `test/integration/served-edge-cases.test.ts:98` to assert MVCC line-identity rebase / re-serve upsert / fail-closed semantics rather than calling deprecated healing adapters.
- Enforce span contiguity invariant in `served-verification.ts` (Probe `J`).
- Remove `it.fails` from Stage 0. All 15 tests pass green.

### Stage 3 — Vacuum Engine & ADR Documentation

- Seams: `src/snapshot-store/vacuum.ts`, `src/served-session/session.ts`, `src/lifecycle-hooks/index.ts`
- Implement global LRU vacuum across all paths (max 10 snapshots per path, 50MB cap, pinning active leases, `file_undo` restored targets (`file_undo.snapshot_hash`), and 1hr retired leases).
- Wire `lifecycle-hooks/index.ts` (`pruneMissingAll`) to purge deleted file snapshots.
- Record supersession ADRs in `docs/adr/` formally superseding ADR-0008 and ADR-0013.

---

## 7. Acceptance Criteria & Invariants

### 7.1 Soundness Criteria (Fail-Closed)

1. **Probe `E` (External Delete Collision)**: Full read $\to$ external delete of `f1` $\to$ edit with `psM` $\to$ **must reject with `[E_TARGET_LOST]`** (no rows; read and re-target); file bytes unchanged on disk.
2. **Probe `A` (Partial Read Variant)**: Partial read $\to$ external delete $\to$ edit with deleted line's anchor $\to$ **must reject with `[E_TARGET_LOST]`** (no rows; read and re-target); file bytes unchanged on disk.
3. **Probe `J` (Interior Span Tearing)**: External insert strictly inside target span $\to$ **must reject with `[E_STALE_RANGE]`**; file bytes unchanged on disk.
4. **Probe `K` (Equal-Length Contested Swap)**: External swap of two equal-length unique functions without intervening stable pins $\to$ edit either function $\to$ **must reject with `[E_TARGET_LOST]`** (both bounds retired — no rows; read and re-target); file bytes unchanged on disk.
5. **Formal Invariants (Asserted on SQLite Store)**:
   - **Monotonicity**: All paired lines preserve strict coordinate ordering ($p_1 < p_2 \implies c_1 < c_2$).
   - **Canon-Equality**: $\text{canon}(prev) === \text{canon}(curr)$ for every paired line.
   - **Unpaired Absenteeism**: Every unpaired prev `line_id` is absent from $S_{curr}$ lineage.
   - **Sound Execution**: An edit shall NEVER commit to a line whose stored `line_id` differs from the `line_id` leased **in the active, unretired lease in force at edit time** (the most recent serve of that anchor in that session where `retired_at IS NULL`). A retired lease intercepts fail-closed with `[E_UNVERIFIED_RANGE]` (live unshifted survivor: fresh read to decide from) or `[E_TARGET_LOST]` (otherwise: no rows, read and re-target); an un-leased anchor intercepts with `[E_STALE_ANCHOR]`, and strictly monotonic counter allocation guarantees a defunct `line_id` is never re-issued.
6. **Negative Regression Guard: Heuristic Canon Relocation Rejection**: Direct calls to `ServedVerification.verify` with shifted coordinates against an un-rebased `served` array (`test/core/served-verification.test.ts:71`) **must reject fail-closed** (`ok: false`, `code: "E_UNVERIFIED_RANGE"`). Heuristic canon guessing (`tryHealOrphanedSpan`) is completely retired; coordinate realignment is exclusively owned by MVCC `pairSnapshots` + `line_lineage`.

### 7.2 Context-Preservation Criteria (Position-Free Rebase)

1. **Probe `B` (Surviving Anchor Rebase)**: External delete of `f1` $\to$ edit with surviving anchor `AKU` $\to$ **must auto-rebase cleanly to line 2 and apply**.
2. **Probe `C` (Exterior Insert)**: Insert 7 lines before target $\to$ edit with surviving anchor $\to$ **must auto-rebase silently and apply at line 16**.
3. **Probe `D` (Exterior Edit)**: Modify line in `f1` $\to$ edit with `f2` anchor $\to$ **must auto-rebase silently and apply at line 9**.
4. **Probe `H` (Duplicate Canons with Intervening Insert)**: `aaa`, `bbb`, `ccc` with insert before `ccc` $\to$ edit `ccc` with `ccc│ mod` $\to$ **line 1 remains `a`, line 4 becomes `mod`**.
5. **Probe `I` (Internal Chained Edits)**: Batch edits in a single tool call auto-rebase via in-memory preceding deltas with zero rejections.
6. **Probe `L` (Large-File Exterior Rebase)**: 30,000-line file with exterior insert $\to$ edit unrelated line $\to$ **must auto-rebase silently via scaled budget**.
7. **Probe `M` (Drift + Batch Edits)**: Exterior insert 7 lines $\to$ batch edits out-of-order $\to$ **auto-rebases both edits accurately on top of shifted baseline $s'$**.
8. **Probe `N` (Large-File Duplicate Run Shift)**: 3,000 identical lines with exterior insert 5 lines at top $\to$ edit line 1,500 $\to$ **auto-rebases silently to line 1,505 via rigid block shift**.
9. **Probe §3.1.2 (Re-Serve Upsert Contract)**: External edit $\to$ re-read $\to$ subsequent edit targeting re-served anchor succeeds cleanly without stale fail-closed loop.
10. **Probe §3.6.2 (Post-Write Recovery)**: Store desync leaves disk updated $\to$ re-read $\to$ subsequent edit auto-rebases cleanly from authoritative disk state.
11. **Probe §7.2.9 (Undo Usability)**: Editing immediately using anchors output from `undo_last_edit` succeeds without an intermediate `read`.

### 7.3 Quality & Toolchain Gates

- `pnpm run lint` clean (oxlint).
- `pnpm run format` clean (oxfmt).
- `pnpm run typecheck` clean (tsc).
- `pnpm run test:coverage` passing thresholds: lines $\ge 85\%$, statements $\ge 85\%$, functions $\ge 85\%$, branches $\ge 80\%$.

---

## 8. Prior Art & Downstream Tracking

- Downstream Issue [Rianico/dsh-better-edit#61](https://github.com/Rianico/dsh-better-edit/issues/61): Root cause is content-derived anchor re-allocation across file versions without line-identity leases.
- Downstream Issue [Rianico/dsh-better-edit#62](https://github.com/Rianico/dsh-better-edit/issues/62): Coordinate compression in `read-and-serve` causes anchor reshuffling. Fixed by maintaining absolute line coordinates in `line_lineage`.
- Upstream Prior Art:
  - `src/hash-store.ts`: SQLite busy-retry loops and connection lifecycle.
  - `src/drift.ts`: Interval arithmetic and span calculations.
  - Superseded ADRs: ADR-0008, ADR-0013.

---

## 9. Appendix — Revision 25 patch (stale-identity rejection)

Status: **proposed** — derived from the 2026-09-15 session triage ([`mvcc-session-failure-handoff.md`](mvcc-session-failure-handoff.md)). Where this appendix contradicts the body, this appendix is normative. Fix spec and verification: [`stale-identity-reject-and-serve.md`](stale-identity-reject-and-serve.md).

### 9.1 Defect

The `stale` decision in `resolveLeasedEdit` (`src/hashline/lease-resolve.ts:173-183`) builds its reject-and-serve window from `fromLease.servedLineNumber` / `toLease.servedLineNumber` — the lease's **historical** coordinate. `assembleRejectAndServe` (`src/hashline/served-verification.ts:107,128-171`) renders it as `Current range:` plus `Retry with these anchors (no read needed).`, and `recordRejectionServe` (`src/mutation-engine/pipeline.ts:471-485` → `src/served-session/session.ts:679,953`) leases those rows. For a retired identity that coordinate identifies nothing about the model's target, so a model following §5.3's recovery replaces whichever line now occupies the old number. Reproduced: external deletion of the targeted line → the rejection serves the shifted-in neighbour → the retry is accepted and that neighbour is overwritten, reported as success. Re-confirmed on `ba7c8d2` (current `main`, 2026-09-15): the rejection and the miswrite are byte-identical to `bd3a8f2` — see the Revision check in [`stale-identity-reject-and-serve.md`](stale-identity-reject-and-serve.md). Probe `P` (same revision) covers the other arm of the same expression: when the retired line's text is re-added elsewhere, the content match relocates the window to the new coordinate and the leased retry writes there — ADR-0008's class, with a lease on it.

### 9.2 Normative deltas

| # | Delta | Supersedes |
| :- | :--- | :--- |
| D1 | A `stale` decision applies the **boundary rule** (`src/hashline/lease-resolve.ts:198-231`): rows are served **only** when exactly one bound is stale and the survivor is live *and* unshifted (its rebased coordinate equals its served coordinate — evidence that no shift occurred). That single case is **`[E_UNVERIFIED_RANGE]`**: the named window (served coordinates clamped to the file) under the exact heading `Current range (fresh read):`, one general headline clause, no retry hint and no mandate, rows leased through the normal serve seam. Both bounds stale, a shifted survivor, or a clamped window that collapses or misses the file is **`[E_TARGET_LOST]`**: no `Current range` heading of either form and **no rows at all** — the message names the previously served position in prose. | §5.3 row "Leased `line_id` deleted or retired" (its "Echoes current range" recovery) |
| D2 | A target-lost rejection performs **no** `recordRejectionServe` upsert (there are no rows), so an accidental retry cannot write. Every window that identifies the model's range (in-place drift, never-served interior, `E_UNVERIFIED_RANGE` fresh reads, `E_BATCH_ABORT`, content-placeable `E_STALE_ANCHOR`) still leases. | new invariant |
| D5 | **Content placement is banned from the payload.** `uniqueAnchorLine` may not place a rejection window, and neither the window nor the headline's line number may come from a content match for a retired bound (Probe `P`: the header named line 4 for a line-2 lease). | §3.1.1 step 1 / §5.3 |
| D3 | The retry hint is a property of the rejection payload, not an unconditional suffix. A target-lost rejection instead carries `The line you targeted no longer exists — read the file and re-target.` | §3.1.1 step 1 (*"Throw [E_STALE_ANCHOR] (Echo fresh anchors)"*); §5.3 recovery column |
| D4 | One wording family across `E_STALE_ANCHOR` / `E_STALE_RANGE` / `E_TARGET_LOST` / `E_UNVERIFIED_RANGE` / `E_SUSPICIOUS_TEXT`; anchors are counted and listed per **distinct** anchor. | §5.3 recovery column text |
| D6 | **New code `[E_TARGET_LOST]`** for exactly the range-unidentifiable rejections of D1. The codes are disjoint by payload shape: `[E_STALE_RANGE]` and `[E_UNVERIFIED_RANGE]` always render rows (under `Current range:` with a retry hint, and under `Current range (fresh read):` with none, respectively), `[E_TARGET_LOST]` never does, so the remedy is machine-readable. | new code (README error table, `CONTEXT.md`, prompts) |

Post-sync notes for §9.2: `ba7c8d2` added `src/hashline/served-guard.ts` with `[E_SUSPICIOUS_TEXT]` and the `mode: "literal"` escape — a **third** rejection contract to fold into D4 (frozen literals per ADR-0009's 2026-09-15 revision) — and removed the content-surface shape refusal, so a `replace_with` holding never-served anchor-shaped lines is now written verbatim; decide whether that case warrants a non-blocking `[MODEL]` note. The deltas are D1–D6: D5 bans content placement from the payload (the arm Probe `P` exercised), and D6 splits the code so `[E_TARGET_LOST]` ⇒ no rows, `[E_STALE_RANGE]` ⇒ rows under `Current range:` with a retry hint, `[E_UNVERIFIED_RANGE]` ⇒ rows under `Current range (fresh read):` with none. The full producer audit is the patch spec's Appendix E.

### 9.3 Replacement row for the §5.3 decision table

| Failure condition | Seam | Code | Window | Hint | Leased |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Leased `line_id` deleted or retired (Probe `E`, `A`) | `lease-resolve.ts` (`resolveLeasedEdit`) | `[MODEL] [E_TARGET_LOST]` | none — prose names the previously served position; the named window (served coordinates clamped to the file) only when exactly one bound is stale and the survivor is live and unshifted (then `[E_UNVERIFIED_RANGE]` fresh read to decide from) | read and re-target | n/a (no rows) |

Rows for `E_STALE_ANCHOR` (content-placeable), never-served interiors (now `E_STALE_RANGE`) and in-place `E_STALE_RANGE` keep their current recovery; only their wording is unified under D4.

### 9.4 Errata in the body

| Location | Claim | Correction |
| :--- | :--- | :--- |
| §5.3 decision table, "Target span contains unread interior lines" | recovery: *"Echoes unread range; model reads range"* | the implementation appends the shared `Retry with these anchors (no read needed).`; D3/D4 must make the hint match the column — the interior was never served, so the model reads |
| §7.1.5 *Sound Execution* | an edit never commits to a line whose `line_id` differs from the leased one | strengthened: a rejection payload must also never *present* a coordinate the model never targeted, because served rows are leased and thereby become committable |
| §8 prior art, downstream #62 | "Fixed by maintaining absolute line coordinates in `line_lineage`" | unchanged, with one clarification: absolute coordinates do not make a retired identity's historical coordinate an identity — retired identities recover only by re-read |

### 9.5 Decision record required

ADR-0016's *Consequences* states that a retired anchor "is recoverable only by a re-read (or by `reject-and-serve`'s served rows)". The parenthetical must be **deleted** (not narrowed): target-lost recovery is always a re-read. This is written as [`../../docs/adr/0018-region-scoped-rejection-serves.md`](../../docs/adr/0018-region-scoped-rejection-serves.md) (status `proposed`), which leaves ADR-0016's Decision intact — no non-leasing serve is introduced — and records the region rule plus the derivable-rows oracle. `CONTEXT.md` gains the term **target-lost rejection**; the previously floated **context serve** term is dropped, since D1 renders no rows at all.

### 9.6 Acceptance

The nine tests listed in [`stale-identity-reject-and-serve.md`](stale-identity-reject-and-serve.md) must fail on `bd3a8f2` (and on `ba7c8d2`, where the defect is re-confirmed) and pass on the patched revision; the `lint`, `format`, `typecheck` and `test:coverage` gates are unchanged.
