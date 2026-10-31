# 0002. Tokenizer-Stable 4-Character Anchors, Canon v3 Whitespace Class, and File-Scoped Allocator

Date: 2026-10-30

## Status

Accepted

## Context

Line presentation anchors must be compact to conserve context window, deterministic and unique within each file to prevent ambiguity, and stable across external formatting tools (Prettier, Black, rustfmt, eslint). Empirical measurements on this repo's own source ([`docs/.archive_adrs/0003-two-signal-line-identity.md`](../.archive_adrs/0003-two-signal-line-identity.md), [`docs/.archive_adrs/0005-whitespace-insensitive-anchors.md`](../.archive_adrs/0005-whitespace-insensitive-anchors.md)) showed that 93%–98% of lines modified by formatters involve whitespace changes only (indentation, line breaks, trailing spaces). If line anchors hash raw bytes or simple trailing trims, every format-on-save pass rotates anchors, forcing models into repetitive re-reads.

Furthermore, early iterations used 3-character base62 anchors (`62^3 = 238,328` combinations). As documented in [`docs/.archive_adrs/0030-widen-anchors-to-4-characters-for-tokenizer-stable-references.md`](../.archive_adrs/0030-widen-anchors-to-4-characters-for-tokenizer-stable-references.md) citing TokDrift literature, 3-character tokens frequently split across BPE tokenizer boundaries, particularly when numbers were involved, and the address space was too small to provide adequate collision headroom. Finally, early ASCII-only whitespace stripping (`[ \t\r\n]`) failed when files contained non-ASCII whitespace characters such as non-breaking spaces or Unicode typographic separators.

## Decision

We will generate line presentation anchors as 4-character base62 strings derived from file path and canonical line content using Canon v3 and a file-scoped strided probing allocator.

1. **4-Character Tokenizer-Stable Representation**: Anchors are encoded as 4 base62 characters (`HASH_LEN = 4`, `62^4 = 14,776,336` total hashes). The 10,000 all-digit strings (`0000` through `9999`) are strictly reserved and excluded from allocation to prevent tokenizer confusion with numeric line numbers. This yields an allocatable capacity of `USABLE_HASH_SPACE = 14,766,336` (`MAX_HASH_LINES`).
2. **Canon v3 Whitespace Class**: Before hashing, line content is normalized via Canon v3 (`CANON_VERSION = 3`), which strips a frozen 28-code-point whitespace class (C0 whitespace except U+001C–U+001F, SP, NEL, NBSP, Ogham space, U+2000–U+200A, U+2028/U+2029, U+202F, U+205F, U+3000, LRM, RLM, BOM). Zero-width spaces, soft hyphens, and joiners remain significant and survive normalization.
3. **File-Scoped Strided Probing Allocation**: Anchors are allocated per file rather than process-wide. Duplicate line contents within the same file are resolved via deterministic strided probing (`HASH_PROBE_STRIDE = 62^2 + 62 + 1 = 3907`, chosen to stay coprime with both raw and usable hash spaces).
4. **Session Blocked Hashes**: Anchors freed during edits within a session enter session-scoped `blocked_hashes` so a freed anchor is never recycled for newly inserted lines during that same session.
5. **Cache Invalidation Axis**: Anchor derivations track `ANCHOR_GENERATION = 1` to ensure cache eviction when underlying hashing constants evolve.
6. **Admission Bounds**: Files exceeding `SERVED_MAX_LINES = 200,000` lines or exhausting usable hash space are refused fail-closed with `[E_LARGE_FILE]`.

### Considered Options

- **3-character base62 anchors ([`docs/.archive_adrs/0030-widen-anchors-to-4-characters-for-tokenizer-stable-references.md`](../.archive_adrs/0030-widen-anchors-to-4-characters-for-tokenizer-stable-references.md))** — rejected: address space ceiling (238,328) was too small for large repositories and digit-prefixed 3-char strings fragmented inconsistently across frontier LLM tokenizers.
- **Raw byte hashing without whitespace stripping ([`docs/.archive_adrs/0004-anchor-canon-unchanged.md`](../.archive_adrs/0004-anchor-canon-unchanged.md))** — rejected: formatters rotated 93%–98% of anchors on save, destroying edit continuity between turns.
- **ASCII-only whitespace stripping (`[ \t\r\n]`, [`docs/.archive_adrs/0005-whitespace-insensitive-anchors.md`](../.archive_adrs/0005-whitespace-insensitive-anchors.md))** — rejected: spurious anchor rotation on code containing non-breaking spaces or Unicode formatting characters (amended by Canon v3 in [`docs/.archive_adrs/0029-canon-v3-frozen-whitespace-class.md`](../.archive_adrs/0029-canon-v3-frozen-whitespace-class.md)).
- **Process-wide global anchor allocation** — rejected: artificially constrained total lines across multi-file projects; file-scoped allocation guarantees independent 14.7M capacity per file.

## Consequences

- Anchors avoid numeric-digit collisions with line coordinates across frontier LLMs.
- External formatting passes between agent turns do not invalidate served anchors.
- Strided probing guarantees deterministic, collision-free anchor assignment within each file.
- Memory usage and allocation performance remain bounded under `SERVED_MAX_LINES = 200,000`.
