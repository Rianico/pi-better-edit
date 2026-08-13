# Fitting pi-hashline-edit-lsz to "Hash anchors + Myers diff + single-token anchors"

**Status:** analysis / design review
**Source:** [Hash anchors + Myers diff + single-token anchors: 60% cheaper AI code edits](https://dirac.run/posts/hash-anchors-myers-diff-single-token) (Dirac Posts)
**Scope:** how this repo's hash-anchored `read`/`edit`/`undo` tools measure up against the article's design principles.

---

## 1. The article, in brief

The post proposes a code-editing mechanism for LLM agents that replaces search-and-replace tool calls — where the model must echo the old code token-for-token before stating the replacement — with **anchored edits**: the model pinpoints lines by short labels, and the tool call carries only the replacement. The headline effect is that edit output shrinks from `O(S+R)` (search block + replacement) to `O(R)` (replacement only), and since output tokens cost 5–6× input tokens, this is where the savings live.

The article walks through the earlier "Hash Anchored Edits" idea (Can Bölük's *The Harness Problem* — the same lineage this repo descends from via oh-my-pi), identifies two concrete problems with it, and then re-derives the mechanism from first principles as five requirements:

1. **Anchor** — something that pinpoints any line in any file, deliberately *not* bound to line numbers.
2. **Delimiter** — a simple symbol separating the anchor from the code.
3. **Validator** — something that validates LLM-proposed edits.
4. **State Manager** — something that tracks which line of which file is assigned which anchor.
5. **Reconciler** — something that reconciles a file after edits, allocating new anchors to only the changed lines.

The two problems the article sets out to fix:

- **Read overhead.** The earlier format (`{line_number}:{2_char_hash}|`) costs 4–5 tokens per line, worth it only for proportionately large edits.
- **Line-number coupling.** Because the anchor encodes the line number, a single edit at the top of a file invalidates the hash of every subsequent line, forcing a full re-read.

Dirac's answers: single-token word anchors (a ~1,700-word vocabulary, state-assigned, shipped as an asset), `§` as delimiter, full-line string matching for validation, a task-scoped in-memory state manager, and the Myers diff as the reconciler that re-anchors only changed lines.

---

## 2. The verdict, up front

This repo fits every load-bearing design principle in the article. It solves both named problems by the same route the article takes — drop the line number from the anchor, make the anchor stable for unchanged lines, pay only `O(R)` on edits — but with a deliberate divergence in how anchors are derived, and with a validation layer that goes measurably beyond what the article describes.

| Article principle | Dirac's choice | This repo | Fit |
| --- | --- | --- | --- |
| Anchor | ~1,700 single-token words, state-assigned | 3-char content-derived xxHash32, 62³ space, unique per file by construction | same property, different derivation |
| Delimiter | `§` | `│` (U+2502) | same principle |
| Validator | string-match on full boundary lines | hash resolution + whole-span served-state verification, reject-and-serve | strictly stronger |
| State Manager | task-scoped in-memory maps + "used" list | persistent SQLite: snapshots + session-keyed served rows + undo | same role, more durable |
| Reconciler | Myers diff → new anchors for changed lines only | `mapStableHashes` (content-nearest mapping) + Myers `diffLines` for the preview | same contract, cheaper algorithm |

---

## 3. The five principles, one by one

### 3.1 Anchor

The article's key move is to sever the anchor from the line number entirely — "there is nothing in our requirements that forces the line numbers to be part of the anchor." Dirac achieves this by *state assignment*: a state manager hands lines labels from a fixed word vocabulary, and tracks the assignment. The article explicitly argues this is fine because "statelessness is not a prized attribute, particularly in AI agents that are already tracking a huge number of state variables."

This repo achieves the same *observable* property by a different route: content-derived hashes. Each line is canonicalized (carriage returns stripped, trailing whitespace trimmed) and hashed with xxHash32, then mapped onto a 3-character string over `A-Za-z0-9` (62³ = 238,328 anchors). Because a hash is a pure function of line content — not of position — an edit at the top of the file never disturbs the anchor of a line deeper down whose content is unchanged. Position-independence is achieved without a state manager in the anchor-assignment path.

Uniqueness is by construction. Collisions on the base hash are resolved from a bitset by probing with a stride coprime to the hash space (`src/hashline/hash.ts`), so two byte-identical lines (repeated `}`, repeated imports) never share an anchor, and consecutive collisions land on anchors that differ in all three characters. This buys two things Dirac has to bookkeep manually: there is no "used anchors" list, and there is no exhaustion problem — Dirac degrades from 1-token to 2-token anchors when its ~1,700 words run out; this repo simply has 238,328 anchors per file, which is also what sets the file-size cap.

The deeper consequence is that our anchors are **self-verifying**. The hash *is* a fingerprint of the line; validating an edit against a hash requires no separate lookup table to know whether the line changed — recompute the hash, compare. Dirac's word anchors carry no content information, which is precisely why its validator must fall back to string-matching the full boundary line.

Token cost is comparable: the article's read prefix is one word + one delimiter ≈ 2 tokens; ours is three mixed-case/digit chars + `│`, typically 1–2 tokens. The article's own 4–5-token complaint was about the line-number-plus-hash format; we dropped the line number just as Dirac did.

### 3.2 Delimiter

Same principle, different glyph. The article chose `§` as "any simple symbol that's preferably not used in coding." This repo chose `│` (U+2502, box-drawing light vertical) and documents the reasoning: it is visually distinct from the ASCII pipe so `|code` in shell or other languages is never confused with an anchor boundary, and the anchor alphabet deliberately excludes `-` and `_` because those are markdown-active at line start and shape-identical to diff-preview rows. Both choices are the same kind of decision, made with the same care about the LLM's tokenizer and the copy-paste surface.

### 3.3 Validator

This is where the repo is strongest relative to the article. The article's validator is boundary-only: "for an edit to be validated successfully, the code at the given line number has to match the hash on that line" — and in Dirac's actual tool call, the model supplies the full start/end lines and the backend string-matches them.

Here the validator is two layers:

1. **Anchor resolution** — `remove_from`/`remove_to` must resolve to exactly one current line (`[E_STALE_ANCHOR]` / `[E_AMBIGUOUS_ANCHOR]` otherwise). An anchor that cannot be resolved is rejected, never fuzzy-matched or silently relocated — the project's stated anchor philosophy.
2. **Served-state range verification** — every line of the resolved range must match what the tool actually delivered into the model's context (`verifyServedRange` in `src/hashline/served.ts`). A line inside the range that changed on disk since it was served is hard-rejected with `[E_RANGE_STALE]`; a line the model was never shown is `[E_RANGE_UNSERVED]`; a boundary anchor with no served position is `[E_RANGE_UNVERIFIED]`.

The served-state check is the article's validation concept taken to its logical end: if the point of validation is "the model is editing what it actually saw," then verifying only the two boundary lines is a two-line hole. An interior line could be changed on disk — a human edit, a formatter-on-save — while the boundaries sit untouched, and a boundary-only validator would silently destroy it. The range-span comparison closes that hole.

The failure loop is also strictly better. The article's failure mode is an error message telling the model the code changed since its last read — implying a re-read. Here the rejection **serves the current range back as fresh `HASH│content` rows that themselves count as serves**, so the retry needs no `read` (reject-and-serve). And per ADR-0001, the tool never asks the model to supply verification data (e.g. expected hashes) and accepts no force/asserted-serve override — the tool owns verification, the model owns intent, a boundary discipline the article gestures at but does not formalize.

### 3.4 State Manager

The article's state manager is task-scoped and in-memory: maps of every file read, a used-anchor list per file, fallback to 2-token anchors. The repo's is the same role, more durable and better partitioned:

- **Snapshots** — a persistent per-file, content-addressed cache of the hash list, keyed by `(path, checksum, line_count)`. Validity is guaranteed by the checksum matching the file bytes, so it is safe to share across sessions (ADR-0002); it is what keeps unchanged-line anchors stable across edits *and restarts*.
- **Served rows** — the mirror of what the model was shown, keyed by `(session_id, path)` with a TTL sweep. Session-keying means sub-agents, nested runs, and `pi -c` continuation each verify against their own record instead of wiping each other's (ADR-0002) — a concern the article's task-scoped design doesn't address at all.
- **Undo records** — per-file previous content with a drift guard, persisting across restarts.

### 3.5 Reconciler

The article's reconciler runs the Myers diff on changed files, assigns new anchors to only the changed lines, keeps a "current" view of every file, fires from a file-update hook when a human edits the file manually, and returns the updated anchors in the response to the LLM.

The repo's `mapStableHashes` (`src/hashline/hash.ts`) delivers the same contract with a cheaper mechanism. Because the edit range is already known from the anchors, a full-file minimal-edit-script is unnecessary: the mapping keeps the hashes of all lines outside the range unconditionally, carries surviving content onto its nearest matching position in the new file, recycles removed lines' hashes for re-inserted identical text ("edit X with X" doesn't rotate the anchor), and allocates fresh hashes only for genuinely new lines. The Myers diff (`diff.diffLines` from the `diff` package) still appears — in the post-edit diff preview, which computes the changed span and renders fresh anchor rows that count as serves. So Myers is used where GitHub-style diffing is wanted, and the cheaper content-nearest mapping is used where only "did this line survive?" matters.

After a successful edit the response carries the post-edit diff with fresh anchors, so the model can keep editing without a re-read — the article's "we send back the updated anchors in the response" verbatim.

The one place the reconciler is *less* aligned: external manual edits. The article fires the reconciler from a file-update hook — proactive re-anchoring the moment a human touches the file. Here recovery is lazy: an externally modified file fails the snapshot checksum and is re-hashed on the next read, and it fails served-state comparison at validation time (drift notices; `[E_UNDO_STALE]` guards undo). Same correctness guarantee — the tool never silently overwrites what the model didn't see — with at worst one extra reject-and-serve roundtrip.

---

## 4. The two named problems, and our answers

**Problem 1: 4–5 tokens of read overhead per line.** Solved the same way Dirac solved it: the line number is out of the anchor. The prefix is `3-char-hash│`, no number, no colon.

**Problem 2: line-number coupling invalidates the whole file on a top-of-file edit.** Solved: anchors are content-derived and position-independent, and the persistent snapshot store carries unchanged-line anchors across edits. An edit at line 5 leaves line 150's hash untouched, and the served state confirms the model still sees exactly what it was shown.

And the headline economics hold: edit output is `O(R)` — `{path, remove_from, remove_to, replacement_text}`, no echoed old code, so deletions are nearly free. In fact the repo is slightly more economical than Dirac on this axis: Dirac's tool call still carries the full boundary lines verbatim (the backend string-matches them), while here the model sends six characters of hashes.

---

## 5. The principled divergence: content-derived, not state-assigned

The article's most deliberate decision is the most debatable one: it *abandons* content-derived statelessness ("statelessness is not a prized attribute") in favor of state-assigned word anchors. This repo keeps content-derived hashes as the base and adds a state layer on top — a hybrid:

- The anchor mapping stays stateless: the hash of a line is a pure function of its content, so it is self-verifying and needs no state manager in the validation path.
- The state layer (persisted snapshots, served rows, undo) is where stability, session continuity, and verification actually live — embracing the article's "stateful backend" thesis where it pays.

This is a strict improvement in two specific ways. First, validation independence: Dirac's validator leans on the state manager's word assignments being correct, which is why it string-matches the boundary line instead of trusting the anchor; ours recomputes hashes from disk. Second, bookkeeping: uniqueness by construction removes the used-anchor list and the exhaustion/fallback ladder entirely.

The cost of the divergence is small and on the axis the article itself ranks lowest: the read prefix is 3 dense characters rather than a tiktoken-vetted single token. Input tokens are 5–6× cheaper than output tokens, and the whole point of the mechanism is to shrink output.

---

## 6. Strengths over the article

- **Whole-span validation.** Boundary-only checks become span checks; interior drift and never-served lines are hard errors, not silent overwrites.
- **Reject-and-serve.** Failures hand back fresh anchors that count as serves, so the retry needs no read — the article's error loop implies one.
- **No vocabulary asset, no exhaustion.** 238,328 anchors by construction vs ~1,700 words plus a fallback ladder.
- **Durable, partitioned state.** Snapshots survive restarts; served state is session-keyed so sub-agents, nested runs, and continued sessions verify against their own records (ADR-0002); undo persists with a drift guard.
- **Reconciler guarantees Dirac doesn't state:** no-op edits never rotate anchors; re-inserted identical text keeps its hash; lines outside the range never borrow hashes from lines inside it.

## 7. Where the article has the edge

- **Proactive external-edit reconciliation.** A file-update hook re-anchors immediately; we detect at next read/validate. Correctness is equal; latency differs by one roundtrip.
- **Read-prefix token economy.** A single-token word is a guaranteed 1 token; a 3-char hash is *usually* 1–2. Marginal, and on the cheap axis.

---

## 8. Conclusion

The implementation fits the article's design principles — position-independent anchors, a minimal per-line read prefix, `O(R)` edit output, a stateful backend, and a reconciler that preserves anchors on unchanged lines and returns fresh ones in every response. On the two problems the article explicitly set out to solve, the repo solves both by design. On validation, it goes measurably beyond the article: the whole span the model claims to be editing is verified against the tool's own record of what it served, and failures are self-healing roundtrips. The one deliberate divergence — content-derived hashes where Dirac chose state-assigned words — trades a marginal token savings on the read prefix for self-verifying anchors and zero anchor-bookkeeping. It is a favorable trade, and consistent with the article's own argument that token efficiency is a compounding, industry-wide win.
