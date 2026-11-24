# ADR-0019. EOL Normalization, Normalized Undo, and the Built-in EOL Config

Date: 2026-11-24

## Status

Accepted

Relates to [0013. Anchor Identity Derives From Raw Bytes](0013-anchor-identity-derives-from-raw-bytes.md), [0004. Model-Tool Boundary and Error Protocol](0004-model-tool-boundary-and-error-protocol.md), and [0009. Invisible Codepoint Disclosure Lives on the Edit Path](0009-invisible-codepoint-disclosure-lives-on-the-edit-path.md). Downstream report: `Rianico/dsh-better-edit#147`.

## Context

`edit` already writes one line ending per file: `detectEnding` picks the first separator, `toLF` produces the anchor model, and `restoreEndings` rewrites the whole file with that one ending. A file that mixes LF and CRLF therefore loses the mix on its first edit, silently, and `undo_last_edit` cannot restore it: the undo record stores normalized text plus one ending.

Mature editors normalize too:

- **VS Code** rewrites chunks to the dominant EOL when the text model is created, and normalizes again on save. Its EditorConfig extension applies `end_of_line` on save with `TextEdit.setEndOfLine`.
- **JetBrains** converts the document to LF at load and writes the detected separator on save. Its `Inconsistent line separators` inspection warns about mixed files.
- **Sublime Text** normalizes in memory on open; its maintainers state that mixed line endings will never be saved.

None of them preserves a per-line mixture, and none of their undo stacks reintroduces one: undo operates on the normalized buffer.

## Decision

1. **One EOL per file, resolved at write time.** Every `edit` writes one `effective EOL`: the built-in `eol` config value when it forces `LF`, `CRLF`, or `CR`; otherwise the file's most frequent terminator kind (`CRLF`, `LF`, or `CR`; ties -> `LF`, then `CRLF`, then `CR`); otherwise the system terminator (`\r\n` on Windows, `\n` elsewhere). `AUTO` is the default.

2. **The built-in config replaces `.editorconfig` in v1.** `eol` is a top-level key in `settings.json` (`AUTO` | `LF` | `CRLF` | `CR`, default `AUTO`), overridable by `PI_BETTER_EDIT_EOL`, resolved through the existing env > project > global > default ladder. `.editorconfig` is not read; a future request can add it as a lower rung.

3. **The normalization is disclosed, not silent.** A mixed file's `read` page appends a lean warning after its rows, separated by a blank line: `[W_MIXED_EOL] Mixed EOL: 12 CRLF, 3 LF, 1 CR. All edits normalize to CRLF (file).` An edit whose write changes a pre-image terminator's bytes emits `[MODEL] [W_EOL_REWRITTEN] EOL normalized to CRLF (file): N terminators changed. Undo restores normalized content.` A terminator introduced by a new line was not in the pre-image and is not counted. A config-forced rewrite of a uniform file emits the edit warning but no read warning.

4. **Ordinary undo is normalized.** `undo_last_edit` restores the pre-edit content at the `effective EOL` recorded by the edit. It does not restore a pre-edit mixture. When the pre-image was mixed, the undo response says the mixture is not restored.

5. **Cut forward writes normalize; revert and repair stay byte-exact.** The cut target insert and source retirement write each member at its effective EOL and disclose the rewrite like an ordinary edit. A correlated foreign-cut revert and next-run repair write the raw pre-image bytes. That is a `byte-exact revert`, not normalized undo; its oracle compares bytes.

6. **`write` is untouched.** The write hook remains a served-hash guard. New-file EOL is the writer's responsibility; `edit` on an empty or no-terminator file is the only "new file" surface this extension owns, and it uses the effective EOL.

## Considered Options

- **Per-line preservation (P1-lite).** Preserve each line's own terminator on edit, so untouched lines never change. Rejected: none of the three editors preserves a mixture; it needs a per-line map through the mutation engine, undo, and cut repair; and the read warning plus the edit warning give the model the same information with a far smaller change. The cost estimate was ~300 production lines and 15-20 tests.
- **Force-system default.** `eol: "system"` would convert every CRLF file to LF on macOS and every LF file to CRLF on Windows. Rejected: it is the reverse of cross-platform preservation and warns on almost every file.
- **Byte-exact ordinary undo.** Store `raw_pre` on every edit and restore it. Rejected: it forks undo semantics, reintroduces a config-violating EOL after an override, and contradicts the normalized buffer the editors expose. Cut durability keeps byte-exactness where it is a correctness requirement.
- **`.editorconfig` support.** Rejected for v1 in favour of the built-in key; it adds an INI/glob parser and a dependency for one property. Revisit if requested.

## Consequences

- The README undo promise changes from "exact line endings" to "the previous content at the effective EOL; a pre-edit mixture is not restored". The cut transaction's byte-exact revert remains.
- The undo record gains `effective_ending` (the EOL actually written), with a fallback to `ending` for rows written before this change. Ordinary edits do not store `raw_pre`; only cut transactions do, and their revert/repair stays byte-exact.
- The read page appends `[W_MIXED_EOL]` after its rows for mixed files; the edit response gains `[MODEL] [W_EOL_REWRITTEN]`. Both are model-facing.
- The config schema gains `eol`; the env var is `PI_BETTER_EDIT_EOL`.
- `detectEnding`'s first-separator rule is replaced by the three-way dominant rule when resolving the effective EOL. The anchor canon still folds CRLF/CR to LF, so anchors do not move because of an EOL rewrite.
- Tests: mixed fixtures in both orders, uniform controls, config precedence, no-EOL/system, normalized undo, cut revert byte-exactness, the read warning, and the edit-warning payload.
