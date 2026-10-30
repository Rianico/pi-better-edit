# Benchmarks & Edge-Case Evaluation

This document provides in-depth edge-case behavior analyses, recovery evaluations, and independent benchmark observations for `pi-better-edit`. For the high-level capability matrix and core token economy comparison, see the [Root README](../../README.md#comparison).

---

## 1. Edge Case Behavior Matrix

| Edge Case Scenario | pi-better-edit v2 | Coordinate-based tags (@oh-my-pi/hashline) | Search-and-replace (`str_replace`) |
| :--- | :--- | :--- | :--- |
| **Off-by-one / Line Drift** | **Impossible**: Anchors bind to monotonic `line_id`; verified against lineage. | **Coordinate sensitive**: Wrong line number against a valid tag targets incorrect line. | N/A (substring matching) |
| **Lines Inserted Above Target** | **Auto-rebases cleanly**: Identity is decoupled from coordinates. | **Offset tracking required**: Subsequent line numbers shift down. | Fails if surrounding context lines shift. |
| **Deleted Function Guard Target (Probe E)** | **Fail-closed intercept**: Rejects edit; zero code corruption. | Tag or coordinate mismatch refusal. | Fails to match or matches duplicate signature. |
| **Equal-Length Symmetric Function Swap (Probe K)**| **Fail-closed intercept**: Contested reorder retires safely. | Coordinates apply to newly placed block. | Replaces first occurrence matching string. |
| **Batch Items Overlap** | **Atomic abort** (`[E_BATCH_ABORT]`); zero bytes written. | Preflight validation rejection. | Sequential application risk. |
| **External Formatter Run (Prettier/Black)** | **Whitespace-tolerant**: Frozen 28-code-point class keeps anchors intact. Formatter rewrites normalizing U+200B ZWSP to space rotate anchor and fail closed safely. | Tag invalidation on modification. | Whitespace mismatch breaks string search. |

---

## 2. Independent Benchmark: Explicit Edit Benchmark

[**Explicit Edit Benchmark**](https://github.com/alexshpunt/explicit-edit-benchmark) is an independent, community-run evaluation suite that scores AI harnesses and file-editing extensions across 226 byte-exact edit tasks (replacements, insertions, deletions, block moves, cross-file copies, Unicode handling, and large files).

### Results & Attribution Disclosure

| Observation Surface | Score / Metric | Configuration Details |
| :--- | :--- | :--- |
| **Published HF Badge** | **98.6%** | `harnessFamily: pi-better-edit` (published badge score) |
| **Evaluation Arm Quality Score** | **95.9%** | Pinned to `pi-better-edit@1.7.0`, 226 tasks |
| **First-Attempt Exact Match** | **94.7%** | Single tool-call zero-shot accuracy |
| **Exact After Recovery** | **99.6%** | Recovered via reject-and-serve in 1 turn |
| **Benchmark Configuration** | 226 tasks · Pi 0.85.1 · `gpt-5.6-luna` (low reasoning) | Published observation row |

> [!NOTE] Benchmark Lineage & Attribution Caveat
> The detailed 226-task evaluation row (`0.95907… / 0.94690… / 0.99557…`) is pinned to `pi-better-edit@1.7.0` (the predecessor heuristic version) and is also recorded under `pi-agent-ide@0.2.2`. The current v2 MVCC architecture eliminates remaining duplicate-line edge cases through formal lease lineage. The live published dataset badge reflects **98.6%** for the `pi-better-edit` harness family.

### Scoring Methodology
- **Task Coverage**: 226 deterministic tasks designed to test multi-point edits, formatting invariance, and edge cases.
- **Metric Formulation**: $\text{Score v2} = \text{coverage} \times \text{quality}$, where $\text{quality} = 0.75 \times \text{first\_exact} + 0.25 \times \text{final\_exact}$.
- **Recovery Turn**: Reject-and-serve provides the model with current on-disk rows immediately in the error response, resolving 99.6% of recoverable tasks on the subsequent attempt.

### Resources & Verification
- [HuggingFace Benchmark Explorer](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Api-better-edit%40latest)
- [Raw Observation Datasets](https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark)
- [Contribute a Run](https://github.com/alexshpunt/explicit-edit-benchmark/blob/main/docs/running.md):
  ```bash
  npm run benchmark:extension:submit -- --extension pi-better-edit --auth-file ~/.pi/agent/auth.json
  ```
