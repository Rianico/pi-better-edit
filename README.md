<p align="center">
  <img src="assets/banner.svg" alt="pi-better-edit banner" width="640">
</p>

<h1 align="center">pi-better-edit</h1>
<p align="center">
  <strong>Production-grade, hash-anchored file editing for &pi;.<br>
  Powered by Content-Addressed Line-Identity MVCC &mdash; no line numbers, no re-typing old code, no heuristic guessing, and zero silent miswrites.</strong>
</p>

<p align="center">
  <a href="#why-pi-better-edit-v2"><img src="https://img.shields.io/badge/architecture-MVCC_v2-blue?style=flat" alt="MVCC v2"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/quick_start-30s-brightgreen?style=flat" alt="quick start 30s"></a>
  <a href="#reproducible-benchmarks"><img src="https://img.shields.io/badge/correctness-23%2F23-success?style=flat" alt="23/23 battery"></a>
  <a href="https://www.npmjs.com/package/pi-better-edit"><img src="https://img.shields.io/npm/v/pi-better-edit?color=crimson" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#why-pi-better-edit-v2">Why v2 MVCC</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#systematic-architecture">Architecture</a> •
  <a href="#tools">Tools</a> •
  <a href="#error-and-warning-contract">Errors & Warnings</a> •
  <a href="#comparison">Comparison</a> •
  <a href="#reproducible-benchmarks">Benchmarks</a> •
  <a href="#upgrading-from-1x">Upgrading</a>
</p>

---

> *"The harness — not the model — is the bottleneck."* — Can Bölük, [*The Harness Problem*](https://stencil.so/blog/the-harness-problem)
>
> When an LLM edits code, line numbers shift under its feet and re-typing text wastes tokens while inviting hallucinations. Naive hashline tools force the model to manually track line renumbering, while early heuristic implementations attempted to guess anchor targets—causing catastrophic silent miswrites when identical lines existed (e.g. duplicate function guards).
>
> **`pi-better-edit` v2 solves this systematically.** Built on **Content-Addressed Line-Identity MVCC**, every line is tracked by an immutable lineage ID, verified across session-keyed leases, and aligned via Patience LIS sorting. Edits auto-rebase across non-conflicting external shifts (0 tokens burned, 0 retries), and true conflicts fail closed with immediate fresh ranges.

## Why pi-better-edit v2

| Traditional (`str_replace` / Line Numbers) | Naive Hashline / Tagged Patches | pi-better-edit v2 (Line-Identity MVCC) |
| --- | --- | --- |
| Model re-types old code (output billed ~5–6× input) | Sends line numbers + full-file content tags | **Sends two 3-char hashes**; old code is never re-typed |
| One insert above shifts every line below → silent corruption | Requires agent to mentally renumber lines after every edit | **Anchors are content addresses**; exterior shifts auto-rebase cleanly |
| No verification against what the model was served | Verifies file version, but not individual line coordinates | **Leased spans verified against snapshot lineage** before touching disk |
| Duplicate lines cause ambiguous replacement failures | Line numbers distinguish lines, but position is unverified | **Coprime bitset probing** assigns unique hashes; 0 duplicate ambiguity |
| External file drift causes blind overwrite or failure | Best-effort 3-way merge or tag rejection | **Fail-closed reject-and-serve**: rejects edit and returns fresh anchors in 1 turn |

### Key Properties of a Mature & Systematic Implementation

- **Decoupled Line Identity (MVCC)**: Line identity belongs to an immutable, monotonic `line_id` in CAS snapshot storage, not to volatile line coordinates or ephemeral anchor strings.
- **Zero-Token Auto-Rebase**: Non-conflicting exterior shifts (insertions above, comments, automated formatters like Prettier/ESLint) auto-rebase silently without agent intervention (0 extra tokens, 0 retries).
- **Fail-Closed Reject-and-Serve**: True semantic conflicts (deleted targets, torn interior spans, contested reorders) fail closed. Instead of forcing a separate `read` round-trip, the tool immediately serves the fresh on-disk `HASH│content` range in the rejection (`[E_STALE_RANGE]`, `[E_UNVERIFIED_RANGE]`).
- **No Heuristic Guessing (ADR-0016)**: v2 retires the 1.x heuristic healing era (`tryHealOrphanedSpan`). Heuristic matching of duplicate lines caused silent miswrites (Probe E). v2 guarantees that if a line cannot be unambiguously resolved via lease lineage, it fails closed safely.
- **Session-Keyed Lease Isolation (ADR-0002)**: Leases are isolated per session (`served_leases`). Sub-agent sessions never validate or contaminate main session edits.
- **Atomic Multi-Item Batches**: Apply up to 32 same-file edits in one `edit` call with preceding-delta tracking in an in-memory working buffer. Overlapping spans abort atomically (`[E_BATCH_ABORT]`) before touching disk.
- **Persisted Undo**: `undo_last_edit` restores exact file content, BOM, line endings, and original anchors, persisting across session restarts.
- **Formatter-Tolerant**: ASCII-whitespace canonicalization preserves anchors across editor format-on-save cycles while retaining token-level sensitivity.

---

## Quick Start

### Installation

```bash
# From npm
pi install npm:pi-better-edit

# From GitHub
pi install git:github.com/Rianico/pi-better-edit

# From local directory
pi install /path/to/pi-better-edit
```

Zero configuration required. `pi` automatically activates the extension on start.

| Runtime Requirement | Supported Version |
| --- | --- |
| Node.js | &ge; 22.19.0 |
| `pi-coding-agent` | &ge; 0.75.0 (peer dependency) |

### How It Works

#### 1. Read the file
`read` returns each line prefixed by a stable 3-character hash anchor:

```text
ve7│function hello() {
szJ│  console.log("world");
kQm│}
```

#### 2. Apply an edit
`edit` targets inclusive anchor bounds using the canonical named-object payload:

```json
{
  "file": "src/main.ts",
  "edits": [
    {
      "anchor_from": "szJ",
      "anchor_to": "szJ",
      "replace_with": "  console.log('hi');\n"
    }
  ]
}
```

#### 3. Receive the diff with fresh anchors
The tool applies the edit and returns a unified diff showing fresh anchors for subsequent edits—eliminating the need for follow-up `read` calls:

```text
- szJ │   console.log("world");
+ a3m │   console.log('hi');
  kQm │ }
```

#### 4. Batch multiple edits atomically
Batch up to 32 edits to the same file in a single transaction. If any edit fails or overlaps, none write:

```json
{
  "file": "src/main.ts",
  "edits": [
    { "anchor_from": "a1b", "anchor_to": "a1b", "replace_with": "// Header comment\n" },
    { "anchor_from": "c3d", "anchor_to": "c3d", "replace_with": "  return true;\n" }
  ]
}
```

---

## Systematic Architecture

`pi-better-edit` v2 replaces ad-hoc string matching and heuristic healing with a formal Multi-Version Concurrency Control (MVCC) architecture.

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                STORAGE TIER                                      │
│  src/hash-store.ts & src/snapshot-store/                                         │
│  - file_snapshots: CAS snapshots (snapshot_id, path, snapshot_hash, line_count)   │
│  - line_lineage: Coordinate authority (snapshot_id, line_number) -> (line_id)    │
│  - line_id_counters: Monotonic integer block allocator per path                 │
│  - served_leases: Session-keyed immutable leases (session_id, path, anchor)     │
│  - file_undo: Snapshot-pinned undo history surviving restarts                    │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│                                SESSION TIER                                      │
│  src/served-session/session.ts                                                   │
│  - Leases: Granted on read, diff, rejection fresh-reads, and undo               │
│  - Immutability: Leases are strictly READ-ONLY during edit resolution            │
│  - Re-Serve Upsert: Atomic upsert updates leases when presentation changes       │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│                       RESOLUTION & REBASE TIER                                   │
│  src/hashline/lease-resolve.ts & src/hashline/served-verification.ts             │
│  - On-Demand CAS Materialization: Materializes current disk state                │
│  - Patience LIS Pin Backbone: O(m log m) non-crossing line alignment             │
│  - Minimal Displacement Tie-Breaking: Deterministic unique pairing               │
│  - Span Contiguity Gate: Asserts interior span is not torn                       │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│                                MUTATION TIER                                     │
│  src/mutation-engine/pipeline.ts & src/hashline/apply.ts                         │
│  - Working Buffer: Preceding delta rebase for multi-item batches                 │
│  - WAL Lineage Commit: Atomically commits final snapshot and updates leases      │
│  - Fail-Closed Intercepts: Rejections emit fresh read ranges                     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 1. Immutable Line Identity & Leases
- Every line has an immutable surrogate key (`line_id`) allocated from a monotonic counter (`line_id_counters`).
- When lines are delivered to an agent via `read`, diffs, or fresh-read rejections, a session-scoped lease (`served_leases`) binds `(session_id, file_path, anchor) -> line_id`.
- During an `edit`, lease lookups are strictly **read-only**. An edit cannot re-stamp or guess a lease.

### 2. Multi-Version Snapshot Lineage
- Content-addressed CAS snapshots (`file_snapshots`) track each materialized file version.
- `line_lineage` maps each line coordinate to its immutable `line_id`, 32-bit canon hash, and verbatim presentation anchor.
- When disk content shifts externally, the tool pairs the latest snapshot ($S_{latest}$) with disk using Patience LIS alignment, preserving identities for surviving lines and allocating fresh IDs only for novel lines.

### 3. Patience LIS Pin Backbone ($O(m \log m)$)
- Uniquely matching anchor pins form candidate pairs.
- The engine computes the Longest Increasing Subsequence (LIS) via patience sorting in $O(m \log m)$ time.
- Multiple maximal LIS candidates are disambiguated by minimal total displacement ($\sum |p_i - c_i|$).
- Contested symmetric swaps (e.g. equal-length function swaps) or ambiguous duplicate blocks fail closed, marking affected lines as retired rather than guessing.

### 4. Working Buffer with Preceding Deltas
- Multi-item batches (`edits: [e_0, e_1, ...]`) resolve their baseline coordinates $s'_k$ in the current snapshot.
- Active in-memory buffer positions are computed by accounting strictly for preceding edits:
  $$\Delta_k = \sum_{j < k, s'_{end, j} < s'_{start, k}} \left( |R_j| - (s'_{end, j} - s'_{start, j} + 1) \right)$$
- If any two edit items overlap or nest, the batch aborts atomically (`[E_BATCH_ABORT]`) before modifying disk.

### 5. Unified Span Verification (ADR-0023)
- `resolveLeasedEdit` verifies the entire span against `line_lineage` before touching disk.
- Canon evidence is file-scoped and verified via 32-bit digests (`canon_hash`), eliminating duplicate plaintext storage.

---

## Tools

| Tool | Parameters | Description |
| --- | --- | --- |
| `read` | `file`, `offset` (1-based), `limit` | Returns file content formatted as `HASH│content`. Lines &gt;200KB are replaced with a marker hint. |
| `read_skill` | `file` | Reads file content as plain text without hash prefixes or lease recording (ideal for prompts, docs, and skills). |
| `edit` | `file`, `edits`, `mode` (optional) | Applies single or batched edits atomically. Each edit targets `anchor_from` and `anchor_to` inclusive. `mode: "literal"` declares verbatim text. |
| `undo_last_edit` | `file` | Restores the previous file state, BOM, line endings, and original anchors. Persists across restarts. |

### Payload Contract

```json
{
  "file": "src/example.ts",
  "edits": [
    {
      "anchor_from": "a1b",
      "anchor_to": "c3d",
      "replace_with": "const status = 'ready';\n"
    }
  ],
  "mode": "general"
}
```

- `file`: Path to the target text file (must be a file, never a directory).
- `edits`: Array of 1 to 32 edit items. An empty `replace_with` string deletes the targeted range.
- `mode`: `"general"` (default) refuses text containing served anchor prefixes; `"literal"` allows verbatim insertion of lines beginning with `HASH│`.

---

## Error and Warning Contract

`pi-better-edit` enforces a strict, machine-actionable diagnostic contract ([ADR-0021](docs/adr/0021-unified-error-and-warning-contract.md)):
- `[E_*]` indicates an edit **rejection** — nothing was written to disk.
- `[W_*]` indicates an **applied mutation** with an informational warning.
- Range-family rejections carry structured `details.cause` values (`retirement`, `never-served`, `served-range staleness`, `tombstone`).

### Domain Rejections (`[E_*]`)

| Error Code | Description | Remedy / Agent Action |
| --- | --- | --- |
| `[E_BAD_PAYLOAD]` | Payload fails schema validation (missing fields, wrong types). | Correct payload structure to match `{ file, edits }` schema. |
| `[E_MALFORMED_ANCHOR]` | Anchor is not a bare 3-char string (e.g. includes `│` or diff prefixes). | Pass bare 3-char anchor (e.g. `"szJ"`) and retry. |
| `[E_STALE_ANCHOR]` | Anchor no longer resolves to its leased identity in the file. | Retry using the fresh rows provided in the rejection. |
| `[E_UNKNOWN_ANCHOR]` | Anchor has no active lease in any file for this session. | Re-read the file to establish fresh anchor leases. |
| `[E_FOREIGN_ANCHOR]` | Anchor is leased for a different file than the targeted one. | Ensure anchors match the target file path. |
| `[E_STALE_RANGE]` | A line in the edit range changed on disk or was never served. | Current range served as a fresh read; decide next edit from fresh rows. |
| `[E_UNVERIFIED_RANGE]` | One boundary lease retired while surviving bound is live and unshifted. | Named window served as fresh read; decide next edit from fresh rows. |
| `[E_TARGET_LOST]` | Target line identity deleted or reordered without a stable anchor bound. | Range cannot be served; re-read file and re-target. |
| `[E_SUSPICIOUS_TEXT]` | Replacement text contains a line matching a served `HASH│` anchor. | Strip copied tool output anchors or pass `mode: "literal"`. |
| `[E_BATCH_ABORT]` | Two or more items in the batch target overlapping or nested spans. | Merge overlapping spans into a single item or split into separate calls. |
| `[E_NOOP_LOOP]` | Identical edit producing no changes submitted 3 consecutive times. | Inspect current range; range already contains target content. |
| `[E_EMPTY_RANGE]` | Edit would result in an empty non-empty file. | Use `write` to truncate or delete file contents. |
| `[E_NOT_FOUND]` | Target file does not exist on disk. | Verify path using `ls` and retry with corrected path. |
| `[E_ACCESS]` | Target file is unreadable, unwritable, or in a symlink loop. | Correct permissions or resolve symlink loop. |
| `[E_UNSUPPORTED_FILE]` | Target path is a directory, binary file, image, or UTF-16/32 text. | Hashline editing only targets UTF-8 text files. |
| `[E_UNDO_STALE]` | Target file was modified or deleted after the last edit. | Undo refused to prevent data loss; re-read file. |
| `[E_UNDO_UNAVAILABLE]` | Undo state could not be persisted to SQLite store. | Edit was refused and file unchanged; retry edit. |
| `[E_LARGE_FILE]` | File exceeds the 238,328-line ceiling of 3-char base62 space. | Use `write` or non-hashline tools for very large files. |
| `[E_UNKNOWN]` | Unexpected filesystem or invariant failure. | Check error message details. |

### Applied Warnings (`[W_*]`)

| Warning Code | Audience | Description |
| --- | --- | --- |
| `[W_NEVER_SERVED_SHAPE]` | `[MODEL]` | Replacement line starts with an anchor-shaped token never served. Applied verbatim. |
| `[W_SERVED_PREFIX_MISMATCH]` | `[MODEL]` | Replacement line starts with a served anchor but content differs. Applied verbatim. |
| `[W_REVERSED_ANCHORS]` | `[USER]` | `anchor_from` and `anchor_to` were provided in reverse order. Swapped and applied cleanly. |
| `[W_UNICODE_LITERAL]` | `[USER]` | Literal `\uDDDD` sequence detected in replacement. Applied verbatim. |
| `[W_LITERAL_BYPASS]` | `[USER]` | Served hash echo check bypassed via explicit `mode: "literal"`. |
| `[W_NOOP]` | `[USER]` | Edit produced no file changes; warning emitted on 2nd occurrence. |

---

## Comparison

### Capability Comparison

| Feature | **pi-better-edit v2** | @oh-my-pi/hashline | Traditional `str_replace` |
| --- | --- | --- | --- |
| **Addressing Model** | 3-char content-addressed anchors | File tag + line numbers | Verbatim code strings |
| **Line Identity** | Immutable MVCC `line_id` | Coordinate line numbers | None (text matching) |
| **Exterior Shift Tolerance** | **Auto-rebases** (0 tokens, 0 retries) | Model must recalculate line numbers | Fails if surrounding context shifts |
| **Duplicate Line Safety** | **Collision-resolved** unique anchors | Ambiguous position-based indexing | Prone to matching wrong instance |
| **Concurrent Disk Drift** | **Fail-closed reject-and-serve** | Tag mismatch / best-effort 3-way merge | Silent overwrite or blind failure |
| **Batch Support** | **Atomic** up to 32 items with delta shifts | Multi-section patch preflight | Sequential individual calls |
| **Undo Persistence** | **Survives restarts** (CAS snapshot pinned) | None | None |
| **Session Isolation** | Session-keyed leases (`served_leases`) | None | N/A |
| **Deterministic Battery** | **23/23** pass rate | 10/10 library seam | N/A |

### Edge Case Behavior

| Edge Case Scenario | pi-better-edit v2 | @oh-my-pi/hashline |
| --- | --- | --- |
| **Wrong Coordinate / Off-by-one** | **Impossible**: Anchors bind to `line_id`; verified against lineage before writing. | **Possible**: Wrong line number against a valid tag silently mutates the wrong code. |
| **Lines Inserted Above Target** | **Auto-rebases cleanly**: Identity is decoupled from coordinates. | **Every edit renumbers**: Agent must track offsets. |
| **Deleted Function Guard Target (Probe E)** | **Fail-closed intercept**: Rejects edit; zero code corruption. | Tag mismatch / merge hazard. |
| **Equal-Length Symmetric Function Swap (Probe K)**| **Fail-closed intercept**: Contested reorder retires safely. | Applies to wrong block or requires manual recovery. |
| **Batch Items Overlap** | **Atomic abort** (`[E_BATCH_ABORT]`); nothing written. | Preflight validation failure. |

---

## Reproducible Benchmarks

All claims are backed by deterministic verification batteries and reproducible benchmarks.

### 1. Deterministic Tool Battery (23 Scenarios)

The tool battery executes 23 complex edge-case scenarios (concurrent exterior inserts, duplicate function blocks, interior modifications, symmetric reorders, and batch interactions) without LLM sampling:

| Test Suite | Result | Silent Data Loss |
| --- | :---: | :---: |
| **pi-better-edit v2** | **23/23** | **0** |

Reproduce locally:
```bash
pnpm run eval
```

### 2. Practical Coding-Agent Benchmark

Measures a realistic refactoring workflow in `pi` with model thinking enabled (`opencode-go/gpt-5.6-luna`), testing recovery from external drift:

| Editing Tool | Tool Calls | Total Tokens | Token Savings vs Baseline | Correctness |
| --- | :---: | :---: | :---: | :---: |
| OMP Patch Wrapper | 6 | 28,467 | Baseline | &#x2705; |
| **pi-better-edit v2** | **3 (fewest)** | **12,593** | **-55.8%** | &#x2705; |

Reproduce locally:
```bash
pnpm run benchmark:practical
```

### 3. Theoretical Envelope Savings

Measures raw payload serialization overhead across a pinned 12-edit corpus:
- **Single edit**: -40.0% token overhead vs `str_replace`.
- **Multi-item batch**: -42.7% token overhead vs `str_replace`.

Reproduce locally:
```bash
pnpm run benchmark:tokens
```

---

## How Anchors Work

1. **Whitespace Canonicalization**: Each line is stripped of ASCII whitespace (`[ \t\r\n]`) before hashing. External formatting passes (`prettier`, `black`, `eslint --fix`) do not alter line hashes. Token-level edits (quotes, semicolons, variable names) rotate the hash.
2. **xxHash32 & Base62 Space**: Canonical lines are hashed using xxHash32 and mapped to 3-character base62 strings (`A-Za-z0-9`), providing $62^3 = 238,328$ unique anchors.
3. **Collision-Free Coprime Probing**: When duplicate lines occur in a file, collision resolution probes using a stride coprime to the hash space ($62^2 + 62 + 1 = 3,907$). Every line in a file receives a unique anchor.
4. **SQLite WAL CAS Storage**: Line hashes and snapshots are persisted in `~/.config/pi-better-edit/hash-store.sqlite` (honoring `XDG_CONFIG_HOME`). Snapshot retention is governed by proportional LRU vacuuming under a 50MB budget.

---

## Upgrading from 1.x

Version 2.0 represents a major architectural upgrade from heuristic healing to formal MVCC:

1. **Heuristic Healing Deleted ([ADR-0016](docs/adr/0016-content-addressed-line-identity-supersedes-healing.md))**: Heuristic guessing of relocated anchors (`tryHealOrphanedSpan`) is completely removed to eliminate silent miswrites on duplicate code.
2. **Boundary Rule Replaces E_UNSERVED_RANGE ([ADR-0020](docs/adr/0020-unverified-range-replaces-unserved-range-boundary-rule-for-retired-identities.md))**: The old `E_UNSERVED_RANGE` code is retired. If one boundary lease is retired while the other survives unshifted, the tool emits `[E_UNVERIFIED_RANGE]` with a fresh read. If both bounds are lost, it emits `[E_TARGET_LOST]`.
3. **Unified Diagnostic Contract ([ADR-0021](docs/adr/0021-unified-error-and-warning-contract.md))**: Rejections use `[E_*]`; successful mutations with caveats use `[W_*]`. Structured diagnoses live in `details.cause`.
4. **Additive Store Migration**: The SQLite schema migrates additively from version 6 to 7. Existing project files are untouched.

---

## Development

```bash
# Install dependencies
pnpm install

# Run unit and integration tests
pnpm test

# Run quality checks
pnpm run lint
pnpm run format
pnpm run typecheck

# Run evaluation batteries
pnpm run eval
```

---

## License

[MIT](LICENSE)

## Acknowledgments

- [**Can Bölük**](https://stencil.so/blog/the-harness-problem) for seminal insights on *The Harness Problem*.
- [**@oh-my-pi/hashline**](https://github.com/can1357/oh-my-pi/tree/main/packages/hashline) by can1357 for pioneering the hashline patch concept.
- [**pi-hashline-edit**](https://github.com/RimuruW/pi-hashline-edit) by RimuruW and [**pi-hashline-edit-pro**](https://github.com/YuGiMob/pi-hashline-edit-pro) by YuGiMob for foundational agent extension designs.
