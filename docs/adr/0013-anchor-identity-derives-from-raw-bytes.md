# ADR-0013. Anchor Identity Derives From Raw Bytes; the Canon Is an Alignment Digest

Date: 2026-11-03

## Status

Accepted

Amends [0002. Tokenizer-Stable 4-Character Anchors, Canon v3 Whitespace Class, and File-Scoped Allocator](0002-tokenizer-stable-4-character-anchors-canon-v3.md): decision item 2 (canon before hashing) and item 5 (the cache-invalidation axis) no longer describe the anchor's derivation.

Relates to [10. The Line Canon Stays a Pure Function of One Line](0010-the-line-canon-stays-a-pure-function-of-one-line.md): this resolves its deferred option, differently — the canon is kept, and identity simply stops using it.

Relates to [9. Invisible-Codepoint Disclosure Lives on the Edit Path](0009-invisible-codepoint-disclosure-lives-on-the-edit-path.md), whose disclosure stays the edit path's report of a substitution.

## Context

`canon(line)` answered two different questions with one digest.

1. **"Is this the same line?"** — identity: the digest that derives the served anchor.
2. **"Did this line survive a reformat?"** — alignment: the digest `pairSnapshots` aligns two snapshots on, and the digest the stat-matched page gate, drift and the write-hook `served hash echo` check compare.

One digest cannot serve both, because the answers differ. Alignment must be conservative: a formatter re-indents and respaces, so the alignment digest has to fold whitespace everywhere, and it does — the frozen 28-code-point class ([ADR-0002](0002-tokenizer-stable-4-character-anchors-canon-v3.md), amended by [ADR-0029](../.archive_adrs/0029-canon-v3-frozen-whitespace-class.md)). Identity inherited that fold, and the fold makes identity over-broad in two measured ways.

**Two lines that are not the same line share one identity.** The canons of `const s = "a`+NBSP+`b";`, `const s = "a b";` and `const s = "ab";` are the byte-identical string `consts="ab";` (measured). Derived alone, each of the three spells the same anchor `BDXy`; inside one file the allocator's positional probe hands the second and third a spelling that depends on their siblings (`BDXy`, `BEYz`, `BFZ0`, measured before this change). An anchor was therefore not a function of its line.

**A canon-unchanged edit rotates the anchor to a probe spelling.** A model reads a line, writes the same line with its NBSP replaced by a space, and the row it reads back carries a spelling the allocator probed out, not the one its content derives (measured: the diff served `gSCB` while the line's own bytes derived `rOY9`; ticket #233). The anchor a model holds after an edit is not the anchor its line has.

The measurement is a probe, not a proof: the residue is exactly the case where two lines' canons fold together, and the fold is deliberate. Narrowing the class was already rejected on measurement ([ADR-0010](0010-the-line-canon-stays-a-pure-function-of-one-line.md)), and making the canon position-aware was rejected on an invariant, because a line's identity must be computable from that line alone.

## Decision

We will derive the anchor from the line's **raw bytes**, and keep `canon` as an alignment and verification digest only.

1. **Identity keys on the raw line.** Every anchor base index flows through `fileBaseIndex(rawLine, pathSeed)` (file-scoped) or `contentBaseIndex(rawLine)` (content-only), and survivor matching keys on the raw line too: `newLineAssigner`, `fileScopedHashes`, `buildNewByContent`, `reuseSurvivorHashes` and `allocateFreshHashes` in `src/hashline/hash-identity.ts`. Two lines that differ in any byte are two identities, and an anchor is a function of its own line.
2. **The raw line is the materialized line.** The load path strips a BOM and normalizes CRLF/CR to LF before any hashing (`decodeNormText`, `src/file-content/loader.ts`), and the model never sees the pre-normalization bytes, so "raw" means byte-for-byte as materialized. Line-ending style therefore still does not move an anchor, and neither does a BOM.
3. **`canon`, `canonDigest`, `CANON_RE` and `CANON_VERSION` are unchanged.** They keep serving alignment (`pairSnapshots`), the stat-matched page gate (`src/file-content/preview.ts`), drift (`src/drift.ts`) and the write-hook `served hash echo` check (`findServedHashEcho`). The canon is not position-aware and is not narrowed.
4. **`ANCHOR_GENERATION` moves 1 → 2.** It is the only axis covering the `(path, content)` seeding, and the seeding input changed, so every anchor-bearing artifact must be invalidated. `CANON_VERSION` does not move: the canon did not change, and a canon-only change must stay able to miss the cache without invalidating anchor state.
5. **Formatter tolerance stays where it already lives.** A pre-rewrite anchor still applies after an external whitespace-only rewrite, because the lease binds that anchor to an immutable `line_id` and the rebase aligns the two snapshots on canon digests; a token change still rejects with `[E_TARGET_LOST]`. What survives a format pass is the lease, not the spelling.

### Considered Options

- **Narrow the whitespace class so identity stops folding** — rejected in [ADR-0010](0010-the-line-canon-stays-a-pure-function-of-one-line.md) on measurement, and it would not have fixed this: `const s = "a`+NBSP+`b";` and `const s = "a b";` differ by a code point the class exists to fold, and any class wide enough for formatter churn folds it.
- **Make the canon position-aware** — rejected in [ADR-0010](0010-the-line-canon-stays-a-pure-function-of-one-line.md) on an invariant: a stored digest is re-derived from a single line, so identity cannot depend on a line's neighbours.
- **Hash the on-disk bytes, CRLF and BOM included** — rejected: the load path normalizes both before hashing, and the model edits the normalized text. Hashing the pre-normalization bytes would make an anchor depend on a byte the model was never served.
- **Keep one digest and absorb the over-broad identity at the lease seam** (the deferred option in [ADR-0010](0010-the-line-canon-stays-a-pure-function-of-one-line.md)) — not taken: it preserves the over-broad identity and pays for it at every read. The two questions are separable at the derivation seam for one parameter, so they are separated there.
- **Bump `CANON_VERSION` instead of `ANCHOR_GENERATION`** — rejected: it would invalidate canon-derived state (the page gate, drift, the write-hook `served hash echo` check) that did not change, and it would leave the anchor axis unable to record the change it just made.

## Consequences

- **An anchor rotates when its line's bytes change, whitespace included.** `const s = "a`+NBSP+`b";` and `const s = "a b";` are two identities, and the substituted line reads back under its own content-derived anchor. This is the point of the record: the anchor is now a function of its line.
- **A pre-rewrite anchor still applies after a format pass**, because resolution tracks the leased `line_id` and not the spelling. The measured table in the README stands unchanged; only its explanation moves from "the canon folds whitespace into the anchor" to "the lease survives the rewrite".
- **The substitution is no longer silent at the anchor.** The edit still applies (it is permissive by design, [ADR-0009](0009-invisible-codepoint-disclosure-lives-on-the-edit-path.md)), the edit-path disclosure reports the code point, and the pre-substitution anchor now rejects `[E_TARGET_LOST]` instead of resolving to a line whose bytes moved (measured).
- **Harder, and accepted:** every anchor-bearing artifact is invalidated once by the generation bump, and a model that re-reads a re-indented file sees different anchors for the same lines. Nothing else moves — no payload shape, no config key, no error code, and no store schema.
- **Harder, and accepted:** the canon can no longer be read as an identity function. Its whitespace blindness remains a property of the alignment digest, and code must not treat it as a guard ([ADR-0010](0010-the-line-canon-stays-a-pure-function-of-one-line.md)).
- **Load-bearing assumption, confidence high:** the alignment digest must stay conservative while identity stays exact, because formatters churn whitespace in 93 %–98 % of the lines they touch and the two consumers need opposite answers. Revisit only if alignment stops needing a whitespace-blind digest.
- Deep analysis: [`docs/articles/formatter-whitespace-churn-js-ts.md`](../articles/formatter-whitespace-churn-js-ts.md). Issues #230, #233.

### Measurement

The before/after pairs this record rests on, all on this worktree, before the change unless stated:

| Probe | Before | After |
| :--- | :--- | :--- |
| The three canon-equal lines, derived alone | `BDXy`, `BDXy`, `BDXy` | `ALH5`, `AXEh`, `AiAH` |
| The same three lines, in one file | `BDXy`, `BEYz`, `BFZ0` | `ALH5`, `AXEh`, `AiAH` |
| `#233`: the diff row after an NBSP → space edit vs the line's own derivation | `gSCB` vs `rOY9` | equal |
| The pre-substitution anchor after that edit | resolved to the substituted line | `[E_TARGET_LOST]` |
| A pre-rewrite anchor after an external whitespace-only rewrite | applied | applied |
| A pre-rewrite anchor after an external token change | `[E_TARGET_LOST]` | `[E_TARGET_LOST]` |

The content-only spellings are environment-independent (`contentBaseIndex` has no path seed); the file-scoped rows are path-seeded and were measured through the tool seam on a temp path.
