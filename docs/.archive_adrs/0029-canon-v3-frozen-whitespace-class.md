# ADR-0029 — Canon v3: the frozen 28-code-point whitespace class amends ADR-0005's class clause

Date: 2026-10-04

## Status

accepted — amends [ADR-0005](0005-whitespace-insensitive-anchors.md)'s class clause (ASCII `[ \t\r\n]` → the frozen v3 class below). ADR-0005's Decision otherwise stands: whitespace-insensitive anchors, no fingerprint, one global canon.

## Context

ADR-0005 stripped only ASCII whitespace from the canon, on the 2026-08 assumption that formatters touch ASCII whitespace and Unicode whitespace "remains significant". The reconnaissance at [`formatter-whitespace-churn-js-ts.md`](../articles/formatter-whitespace-churn-js-ts.md), [`formatter-whitespace-churn-python-bash.md`](../articles/formatter-whitespace-churn-python-bash.md) and [`formatter-whitespace-churn-rust-go-java.md`](../articles/formatter-whitespace-churn-rust-go-java.md) (commit `144a3a1`) found that assumption false in the field: real formatters rewrite NBSP, the U+2000–U+200A spaces, IDEOGRAPHIC SPACE, BOM and friends back to ASCII layout — and every such rewrite rotated the anchor under v2, forcing the same rejection/re-read tax ADR-0005 was written to eliminate. `node scripts/canon-churn-audit.mjs` re-measures this locally (issue #22): 26 of the 28 v3 class code points are rewritten by at least one formatter on the audit machine.

## Decision

`CANON_VERSION` becomes **3**. The canon strips exactly this frozen list of 28 code points, anywhere in the line (leading, middle, trailing), defined once in `src/hashline/hash-identity.ts` as an explicit code-point list and reached through a single re-exported facade:

- C0 control whitespace + SP (6): U+0009 TAB, U+000A LF, U+000B VT, U+000C FF, U+000D CR, U+0020 SP
- Latin-1 / legacy (3): U+0085 NEL, U+00A0 NBSP, U+1680 OGHAM SPACE MARK
- General Punctuation spaces (11): U+2000 EN QUAD … U+200A HAIR SPACE
- Separators and wide spaces (5): U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR, U+202F NARROW NO-BREAK SPACE, U+205F MEDIUM MATHEMATICAL SPACE, U+3000 IDEOGRAPHIC SPACE
- Directional and BOM marks (3): U+200E LEFT-TO-RIGHT MARK, U+200F RIGHT-TO-LEFT MARK, U+FEFF ZERO WIDTH NO-BREAK SPACE

The following stay **significant** (never stripped): U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+00AD SOFT HYPHEN, U+2060 WORD JOINER, U+180E MONGOLIAN VOWEL SEPARATOR, U+001C–U+001F (the four C0 separators), and the C1 range U+0080–U+009F except U+0085 NEL. The full per-code-point record is executable: `test/core/canon-v3-disposition.test.ts`.

### Considered Options

- **Keep the v2 ASCII-only class (rejected)** — the churn the audit script measures is exactly the anchor rotation v2 pays in re-reads; NBSP- and en-space-heavy sources (CJK prose, pasted documents) never survive a format pass under v2.
- **Unicode property escapes `\p{White_Space}` / `\p{Cf}` instead of a frozen list (rejected)** — a versioned canon must be a frozen function; property sets drift with the engine/ICU version, so the same file could canonicalize differently across runtimes or silently change meaning under one `CANON_VERSION`.
- **Per-language or per-file-type canons (rejected)** — one global canon; the line model is language-blind and a per-language class would multiply the version space and re-derive identity from file naming.
- **Normalize ZWSP / ZWNJ / ZWJ (rejected)** — ZWNJ/ZWJ are identifier characters in Python, Rust and ECMAScript (content, not layout), and ZWSP is whitespace in none of the target languages; it survives every formatter's trim in the audit except the measured oxfmt ZWSP-to-space normalization below, which is handled as an accepted tension.

## Consequences

Migration for a running store, none active — all three effects are self-clearing:

1. **Snapshot cache-key prefix.** Keys move from `2:<checksum>` to `3:<checksum>` (`cacheKey` in `src/snapshot-store/index.ts`), so pre-v3 rows become unreachable on lookup and are reclaimed by the existing LRU vacuum (ADR-0017); no migration pass exists or is needed.
2. **Undo pins keep resolving their own lineage.** `file_undo.snapshot_hash` values written under v2 name v2 snapshot rows; `anchorsForSnapshotHash` serves the committed `line_lineage` anchors verbatim (spec §3.1.4 step 4: anchors are never re-derived on the undo path — verified against the code at this writing). A pre-upgrade `undo_last_edit` therefore restores with v2-era anchors. Accepted and documented behavior: those rows are exactly the ones the stale lease-holders were served, and a second undo of the same pin is impossible after restore re-materializes under v3.
3. **One bounded false-drift window.** Live v2 leases on lines containing newly-normalized code points rotate once at upgrade, producing at most one `E_STALE_*`/false-drift signal per in-flight anchor; served state is short-lived (cleared at session start / TTL-swept), so the window closes by itself — the same argument ADR-0005 made for the v1→v2 bump, now applied to v2→v3.

### Risk / limitation — the oxfmt ZWSP churn

The audit script measures local `oxfmt` **rewriting U+200B ZWSP to a space** (`const<ZWSP>b = 2;` → `const b = 2;`, exit 0; the script's presence check detects the change but cannot distinguish normalization from deletion) even though v3 keeps ZWSP significant. Stated as accepted v4 tension: ZWSP remains significant because it is whitespace in no target language and survives every other measured formatter's trim; the oxfmt-ZWSP interaction is a known, bounded false-drift source (one rejection + re-read on the affected line), and the re-runnable audit script (`scripts/canon-churn-audit.mjs`, npm `canon:audit`) flags it on every run rather than letting it rot into folklore.

## Evidence

- Reconnaissance (asserted measurements, not this ADR's authority): `docs/articles/formatter-whitespace-churn-{js-ts,python-bash,rust-go-java}.md` @ `144a3a1`.
- Re-runnable generator (the measurement this ADR cites): `scripts/canon-churn-audit.mjs` — matrix + verdict lines against locally installed formatters.
- Executable disposition record: `test/core/canon-v3-disposition.test.ts`; behavior tests: `test/core/whitespace-insensitive-canon.test.ts`.
- Implementation: `src/hashline/hash-identity.ts` (single `CANON_VERSION = 3` + frozen list), issue #22.
