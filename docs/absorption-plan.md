# Hashline-Edit Absorption Plan (side conversation)

**Status:** resolved in [ADR-0006](adr/0006-compact-json-edit-payload.md): absorb oh-my-pi's envelope efficiency through a compact JSON tuple, while retaining this project's verified edit protocol.

## Context

Side discussion comparing three hash-anchor editing implementations for LLM coding agents:

- **oh-my-pi** — line numbers + whole-file 4-hex hash tag
- **pi-hashline-edit** — `LINE#HASH` per-line, context-based hashing
- **pro** (this project, pi-hashline-edit-lsz) — bare 3-char per-line hashes, persistent store, stable for unchanged lines

## Key decisions & insights

### 1. Anchor invalidation semantics

- **oh-my-pi**: Any change anywhere → whole-file tag mismatch; recovers via 3-way merge / session replay
- **pi-hashline-edit**: Editing line N only invalidates anchors for N−1, N, N+1 (context-based)
- **pro**: Unchanged lines keep stable hashes; no reread needed.
- None of the three verify the interior of a replace range — the gap addressed by issue #22.

### 2. 3-way merge recovery mechanisms

- **pi-hashline-edit**: genuine unified-diff 3-way merge (jsdiff, fuzz 0 = never slides), multi-version snapshot LRU (8 paths × 4 versions), replays the edit against the snapshot then merges onto live content
- **oh-my-pi**: line-diff remap of anchors + replay; requires uniform offset shift; validates context for ambiguity
- **Neither modifies LLM context nor invalidates LLM cache** — pure file-level operations. Only consequence: the model's earlier `read` output becomes stale; the tool can only return a diff, it cannot rewrite the model's belief.

### 3. Token economics comparison

- **Per read line**: oh-my-pi wins (~2 chars `1:`) vs pro (4 chars) vs pi-hashline-edit (~7–9 chars)
- **Per edit request**: oh-my-pi's terse patch grammar cheapest; pro's bare 3-char hashes = 1 token each
- **Rereads avoided (dominant cost)**: **pro wins** — persistent store keeps unchanged-line hashes stable; issue #22 eliminates the last defensive rereads
- **Verdict**: oh-my-pi optimizes patch language, pro optimizes protocol. For LLMs, the protocol is the right place (no silent relocation, fail-closed).

### 4. Patterns absorbable into pro

**Strong absorption candidates:**

1. **seenLines provenance** (oh-my-pi) — track which lines a read actually displayed; reject hunks touching unseen lines. Answers issue #22's open question #2 (reject-and-serve vs skip)
2. **Multi-version served-state history** (pi-hashline-edit) — 8×4 version LRU for "weak models reuse anchors from several reads ago"; solves which served-state counts. Key insight: **"last served" is per-line, not per-file**
3. **Drift-source classification** (oh-my-pi) — distinguish external change vs. the model's own edits in errors; makes feedback actionable
4. **Atomic batch preflight** (oh-my-pi) — validate ALL edits before ANY write; enabled by issue #22's interior verification. Converts pro's one-edit-per-call discipline into a cost-free batch
5. **Noop-loop guard** (pi-hashline-edit) — 3 identical no-ops throw an error; `appliedPayloadTracker` detects re-sent payloads

**Conditional (propose, don't apply):**

- Fuzz-0 merge as a *confirmation proposal* showing a diff, not auto-applying
- Anchor-emitting grep/search tools

**Rejected (conflicts with philosophy):**

- Block ops / registers / patch grammar (oh-my-pi)
- Silent remap recovery — violates "no silent relocation"
- Context-based hashing, fuzzy string matching

### 5. Where each candidate plugs into pro's codebase

| Candidate | Plugs into |
| --- | --- |
| seenLines provenance | `read` / `file-reader.ts`; reject unseen-line hunks in `valEdit` (`src/hashline/resolve.ts`) |
| Multi-version served-state history | `hash-store.sqlite` — new `served` table with an 8×4 LRU |
| Drift-source classification | `replace` error reporting (external change vs own-edit diff) |
| Atomic batch preflight | `execPipeline` / `withFileMutationQueue` (`src/replace.ts`) |
| Noop-loop guard | noop path `buildNoop`; payload tracker in `replace.ts` |

## Key risks / open questions

- **Interior-of-range verification gap** (issue #22) — the central hole; no generation verifies unserved interior lines
- **Stale model context**: no tool can rewrite what the model believes, only verify what it submits
- **Silent recovery hazards**: a "successful" misapplied merge corrupts both the file and the model's mental model

## Action items / sequencing

1. **Land issue #22 first** → items 1 and 2 become data-model design parameters within it
2. Item 4 (batch preflight) becomes safe once #22's interior verification exists
3. Item 5 (noop guard) is shippable anytime — a day's work

## Resolved calling contract

The project reduces JSON envelope cost without adding tools or adopting a textual patch language. The single `edit` payload is `[path, [remove_from, remove_to], replacement_text]`; `path` is a string or `null` for anchor-based path inference, and the anchor range is inclusive. The `batch_edit` payload is a root array of those tuples. Both forms normalize through the existing served-state verification and atomic batch pipeline.

The old named-object payload is not retained, and no format configuration is exposed. Unified diff remains a possible future interoperability adapter, not an alternate mutation contract; block operations, registers, silent remapping, and fuzzy recovery remain rejected.
