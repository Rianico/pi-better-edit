# Formatter whitespace behaviour: Rust, Go, Java

Research for freezing a *canonical whitespace class* for per-line content anchors.
Companion file(s): `docs/research/formatter-whitespace-<STACK>.md` for the JS/TS and Python stacks.

**Method / measurement disclosure.** All findings below are derived from primary sources
(language specifications, formatter/compiler source files) fetched during this research run.
**I could not execute any formatter myself** (no shell / process-execution tool is available in this
run), so there are **no locally measured results** in this file; the "MEASURED BASELINE" supplied by
the requester is treated as an observation to be corroborated or contradicted against sources.
Cell values marked `~` are *researcher inference* from source code, not behaviour captured in a
source document.

---

## Legend

| Code | Meaning |
| --- | --- |
| `WS` | That stack's lexer treats the code point as white space (token separator). |
| `ERR` | Lexer rejects the code point → formatter reports an error and does **not** rewrite the file. |
| `ID` | Code point is an identifier character / part of a token's text (not white space). |
| `SP` | Formatter discards the input white space and regenerates layout spacing (U+0020 and/or its line-break character). |
| `DROP` | Formatter removes the code point from the output. |
| `KEEP` | Formatter reproduces the byte(s) verbatim in that context. |
| `—` | Not applicable / no distinct behaviour. |
| `U` (suffix) | **UNVERIFIED** — no source found; stated as unknown, never guessed. |

"Line end" = the code point is the last thing on a source line (trailing white space).
"Line-ending policy" is a per-formatter property, so it is only filled in the `LF`/`CR` rows.

---

## 1. Rust — Rust Reference + rustc lexer + rustfmt 1.8.x

### 1.1 Citations used in the table

| Key | Source |
| --- | --- |
| `R1` | Rust Reference, *Whitespace* — `WHITESPACE = any non-empty string containing only characters that have the Pattern_White_Space Unicode property`; explicit list U+0009 TAB, U+000A LF, U+000B VT, U+000C FF, U+000D CR, U+0020 SP, U+0085 NEL, U+200E LRM, U+200F RLM, U+2028 LS, U+2029 PS. <https://doc.rust-lang.org/reference/whitespace.html> |
| `R2` | `compiler/rustc_lexer/src/lib.rs`, `fn is_whitespace` — hard-codes exactly the eleven Pattern_White_Space code points, commented as groups *"End-of-line characters"* (`\u{000A}`, `\u{000B}`, `\u{000C}`, `\u{000D}`, `\u{0085}` "(from latin1)", `\u{2028}`, `\u{2029}`, `\u{200E}`, `\u{200F}`) and *"Horizontal space characters"* (`\u{0009}`, `\u{0020}`). Same file: `TokenKind::Unknown` is documented with the example `"№" -> Unknown`, i.e. non-ASCII non-identifier characters (NBSP, ZWSP, U+180E, U+FEFF, U+2060, U+00AD …) lex as `Unknown` and are rejected by the parser. <https://github.com/rust-lang/rust/blob/master/compiler/rustc_lexer/src/lib.rs> |
| `R3` | Rust Reference, *Tokens → String literals* — "Line-breaks, represented by the character U+000A (LF), are allowed in string literals. **The character U+000D (CR) may not appear in a string literal**"; *Raw string literals* — "The raw string body can contain any sequence of Unicode characters other than **U+000D (CR)**". <https://doc.rust-lang.org/reference/tokens.html> |
| `R4` | `rustc_lexer/src/lib.rs` — `is_id_start`/`is_id_continue` delegate to `unicode_ident::is_*xid*` (UAX #31 ID_Start/ID_Continue, which include the Join_Control characters U+200C ZWNJ and U+200D ZWJ). |
| `R5` | Rust Reference, *Whitespace* → `U+180E` appears in **neither** the reference list nor `is_whitespace` (it was removed from `Pattern_White_Space` in Unicode 6.3 and is general category `Cf`). |
| `R6` | `rustfmt/src/config/mod.rs` default configuration (`test_dump_default_config`): `newline_style = "Auto"`, `wrap_comments = false`, `format_strings = false`, `normalize_comments = false`, `format_code_in_doc_comments = false`, `hard_tabs = false`, `tab_spaces = 4`, `blank_lines_upper_bound = 1`. |
| `R7` | `rustfmt/src/formatting/newline_style.rs` — `NewlineStyle::{Unix, Windows, Native, Auto}`; in `Auto`, the style comes from the **first LF in the input** (Windows if it is preceded by CR, else Unix); `apply_newline_style` only rewrites the `\r\n` sequence. Test `keeps_carriage_returns_when_applying_windows_newlines_to_str_with_unix_newlines` shows a **lone `\r` survives** ("Three\rDrei" is kept as-is). |
| `R8` | `rustfmt/src/formatting.rs` — `ErrorKind::ParseError` (treated as an internal error kind). A file the compiler front end cannot parse cannot be formatted, so rustfmt reports an error and produces no rewritten output. |

### 1.2 Table (rustfmt defaults)

| Code point | lexer WS? | in code position | at line end | inside string literal | inside comment | line-ending policy |
| --- | --- | --- | --- | --- | --- | --- |
| SP U+0020 | `WS` `R1`,`R2` | `SP` `R6` | `DROP` `R6`,`R7`~ | `KEEP` `R6`,`R3` | `KEEP` `R6` | — |
| HT U+0009 | `WS` `R1`,`R2` | `SP` (→ spaces; `hard_tabs=false`) `R6` | `DROP` `R6`~ | `KEEP` `R6`,`R3` | `KEEP` `R6` | — |
| LF U+000A | `WS` `R1`,`R2` | line break (layout) `R6` | — | `KEEP` in string literals (LF allowed, not a "line break" the formatter can change) `R3` | `KEEP` `R6` | output line break = `\n`, `\r\n`, or platform style per `newline_style`; **default `Auto`** `R6`,`R7` |
| CR U+000D | `WS` `R1`,`R2` | `SP`/dropped as white space `R2` | `DROP` `R7`~ | **`ERR`** — "U+000D (CR) may not appear in a string literal" `R3` | `KEEP` `R7` | in `Auto` a lone CR is **not** converted (only `\r\n` is rewritten); CRLF input keeps CRLF `R7` |
| VT U+000B | `WS` `R1`,`R2` | `SP` `R2`~ | `DROP` `R6`~ | `KEEP` `R3` | `KEEP` `R6`~ | — |
| FF U+000C | `WS` `R1`,`R2` | `SP` `R2`~ | `DROP` `R6`~ | `KEEP` `R3` | `KEEP` `R6`~ | — |
| NEL U+0085 | `WS` `R1`,`R2` | `SP` — accepted as white space; *not* counted as a line break by rustc's line accounting `R2`~ | `DROP` `R6`~ | `KEEP` `R3` | `KEEP` `R6`~ | — |
| NBSP U+00A0 | `ERR` (not PWSpace, not XID) `R1`,`R2`,`R4` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R6`,`R3` | `KEEP` `R6` | — |
| OGHAM U+1680 | `ERR` `R1`,`R2` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |
| U+2000–U+2008 (Zs) | `ERR` `R1`,`R2` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |
| U+2009 THIN SP | `ERR` `R1`,`R2` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |
| U+200A HAIR SP | `ERR` `R1`,`R2` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |
| LS U+2028 | `WS` `R1`,`R2` | `SP` — accepted, treated as horizontal space, not a line break `R2`~ | `DROP` `R6`~ | `KEEP` `R3` | `KEEP` `R6`~ | — |
| PS U+2029 | `WS` `R1`,`R2` | as LS `R2`~ | `DROP` `R6`~ | `KEEP` `R3` | `KEEP` `R6`~ | — |
| NNBSP U+202F | `ERR` `R1`,`R2` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |
| U+205F MMSP | `ERR` `R1`,`R2` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |
| IDEO U+3000 | `ERR` `R1`,`R2` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |
| ZWSP U+200B | `ERR` (Cf, not XID) `R2`,`R4` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |
| ZWNJ U+200C | `ID` `R4` | `KEEP` — part of an identifier token, so layout does not touch it `R4`~ | `KEEP` (still inside the token) `R4`~ | `KEEP` `R3` | `KEEP` `R6`~ | — |
| ZWJ U+200D | `ID` `R4` | as ZWNJ `R4`~ | as ZWNJ `R4`~ | `KEEP` `R3` | `KEEP` `R6`~ | — |
| LRM U+200E | `WS` `R1`,`R2` | `SP` `R2`~ | `DROP` `R6`~ | `KEEP` `R3` | `KEEP` `R6`~ | — |
| RLM U+200F | `WS` `R1`,`R2` | `SP` `R2`~ | `DROP` `R6`~ | `KEEP` `R3` | `KEEP` `R6`~ | — |
| ZWNBSP U+FEFF | `ERR` (not PWSpace/XID; `Unknown`) `R2` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |
| SHY U+00AD | `ERR` `R2`,`R4` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |
| WJ U+2060 | `ERR` `R2`,`R4` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |
| MVS U+180E | `ERR` (Cf since Unicode 6.3; absent from PWSpace and from `R1`/`R2`) `R5`,`R2` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |
| U+0080–U+009F (group) | `ERR` except `U+0085` `R1`,`R2` | `ERR` `R2` | `ERR` `R2` | `KEEP` `R3` | `KEEP` `R6`~ | — |

**Rust notes**

1. The Rust white-space class is *exactly* UNICODE `Pattern_White_Space` — **11 code points**, no `Zs`
   at all. `U+000B`, `U+000C`, `U+0085`, `U+200E`, `U+200F`, `U+2028`, `U+2029` are members (`R1`,`R2`).
2. rustc/rustfmt group VT/FF/NEL/LS/PS with the **end-of-line** characters in the lexer comment (`R2`),
   but rustc's line accounting and rustfmt's blank-line preservation are based on `\n`; my reading is
   that these code points behave as *horizontal* white space for layout purposes → LS/PS do **not**
   become line breaks (`R2`~). Not measured; flagged inference.
3. The only legal way for one of these code points to *survive* in the output is inside a string
   literal, a raw string, or a comment; all three are reproduced verbatim with default config
   (`format_strings = false`, `wrap_comments = false`, `normalize_comments = false` — `R6`).
4. `U+200C`/`U+200D` are identifier characters (UAX #31 Join_Control is part of ID_Continue — `R4`),
   so they are the one "invisible" class rustfmt *preserves* rather than normalising. Rust has lints
   (`uncommon_codepoints`, confusables) but no autofix that rewrites them.
5. Baseline corroboration: VT/FF/NEL/LS/PS normalised, NBSP/Zs/ZWSP/ZWNBSP refused, ZWNJ/ZWJ accepted
   as identifier characters, bare CR inside a string literal is an error — all confirmed (`R1`,`R2`,`R3`,`R4`).

---

## 2. Go — Go spec + go/scanner + gofmt (go/printer)

### 2.1 Citations used in the table

| Key | Source |
| --- | --- |
| `G1` | Go spec, *Source code representation → Characters*: "White space, formed from spaces (U+0020), horizontal tabs (U+0009), carriage returns (U+000D), and newlines (U+000A), is ignored except as it separates tokens…". Same section: "A byte order mark may be disallowed anywhere else in the source." <https://go.dev/ref/spec> |
| `G2` | `src/go/scanner/scanner.go` — `skipWhitespace`: `for s.ch == ' ' \|\| s.ch == '\t' \|\| s.ch == '\n' && !s.insertSemi \|\| s.ch == '\r' { s.next() }` — note `'\r'` is **unconditionally** skipped, and `'\n'` is only a token (semicolon insertion) when `insertSemi` is set. |
| `G3` | `src/go/scanner/scanner.go` — `Init` ignores a **leading** BOM (`if s.ch == bom { s.next() // ignore BOM at file beginning }`); `next()` reports `illegal byte order mark` for a BOM at any later offset; unreachable-but-present errors `illegal character NUL`, `illegal character %#U`, `illegal UTF-8 encoding (got UTF-16)`. Comment text: "U+00A0 … is not whitespace; don't be lenient". |
| `G4` | `src/go/scanner/scanner.go` — `stripCR(b, comment bool)` is applied to (a) `//` comments, (b) `/* */` comments (with a guard so that `*\r/` is not created), and (c) **raw string literals** (`scanRawString`). `scanString` (interpreted literals) does **not** strip CR. Go spec, *String literals*: "Carriage return characters ('\r') inside raw string literals are discarded from the raw string value." |
| `G5` | `src/go/printer/printer.go` — `case *ast.BasicLit: data = x.Value; isLit = true` (basic literals are printed verbatim); `writeCommentPrefix`/`writeComment` build comment lines and call `trimRight(text, unicode.IsSpace)`; `maxNewlines = 2`; line breaks are written as `'\n'`. |
| `G6` | `src/cmd/gofmt/gofmt.go` — `processFile` parses first (`parse(...)`, whole-file or fragment mode) and returns the error without writing when parsing fails. |

### 2.2 Table (gofmt)

| Code point | lexer WS? | in code position | at line end | inside string literal | inside comment | line-ending policy |
| --- | --- | --- | --- | --- | --- | --- |
| SP U+0020 | `WS` `G1`,`G2` | `SP` (layout regenerated) `G5` | `DROP` (printer `trimRight`) `G5` | `KEEP` (literal printed verbatim) `G5` | `KEEP` mid-comment `G5`,`G6` | — |
| HT U+0009 | `WS` `G1`,`G2` | `SP` — used for indentation/alignment, regenerated `G5` | `DROP` `G5` | `KEEP` `G5` | `KEEP` `G5`,`G6` | — |
| LF U+000A | `WS` + semicolon insertion `G1`,`G2` | line break | — | `ERR` in interpreted literals ("string literal not terminated"), `KEEP` inside raw strings `G4` | `KEEP` `G5` | output line break is always `\n` `G5` |
| CR U+000D | `WS` (silently skipped) `G1`,`G2` | `DROP` — skipped, and **does not trigger semicolon insertion** `G2` | `DROP` `G2` | raw string: `DROP` (`stripCR`, value-preserving per spec); interpreted string: `KEEP` `G4` | `DROP` (`stripCR` in both comment forms) `G4` | CR never reaches the AST → CRLF and CR-only input are re-emitted with `\n` `G2`,`G4`,`G5` |
| VT U+000B | `ERR` `G1`,`G3` | `ERR` — `illegal character U+000B` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` (and `DROP` if trailing, see note 3) `G5` | — |
| FF U+000C | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP`/trailing `DROP` `G5` | — |
| NEL U+0085 | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP`; **trailing `DROP`** (`unicode.IsSpace`) `G5` | — |
| NBSP U+00A0 | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` — *not* stripped (NBSP is not Unicode `White_Space`) `G5` | — |
| OGHAM U+1680 | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | trailing `DROP` `G5` | — |
| U+2000–U+2008 | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | trailing `DROP` `G5` | — |
| U+2009 THIN SP | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | trailing `DROP` `G5` | — |
| U+200A HAIR SP | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | trailing `DROP` `G5` | — |
| LS U+2028 | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` (raw string content) `G4` | `KEEP`; **trailing `DROP`** `G5` | — |
| PS U+2029 | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G4` | `KEEP`; trailing `DROP` `G5` | — |
| NNBSP U+202F | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` — not `unicode.IsSpace` `G5` | — |
| U+205F MMSP | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | trailing `DROP` `G5` | — |
| IDEO U+3000 | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | trailing `DROP` `G5` | — |
| ZWSP U+200B | `ERR` `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` `G5` | — |
| ZWNJ U+200C | `ERR` (Cf is not `unicode.IsLetter`) `G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` `G5` | — |
| ZWJ U+200D | `ERR` `G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` `G5` | — |
| LRM U+200E | `ERR` `G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` `G5` | — |
| RLM U+200F | `ERR` `G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` `G5` | — |
| ZWNBSP U+FEFF | `ERR` — **except at offset 0, where `Init` ignores it** `G3` | `ERR` (`illegal byte order mark`) `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` `G5` | — |
| SHY U+00AD | `ERR` `G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` `G5` | — |
| WJ U+2060 | `ERR` `G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` `G5` | — |
| MVS U+180E | `ERR` `G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` `G5` | — |
| U+0080–U+009F (group) | `ERR` except none (no C1 code point is Go white space) `G1`,`G3` | `ERR` `G3` | `ERR` `G3` | `KEEP` `G5` | `KEEP` `G5` | — |

**Go notes**

1. Go's white-space class is the smallest of the three: **SP, HT, CR, LF only** (`G1`). Not even VT/FF.
2. **Leading BOM is not an error**: `Scanner.Init` skips a BOM at offset 0 (`G3`); only a BOM later in
   the file produces `illegal byte order mark`. Whether gofmt re-emits the leading BOM is **U**
   (the printer does not reproduce it; cmd/gofmt's handling was not traced).
3. **gofmt can remove Unicode-whitespace code points from inside comments.** `printer.trimRight(text,
   unicode.IsSpace)` is applied to each comment line (`G5`), so a *trailing* U+0085/U+1680/U+2000–U+200A/
   U+2028/U+2029/U+205F/U+3000 at the end of a comment line is silently deleted — even though the same
   code point in code position is a hard lexer error. NBSP (U+00A0) and NNBSP (U+202F) are **not**
   mimicked because they are not Unicode `White_Space` (`G5`). Reading of `trimRight` call sites is
   direct evidence; the "comment line" framing is inference (`G5`~).
4. gofmt rewrites literal interiors in exactly one case: raw strings, where `stripCR` removes CR (`G4`).
   This is *value-preserving* by spec but **changes the source bytes of the line**, which matters for a
   byte-hash line anchor.
5. A CR-only (classic-Mac) file cannot be formatted: CR never sets `insertSemi`, so no statement
   separators are produced (`G2`~ — source-reading inference, not measured).
6. Baseline corroboration: Go accepts only SP/HT/CR/LF; other code points are lexer errors; trailing
   white space is stripped; CRLF is rewritten to LF. Confirmed, with the raw-string/comments and
   leading-BOM qualifications above.

---

## 3. Java — JLS + javac + google-java-format + palantir-java-format + Spotless

### 3.1 Citations used in the table

| Key | Source |
| --- | --- |
| `J1` | JLS §3.6 *White Space*: "White space is defined as the ASCII space character, horizontal tab character, form feed character, and line terminator characters (§3.4)." Productions: `WhiteSpace: the ASCII SP character \| the ASCII HT character \| the ASCII FF character \| LineTerminator`. **VT is not white space in Java.** <https://docs.oracle.com/javase/specs/jls/se25/html/jls-3.html> |
| `J2` | JLS §3.4 *Line Terminators*: `LineTerminator: the ASCII LF character \| the ASCII CR character \| the ASCII CR character followed by the ASCII LF character`. Also `InputCharacter: UnicodeInputCharacter but not CR or LF`. §3.7: comments are not part of the token stream. §3.10.5: `StringCharacter` = any character except `"`, `\`, CR, LF. §3.10.6: text-block `TextBlockWhiteSpace` = space, tab, form feed, and incidental white space is stripped. |
| `J3` | `com/sun/tools/javac/parser/JavaTokenizer.java` — `readToken` (JDK source): `case ' ': case '\t': case '\f': /* whitespace per JLS 3.6 */`, `case '\n': case '\r': case '\r\n'` (line terminator) are the only accepted separators; the `default:` branch takes an operator (`isSpecial`), else `Character.isJavaIdentifierStart` → `scanIdent()`, else a digit, else `EOI`, else `lexError(pos, Errors.IllegalChar(arg))` where `arg` is `"\\u%04x"` for non-printable characters. Message template: "illegal character: {0}". |
| `J4` | Same file, `scanIdent()` — explicitly skips line terminator, comment start, and the ignorable ASCII controls (`\u0000`–`\u0008`, `\u000E`–`\u001B`, `\u007F`), and for non-ASCII input: `if (Character.isIdentifierIgnorable(get())) { next(); continue; }` (non-ASCII ISO controls U+0080–U+009F and every `Cf` character, incl. U+00AD, U+200B, U+200C, U+200D, U+200E, U+200F, U+2060, U+FEFF, U+180E) → **silently skipped inside an identifier**. `Character.isJavaIdentifierStart` is false for those same characters, so at the *start* of a token they fall through to the `IllegalChar` error. |
| `J5` | `com/google/googlejavaformat/java/JavaInput.java` — non-token toks (comments and whitespace) are emitted with their **original text**: `strings.add(originalTokText)`; `Tok` = "(text, originalText) … its text after removing Unicode escapes"; string-literal toks use `t.stringVal()` as `text` but the *original* text is what is re-emitted. Whitespace toks are split per line via `Newlines.lineIterator` / `Newlines.getLineEnding`. `if (Character.isWhitespace(tokText0))` is the whitespace-token branch. `throw new FormatterException("Unicode escapes not allowed in whitespace or multi-character operators")` is thrown when a token's decoded text differs and it is not a single character. Lexer diagnostics: when javac reports an **ERROR** diagnostic while building toks, `buildToks` returns a list containing only an EOF tok. |
| `J6` | `com/google/googlejavaformat/java/JavaOutput.java` — output `.append(text, range)`: `' '`/`'\t'` accumulate in `spacesPending`; a following `'\r'` (consumed with an immediately following `'\n'`) or `'\n'` **discards `spacesPending`** and increments `newlinesPending`; pending spaces are only flushed when a non-space character is appended → trailing white space per output line is dropped, tabs not at a line end survive. Line breaks are emitted with the instance's `lineSeparator`. |
| `J7` | `com/google/googlejavaformat/java/Formatter.java` — `String lineSeparator = Newlines.guessLineSeparator(input);` and `new JavaOutput(lineSeparator, javaInput, this::comment)`. Parse errors: `Trees.parse(...)` collects `errorDiagnostics` and throws `FormatterException.fromJavacDiagnostics(...)` when non-empty. `StringWrapper.wrap(...)` is applied only in `formatSourceAndFixImports`. |
| `J8` | `com/google/googlejavaformat/Newlines.java` — `BREAKS = ImmutableSet.of("\r\n", "\n", "\r")`; `guessLineSeparator` returns the first recognised separator in the file, or `"\n"` when none is found; NEL/LS/PS/index are **not** newlines. `palantir-java-format` ships a byte-identical fork of this class (`com/palantir/javaformat/Newlines.java`, same `BREAKS`, `isNewline`, `guessLineSeparator`) → same policy. |
| `J9` | google-java-format README — no configurability of the formatting algorithm; `--skip-reflowing-long-strings` exists as an opt-out, i.e. reflowing long string literals is on by default in the CLI. |
| `J10` | Spotless (`plugin-gradle/README.md`, "Line endings and encodings (invisible stuff)") + `lib/src/main/java/com/diffplug/spotless/LineEnding.java` — formats configured with `LineEnding.{GIT_ATTRIBUTES, GIT_ATTRIBUTES_FAST_ALLSAME, PLATFORM_NATIVE, WINDOWS, UNIX, MAC_CLASSIC}`; line endings are applied to the whole file; default is `GIT_ATTRIBUTES_FAST_ALLSAME` (i.e. `.gitattributes`/`core.eol`, LF on the usual Linux/macOS setup). Generic steps (`generic.IndentStep`, `generic.EndWithNewlineStep`, `generic.ReplaceStep`) run on whole-file text and are **not** language-aware. |

### 3.2 Table (javac lexer + google-java-format / palantir-java-format defaults; Spotless where noted)

| Code point | lexer WS? | in code position | at line end | inside string literal | inside comment | line-ending policy |
| --- | --- | --- | --- | --- | --- | --- |
| SP U+0020 | `WS` `J1` | `SP` — layout regenerated; runs of input spaces collapse `J6` | `DROP` (`spacesPending` discarded) `J6` | `KEEP` `J2`,`J5` | `KEEP` (original text emitted) `J5` | — |
| HT U+0009 | `WS` `J1` | tabs inside a line survive (`spacesPending.append('\t')`, flushed at the next non-space char); indentation columns are re-derived `J6` | `DROP` `J6` | `KEEP` `J2`,`J5` | `KEEP` `J5` | — |
| LF U+000A | line terminator `J2` | line break, re-emitted as `lineSeparator` `J6` | — | `ERR` (not a `StringCharacter`) `J2` | `KEEP` `J5` | GJF **preserves the input's first line terminator** (`\r\n`, `\n`, or `\r`); mixed input is unified to that first one; no file-wide CRLF→LF conversion `J7`,`J8` |
| CR U+000D | line terminator `J2` | line break `J2`,`J6` | — | `ERR` `J2` | `KEEP` in comment text; a lone CR in a `//` comment's stored line ending is emitted as its own tok `J5`~ | same as LF; a CR-only file stays CR-only (separator guessed as `"\r"`) `J8`~ |
| VT U+000B | **not** `WS` `J1` | `ERR` — `illegal character: '\u000b'` `J1`,`J3` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| FF U+000C | `WS` (`case '\f'`) `J1`,`J3` | `SP` `J3`,`J6` | `DROP` `J6` | `KEEP`; in a **text block** treated as text-block white space and subject to incidental-white-space stripping `J2` | `KEEP` `J5` | — |
| NEL U+0085 | `ERR` (no JLS rule) `J1`,`J3` | `ERR` `J3` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| NBSP U+00A0 | `ERR` — not `WhiteSpace`, not `JavaIdentifierPart` `J1`,`J3`,`J4` | `ERR` — `illegal character: '\u00a0'` `J3` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| OGHAM U+1680 | `ERR` `J1`,`J3` | `ERR` `J3` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| U+2000–U+2008 | `ERR` `J1`,`J3` | `ERR` `J3` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| U+2009 THIN SP | `ERR` `J3` | `ERR` `J3` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| U+200A HAIR SP | `ERR` `J3` | `ERR` `J3` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| LS U+2028 | `ERR` `J2`,`J3` | `ERR` `J3` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| PS U+2029 | `ERR` `J2`,`J3` | `ERR` `J3` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| NNBSP U+202F | `ERR` `J3` | `ERR` `J3` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| U+205F MMSP | `ERR` `J3` | `ERR` `J3` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| IDEO U+3000 | `ERR` `J3` | `ERR` `J3` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| ZWSP U+200B | `ERR` at token start (ignorable ⇒ not an identifier *start*) `J4` | `ERR` `J3`,`J4` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| ZWNJ U+200C | `ID`-ignorable: skipped **inside** an identifier, `ERR` at token start `J4` | `ERR` at token start; inside an identifier it is **silently deleted** from the token `J4` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| ZWJ U+200D | as ZWNJ `J4` | as ZWNJ `J4` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| LRM U+200E | as ZWNJ `J4` | as ZWNJ `J4` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| RLM U+200F | as ZWNJ `J4` | as ZWNJ `J4` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| ZWNBSP U+FEFF | as ZWNJ `J4` | as ZWNJ `J4` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| SHY U+00AD | as ZWNJ `J4` | as ZWNJ `J4` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| WJ U+2060 | as ZWNJ `J4` | as ZWNJ `J4` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| MVS U+180E | `Cf` ⇒ as ZWNJ `J4` | as ZWNJ `J4` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| U+0080–U+009F (group) | exceptionally, these are `isJavaIdentifierPart` (ignorable) but not identifier *start* `J4` | `ERR` at token start; skipped inside identifiers `J4` | `ERR` `J3` | `KEEP` `J2` | `KEEP` `J5` | — |
| *(whole file)* | — | — | — | — | — | Spotless (outside the formatter proper) **does** normalise line endings: default `LineEnding.GIT_ATTRIBUTES_FAST_ALLSAME`, applied per file; `MAC_CLASSIC` (lone CR) can be selected and rewrites every CR `J10` |

**Java notes**

1. Java's white-space class is **SP, HT, FF + LF/CR/CRLF** (`J1`,`J2`). **FF is white space in Java but
   not in Go**; **VT is white space in neither Java nor Go, but is in Rust**.
2. `U+00A0` and every other `Zs` are hard lexer errors *outside* literals/comments
   (`illegal character: '\u00a0'`), and remain untouched inside them (`J3`,`J5`). The same holds for
   `\u00a0` written as a **unicode escape**: escapes are translated to characters before tokenising
   (JLS §3.3), so `int x\u00a0= 1;` is the same error. This last step is inference from the JLS
   translation model (`J2`~).
3. The `Cf`/ignorable family (ZWSP, ZWNJ, ZWJ, LRM, RLM, SHY, WJ, ZWNBSP, MVS, C1 controls) is the
   Java-specific trap: it is *not* an identifier character, and it is *not* rejected —
   `scanIdent` **silently skips** it when it occurs inside an identifier (`J4`). Java is therefore the
   only one of these three stacks where an invisible code point can vanish from the token text.
   At the start of a token it errors (`J3`,`J4`).
4. google-java-format preserves the original text of comments and string literals (`J5`) and therefore
   does not introduce or remove NBSP/ZWSP; its output layout is regenerated, and trailing white space
   per output line is dropped by `JavaOutput` (`J6`).
5. GJF refuses input whose javac lexing fails: lexer errors arrive as ERROR diagnostics and
   `Formatter.format` throws `FormatterException.fromJavacDiagnostics` from `Trees.parse` (`J7`);
   `JavaInput.buildToks` also degrades to an EOF-only tok list when ERROR diagnostics are present
   (`J5`). The exact user-visible output for the EOF-only path (empty output vs. exception) is **U**.
6. palantir-java-format reuses GJF's `Newlines` class verbatim (`J8`); no palantir-specific
   whitespace/line-ending option is documented (their README contains no line-ending or Unicode
   handling text — `U` for anything palantir-specific beyond that).

---

## 4. Direct answers

### (a) Does any of these formatters rewrite white space *inside* string literals, comments, or regex literals?

| Stack | Inside string literals | Inside comments |
| --- | --- | --- |
| Rust/rustfmt | **No** by default (`format_strings = false`, `normalize_comments = false`, `wrap_comments = false` — `R6`); literal bodies are reproduced verbatim, including VT/FF/NEL/LS/PS/NBSP/ZWSP (`R3`,`R6`). Caveat: `newline_style` post-processing rewrites `\r\n` → `\n` in the *whole* text when the style is Unix, and CR cannot appear in Rust literals anyway (`R3`,`R7`). | **No** by default — comment text is reproduced; only `wrap_comments`/`normalize_comments` (both non-default) touch comment interiors (`R6`). Trailing white space on a comment line is removed as part of layout (`R6`~). |
| Go/gofmt | **Yes, one case**: `stripCR` deletes every CR inside **raw** string literals (CRLF → LF inside the literal body) — value-preserving per the spec but a source-byte change (`G4`). Interpreted string literals are printed verbatim (`G5`). | **Yes, two ways**: CR is deleted from both `//` and `/* */` comments by `stripCR` (`G4`); and trailing Unicode white space (U+000B/FF/NEL/U+1680/U+2000–U+200A/U+2028/U+2029/U+205F/U+3000 — anything `unicode.IsSpace`, *not* NBSP/U+202F) is deleted from each comment line by `printer.trimRight` (`G5`). Multi-line `/* */` blocks are also re-indented to the new column. |
| Java/GJF/palantir | **Only via reflow**: the CLI applies `StringWrapper` by default (opt out with `--skip-reflowing-long-strings`), which splits an over-long string literal into concatenated literals (`J9`); literal *values* are intended to be preserved (inference, not verified line-by-line in the split algorithm — `U`). Literal text is otherwise emitted from the original source (`J5`). Text-block indentation is rewritten whenever the surrounding code is re-indented; value preservation relies on JLS §3.10.6 stripping the *incidental* (common) indentation (`J2`). | **Partly**: comment text is emitted from the original source (`J5`) and javadoc/comments are re-written by GJF's comment helper (`J7`); the exact per-code-point policy for comment interiors is **U**. |
| Java/Spotless (wrapper, not a formatter) | **Yes** for the generic whole-file steps: `generic.IndentStep` (space↔tab conversion of leading white space on *every* line), `generic.ReplaceStep`, `generic.EndWithNewlineStep` operate on raw text and are not language-aware (`J10`). | Same — whole-file steps hit comment bodies and text blocks (`J10`). |

Regex literals: only the JS/Python stacks have them; Rust/Go/Java have none (Rust has `regex!` macros and `r"..."` strings → see raw-string row above).

### (b) Do any of them convert LS/PS U+2028/U+2029 into a real newline (changing the line count)?

**No, in all three stacks.**
* Rust: U+2028/U+2029 are white space (`R1`,`R2`) but are not `\n`; the lexer file groups them with
  the end-of-line characters while rustc's line accounting/blank-line logic keys off `\n`, so they act
  as horizontal space and are replaced by regenerated layout (`R2`~). rustfmt's output *line count*
  changes for many layout reasons, but not because LS/PS became line breaks.
* Go: U+2028/U+2029 are lexer errors (`G1`,`G3`) — nothing to convert. Inside a raw string they stay
  as content (`G4`).
* Java: JLS §3.4 recognises only LF, CR, CRLF (`J2`); javac rejects U+2028/U+2029 in code position
  (`J3`), and GJF's `Newlines` recognises only `\r\n`, `\n`, `\r` (`J8`). Inside a literal/text block
  they are ordinary characters and never become line breaks.
* (Contrast: in ECMAScript, U+2028/U+2029 **are** `LineTerminator`s — that is where a "LS/PS becomes a
  newline" hazard actually lives; see the JS/TS companion file.)

### (c) Can any formatter or lint autofix *introduce* one of these code points (NBSP, ZWSP, …)?

* **Rust/rustfmt**: none found. rustfmt's output white space is spaces/tabs/line-ending only
  (`R6`); its lexer rejects NBSP/ZWSP/etc., so it cannot emit them where it would reject them
  (`R2`). No rustfmt/clippy autofix that inserts invisible characters was found (`U`).
* **Go/gofmt**: none found. gofmt emits `'\n'`, `'\t'`, `' '`, `'\f'` (internal column marker) plus
  token text (`G5`); `go/doc/comment`'s text printer (used by gofmt ≥1.19 for doc-comment
  reformatting) contains **no** U+00A0 and no Unicode punctuation substitutions (`G5`). *This
  contradicts a common belief that gofmt's doc-comment reformatting introduces "typographic"
  dashes/quotes — the text printer has none.* Highest-value remaining check: `go/doc/comment` markdown/
  HTML printers do render such substitutions, but gofmt uses the text printer only (`U` for the HTML
  path being irrelevant here).
* **Java/GJF/palantir**: none found; output white space is spaces/`lineSeparator` (`J6`,`J7`) and
  comments/literals come from the input (`J5`).
* **Java/Spotless**: can introduce **tabs or spaces** (IndentStep) and **LF** (EndWithNewline), and can
  delete trailing whitespace, but not NBSP/ZWSP (`J10`).
* The realistic "invisible code point gets introduced" risk in these stacks is therefore *not* the
  formatter body but **copy-paste/IDE insertion**, which is outside what these sources can establish.

### (d) Line-ending defaults and CRLF/CR normalisation

| Tool | Default | CRLF | Lone CR |
| --- | --- | --- | --- |
| rustfmt | `newline_style = "Auto"` (`R6`) | Detects the style from the first LF in the file; a CRLF file keeps CRLF (`\r\n` for the whole output) (`R7`) | **Not** normalised; a lone CR inside comments/strings is preserved (only `\r\n` is rewritten) (`R7`) |
| `rustfmt` w/ `newline_style="Unix"` | – | CRLF → LF (`R7`) | preserved (`R7`) |
| gofmt | always LF | CRLF → LF (CR is skipped by the scanner; CR removed from comments and raw strings) (`G2`,`G4`,`G5`) | CR is not a statement separator ⇒ CR-only files fail to parse (`G2`~) |
| google-java-format / palantir | `Newlines.guessLineSeparator(input)` → first of `\r\n`, `\n`, `\r`; `"\n"` if none (`J7`,`J8`) | **Preserved** (CRLF stays CRLF); a *mixed* file is unified to whichever separator appears first | Preserved (`"\r"` is a recognised separator) (`J8`) |
| Spotless (Java) | `LineEnding.GIT_ATTRIBUTES_FAST_ALLSAME` → normalise per `.gitattributes`/`core.eol`, i.e. LF in a normal repo (`J10`) | CRLF → LF (or whatever git says) — line *count* unchanged, bytes change | With `MAC_CLASSIC`/`GIT_ATTRIBUTES`, lone CR → configured ending (`J10`) |

---

## 5. Contradictions with the supplied baseline

1. **Go, "any other code point in code position → illegal character (file refused)" — mostly right,
   one exception**: a **leading** U+FEFF is silently ignored by `go/scanner.Init` (`G3`). Only a BOM
   after the first character yields `illegal byte order mark`. Whether gofmt re-emits it is `U`.
2. **Go, "does not touch literal interiors" — needs qualification**: CR **is** removed from **raw
   string literal** bodies by `stripCR` (`G4`), and comment bodies lose CR as well as *trailing*
   Unicode white space (`G4`,`G5`).
3. **Go, "only SP, TAB, CR, LF are whitespace"** — supported (`G1`), but note that a **lone CR does not
   trigger semicolon insertion**, so CR-only files cannot be formatted at all (`G2`~), and CR is not
   preserved in the output (CRLF → LF).
4. **Rust, "rustfmt accepts VT/FF/NEL/LS/PS/LRM/RLM as whitespace"** — supported, and the class is
   exactly Unicode `Pattern_White_Space` (11 code points, no `Zs`) (`R1`,`R2`).
5. **Rust, "bare CR inside a string literal is an error"** — supported verbatim by the reference
   ("U+000D (CR) may not appear in a string literal"; raw string bodies likewise) (`R3`).
6. **Java (new stack, no baseline)** — FF is white space (`J1`); VT is not; and the `Cf`/ignorable
   family is neither white space nor an identifier character: it is an error at token start but is
   **silently skipped inside an identifier** (`J3`,`J4`).
7. **Java line endings**: google-java-format does **not** normalise CRLF→LF (it guesses and preserves);
   the CRLF→LF normalisation in a Java build usually comes from **Spotless's** `lineEndings`
   (default `GIT_ATTRIBUTES_FAST_ALLSAME`) or from git itself (`J7`,`J8`,`J10`).

## 6. Missing evidence / unverified

* No formatter was executed for this report (no execution tool available): every `ERR`/`SP`/`DROP` cell
  that is not backed by an explicit spec sentence or an explicit source line is marked `U`/`~`.
* Whether rustfmt *writes nothing* (vs. writing the original bytes) when parsing fails: only
  `ErrorKind::ParseError` was verified (`R8`); the exact write/no-write branch was not read.
* Whether gofmt preserves a leading BOM in its output (`G3`).
* Per-code-point behaviour of GJF's comment rewriter (javadoc reflow) inside comments (`J7`).
* Whether `StringWrapper` can change a string's value (it splits literals into concatenations; the
  intended semantics is value-preservation, but the split algorithm was not read line-by-line) (`J9`).
* How rustc/rustfmt *count lines* for files containing NEL/LS/PS-only separators (inference
  `R2`~ — rustc's source map keys off `\n`/CRLF).

## 7. Sources

**Kept (primary)**
* Rust Reference — Whitespace, Tokens (string/raw-string literal rules): <https://doc.rust-lang.org/reference/whitespace.html>, <https://doc.rust-lang.org/reference/tokens.html>
* `rust-lang/rust` — `compiler/rustc_lexer/src/lib.rs` (is_whitespace, identifiers, `Unknown`)
* `rust-lang/rustfmt` — `src/config/mod.rs` (default config), `src/formatting/newline_style.rs`, `src/formatting.rs` (`ErrorKind::ParseError`)
* Go spec — <https://go.dev/ref/spec> (Characters, Semicolons, String literals)
* `golang/go` — `src/go/scanner/scanner.go`, `src/go/printer/printer.go`, `src/cmd/gofmt/gofmt.go`
* JLS (SE 25), Chapter 3 — <https://docs.oracle.com/javase/specs/jls/se25/html/jls-3.html> (§3.3, §3.4, §3.6, §3.7, §3.10.5, §3.10.6)
* OpenJDK — `src/jdk.compiler/.../parser/JavaTokenizer.java` (readToken, scanIdent, IllegalChar)
* `google/google-java-format` — `JavaInput.java`, `JavaOutput.java`, `Newlines.java`, `Formatter.java`, `StringWrapper.java`, README
* `palantir/palantir-java-format` — `com/palantir/javaformat/Newlines.java`, `java/Formatter.java` (fork of GJF core)
* `diffplug/spotless` — `plugin-gradle/README.md`, `lib/src/main/java/com/diffplug/spotless/LineEnding.java`
* `golang/go` — `src/go/doc/comment/{parse,print}.go` (checked for U+00A0 / typographic substitutions: none)

**Rejected / deprioritised**
* Web-search LLM summaries of these questions (consistently unreliable, e.g. claiming `Character.isWhitespace` includes NBSP — Java's `Character.isWhitespace` explicitly excludes U+00A0/U+2007/U+202F, and javac never gets that far anyway).
* StackOverflow-style anecdotes about `illegal character` errors: superseded by the lexer/scanner sources.
* Site-search pages for rustfmt options (`rust-lang.github.io/rustfmt?search=…`): JS-driven; the default values were read from `test_dump_default_config` instead.

## 8. Practical implication for a canonical white-space class (per-line anchors)

* The only "invisible" code points that **all three** stacks accept *and* preserve in a predictable way
  are **U+200C/U+200D in Rust** (identifier chars) — every other member of the list is either a
  hard error outside literals/comments (Go, Java) or a normalised space (Rust).
* Anything that must be *canonicalised* rather than trusted should be treated as **context-sensitive**,
  because in all three stacks an invisible code point can be legal inside a string literal or comment
  and illegal outside it: the anchor model therefore needs the syntactic context (literal/comment vs.
  code) as part of the line-identity decision, not just the code point.
* Byte-level hazards for a *byte-hash* line anchor: (1) gofmt strips CR from raw strings/comments and
  trailing Unicode white space from comment lines; (2) rustfmt's `newline_style` rewrites `\r\n`;
  (3) javac-ignorable characters inside Java identifiers disappear from the token text; (4) re-indenting
  a Java text block changes source bytes (value preserved by §3.10.6).
