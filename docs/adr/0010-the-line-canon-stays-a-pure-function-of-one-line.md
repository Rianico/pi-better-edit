# 10. The Line Canon Stays a Pure Function of One Line

Date: 2026-11-02

## Status

Accepted

Clarifies [0002. Tokenizer-Stable 4-Character Anchors, Canon v3 Whitespace Class, and File-Scoped Allocator](0002-tokenizer-stable-4-character-anchors-canon-v3.md)

## Context

The invisible-codepoint work ([ADR-0009](0009-invisible-codepoint-disclosure-lives-on-the-edit-path.md)) raised the canon twice: whether to narrow its code-point set, and whether to make it position-aware.

`canon(line)` is `line.replace(CANON_RE, "")` (`src/hashline/hash-identity.ts`) — a pure function of one line. That purity is load-bearing, not incidental. The persisted `canon_hash` is per line and derived from that line alone (`src/snapshot-store/index.ts`), and it is re-verified against a single current line at the stat-matched page gate (`src/file-content/preview.ts`) and on drift (`src/drift.ts`).

The canon is measurably over-broad. It strips the 28-code-point class everywhere on a line, including inside string literals and comments, while formatters normalize those code points only in code position and preserve them inside literals (`docs/articles/formatter-whitespace-churn-js-ts.md`: `in code position -> single space (MEAS)` against `inside string literal -> preserved (MEAS)`). So it discards a distinction every measured formatter keeps.

## Decision

We will keep `canon` a pure function of one line. It is neither narrowed nor made position-aware.

Formatter insensitivity stays in the hash; byte fidelity is answered on the edit path ([ADR-0009](0009-invisible-codepoint-disclosure-lives-on-the-edit-path.md)).

### Considered Options

- **Position-aware canon** (normalize trivia only, preserve literal and comment payload) — rejected on an invariant. It requires lexical state spanning lines, so `canon(line)` would become `canon(file, index)`. A line's identity would then depend on its neighbours, which content-addressed line identity exists to prevent, and a stored `canon_hash` could no longer be reproduced from one line. A line-local scan does not rescue it: a line inside a multi-line template literal or block comment carries no delimiter of its own, so a per-line scan classifies payload as trivia — the exact case the option exists to protect.
- **Narrow the set** to what formatters churn in practice — rejected on measurement. The premise is already nearly true (VT and FF are churned), and the tail is nearly empty: in a 157M-character corpus scan, SP/LF/TAB/CR are 99.985% of occurrences and 13 of the 28 code points never appear at all. The measured benefit is approximately zero, against a `CANON_VERSION` bump and a re-baseline of the per-code-point disposition tests.
- **Drop the canon; hash raw bytes and absorb formatter runs by token-patience rebasing** — deferred, not rejected. It preserves purity by moving insensitivity to the lease/rebase seam. Tracked as #230; it needs its own spec amendment because it changes how leases survive a formatter run.
- **Prior art** — this repository already rejected ASCII-only stripping (`docs/.archive_adrs/0005-whitespace-insensitive-anchors.md`) because non-ASCII whitespace caused spurious anchor rotation. Any future narrowing should cite it rather than re-propose it.

## Consequences

The over-broad strip remains: `const s = "a`+NBSP+`b"` and `const s = "a b"` share an anchor, and no canon change would fix the silent-substitution hazard anyway, because ZWSP is already un-stripped and its substitution is still accepted.

Harder, and accepted: the canon cannot be used as a guard, and code must not treat it as one. Its whitespace blindness is a property of the identity function, not a verification gate.

Load-bearing assumption, confidence high: a line's identity must be computable from that line alone, because a stored digest is re-derived from a single line. Revisit only if line identity stops being content-addressed per line.

Deep analysis: [`docs/articles/formatter-whitespace-churn-js-ts.md`](../articles/formatter-whitespace-churn-js-ts.md). Issue #230.
