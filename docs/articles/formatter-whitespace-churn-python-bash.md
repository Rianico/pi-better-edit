# Formatter whitespace behaviour: Python and Bash/shell stacks

Research brief for freezing a "canonical whitespace class" for per-line content anchors.
Stack: CPython / black / ruff / autopep8 / pycodestyle / POSIX sh + bash / shfmt / shellcheck.

**Method and evidence status (read first).**
* This run had **no execution tool** (no shell/exec in the subagent toolset). Nothing was measured by running a formatter. Every cell below is therefore *documented* or *source-read* evidence, not measurement. The parent's measured baseline (oxfmt/rustfmt/gofmt/ruff) is taken as given and cross-checked against sources; disagreements are listed in §11.
* Citation tags `[P1]…[U2]` are defined in §1; every cell carries at least one. Cells that could not be sourced are marked **UNVERIFIED**. `direct` = the source states it; `interpretation` = my inference from a quoted mechanism.
* Runtime note: the configured artifact path (`…/subagent-artifacts/outputs/…/py-bash.md`) is outside the workspace and the write tool refused it; this file is the authoritative copy.

---

## 1. Source index (primary unless noted)

**CPython**
* `[P1]` Python Reference §2.1.9 Whitespace between tokens — https://docs.python.org/3/reference/lexical_analysis.html — *direct*: "Except at the beginning of a logical line or in string literals, the whitespace characters space, tab and formfeed can be used interchangeably to separate tokens: **whitespace**: `' '` | tab | formfeed".
* `[P2]` same page §2.1.8 Indentation — *direct*: "A formfeed character may be present at the start of the line; it will be ignored for the indentation calculations above. Formfeed characters occurring elsewhere in the leading whitespace have an undefined effect (for instance, they may reset the space count to zero)."
* `[P3]` same page §2.1.7 Blank lines — *direct*: "A logical line that contains only spaces, tabs, formfeeds and possibly a comment, is ignored".
* `[P4]` `Parser/lexer/lexer.c` (read this run) — whitespace skip is `while (c == ' ' || c == '\t' || c == '\014')`; the fallback for any other code point in code position is `if (!Py_UNICODE_ISPRINTABLE(c))` → error `"invalid non-printable character U+%04X"` (*direct*, verbatim).
* `[P5]` `Tools/unicode/makeunicodedata.py` (read this run) — *direct*, verbatim: `if category == "Zs" or bidirectional in ("WS", "B", "S"): flags |= SPACE_MASK` (⇒ `str.isspace()` / `Py_UNICODE_ISSPACE`) and `if char == ord(" ") or category[0] not in ("C", "Z"): flags |= PRINTABLE_MASK` (⇒ `Py_UNICODE_ISPRINTABLE`).
* `[P6]` `Lib/tokenize.py` (read this run) — *direct*, verbatim: `Whitespace = r'[ \f\t]*'`, `Comment = r'#[^\r\n]*'`, `Ignore = Whitespace + any(r'\\\r?\n' + Whitespace) + maybe(Comment)`.
* `[P7]` `Parser/lexer/lexer.c` identifier path (`verify_identifier`) — raises `invalid non-printable character U+%04X` when the candidate name contains a non-printable char, else `invalid character '%c' (U+%04X)` (*direct*; non-ASCII identifier candidacy: `is_potential_identifier_start(c) ⇒ c >= 128`).
* `[P8]` `Parser/lexer/lexer.c` string scanning — no printable-character test on literal contents; the only rejected code point inside a literal is NUL. *Read, but the `scan_string` body fell outside the extracted window* ⇒ **medium**.
* `[P9]` `Parser/lexer/reader.c` / universal-newline decoding — a bare CR is a newline for the real parser; **UNVERIFIED** (only the pure-Python `tokenize` regex `\r?\n` `[P6]` was read).

**black**
* `[B1]` Black docs, *The Black code style* §Line endings — https://black.readthedocs.io/en/stable/the_black_code_style/current_style.html — *direct*: "Black will normalize line endings (`\n` or `\r\n`) based on the first line ending of the file."
* `[B2]` same, §Form feed characters — *direct*: "Black will retain form feed characters on otherwise empty lines at the module level. Only one form feed is retained for a group of consecutive empty lines. Where there are two empty lines in a row, the form feed is placed on the second line."
* `[B3]` same, §Docstrings — *direct*: "Firstly the indentation of docstrings is corrected for both quotations and the text within, although relative indentation in the text is preserved. Superfluous trailing whitespace on each line and unnecessary new lines at the end of the docstring are removed. All leading tabs are converted to spaces, but tabs inside text are preserved. Whitespace leading and trailing one-line docstrings is removed."
* `[B4]` same, §AST differences item 1 — *direct*: "Black cleans up leading and trailing whitespace of docstrings, re-indenting them if needed."
* `[B5]` `src/black/__init__.py::decode_bytes` — *direct*, docstring verbatim: "`newline` is either CRLF, LF, or CR; but `decoded_contents` is decoded with universal newlines (i.e. only contains LF)"; body reads via `io.TextIOWrapper(srcbuf, encoding)` (newline=None ⇒ universal newlines) and `format_str` re-applies `"".join(dst_contents).replace("\n", newline_type)`.
* `[B6]` `src/black/strings.py` — *direct*, verbatim comment: "The line breaks the Python parser recognizes, and therefore the only ones that may be treated as line endings inside a string. `str.splitlines()` also breaks on form feed, vertical tab, NEL, the Unicode line and paragraph separators and the C0 separators, all of which are ordinary characters of a string's value. See `output._splitlines_no_ff`, which splits source code the same way." plus `LINE_BREAK_RE: Final = re.compile(r"\r\n|[\r\n]")`; `lines_with_leading_tabs_expanded()` uses `line.lstrip()` and `line[:prefix_length].expandtabs(4)`.
* `[B7]` `src/black/output.py::_splitlines_no_ff` — *direct*: "Split a string into lines ignoring form feed and other chars. This mimics how the Python parser splits source code." (+ `# Keep \r\n together`).
* `[B8]` `src/black/linegen.py::visit_STRING` — *direct*: `docstring = docstring.strip()` for single-line docstrings; multi-line docstrings go through `fix_multiline_docstring(docstring, indent)`; a padding space is added when the docstring starts/ends with a quote; a newline may be inserted before the closing quotes.
* `[B9]` `src/black/comments.py` — *direct*: `make_comment()` begins `content = content.rstrip()`; NBSP branch `if content and content[0] == "\N{NO-BREAK SPACE}" and not is_type_comment_string("# " + content.lstrip(), ...)` (tail not read ⇒ medium); `list_comments()` splits prefixes with `re.split("\r?\n|\r", prefix)`; preserved comments are re-emitted as `value = pc.leading_whitespace + pc.original_value`; blank-line prefixes are rebuilt as `nl_count = remainder.count("\n"); form_feed = "\f" in remainder and remainder.endswith("\n"); leaf.prefix = make_simple_prefix(nl_count, form_feed)` (or emptied when the prefix contains `\`).
* `[B10]` `src/black/parsing.py` — *direct*: `class InvalidInput(ValueError): "Raised when input source code fails all parse attempts."`, raised from `lib2to3_parse()` on `ParseError`/`TokenError`; black's parser is `blib2to3` (lib2to3 fork).

**ruff**
* `[R1]` `crates/ruff_python_parser/src/lexer.rs` (read this run) — *direct*: `skip_whitespace()` guard `matches!(self.cursor.first(), ' ' | '\t' | '\\' | '\x0C')` with live arms `' '`, `'\t'`, `'\\'`, `// Form feed` `'\x0C' => { self.cursor.bump(); }`; `eat_indentation()` has `// Form feed` `'\x0C' => { self.cursor.bump(); indentation = Indentation::root(); }`; `const BOM: char = '\u{feff}'` is eaten at offset 0; a non-ASCII char that is not XID_Start ⇒ `LexicalErrorType::UnrecognizedToken { tok: c }`; an unknown ASCII char (e.g. `\x0b`) falls to `_ => … UnrecognizedToken`; `'\r'` ⇒ `self.cursor.eat_char('\n')` + newline token. The string "printable" does not occur anywhere in the file.
* `[R2]` `crates/ruff_python_trivia/src/whitespace.rs` — *direct*: `is_python_whitespace` = `matches!(b, ' ' | '\t' | '\x0C')`, doc-linked to `[P1]`.
* `[R3]` `crates/ruff_python_formatter/src/string/docstring.rs` — *direct*: "Format a docstring by trimming whitespace and adjusting the indentation"; "Trim all trailing whitespace, except for a chaperone space…"; "Adjust the indentation"; "Unlike any other string, like black we change the indentation of docstring lines"; "Tabs are counted by padding them to the next multiple of 8 according to `str.expandtabs`"; "Black trims whitespace using `str.strip()`… So we use the unicode whitespace definition through `trim_{start,end}` instead of the python tokenizer whitespace definition in `trim_whitespace_{start,end}`"; docstrings are split with `docstring.split('\n')`; docstring *code* formatting is opt-in.
* `[R4]` `crates/ruff_python_formatter/src/comments/format.rs` — *direct*: `normalize_comment()` "Trimming any trailing whitespace"; `let trimmed = comment_text.trim_end();`; documented examples "`# comment ` is normalized to `# comment`"; NBSP branch: "Black adds a space before the non-breaking space if part of a type pragma" / "Black replaces the non-breaking space with a space if followed by a space" / "Otherwise we replace the first non-breaking space with a regular space"; `NodeLevel::Expression | ParenthesizedExpression` ⇒ "Remove all whitespace in parenthesized expressions".
* `[R5]` `crates/ruff_formatter/src/printer/mod.rs` — *direct*: newline emission is `self.state.buffer.push_str(self.options.line_ending.as_str())`; test `it_converts_line_endings` prints a text element containing `\n` with `LineEnding::CarriageReturnLineFeed` and the internal `\n` becomes `\r\n`.
* `[R6]` Ruff settings docs, `line-ending` — https://docs.astral.sh/ruff/settings/#line-ending — *direct*: `auto` (default; detected per file, first line ending wins on mixed files), `lf`, `cr-lf`, `native`; `docstring-code` is opt-in; no form-feed option exists.
* `[R7]` `crates/ruff_linter/src/rules/pycodestyle/rules/trailing_whitespace.rs` + rule doc — https://docs.astral.sh/ruff/rules/trailing-whitespace/ — *direct*: W291/W293 measure the trailing run with `rev().take_while(|c| c.is_whitespace())`; "This fix is marked unsafe if the whitespace is inside a multiline string, as removing it changes the string's content."
* `[R8]` `crates/ruff/src/commands/format.rs` — *direct*: `format_module_source(...).map_err(|err| if let FormatModuleError::ParseError(err) = err { FormatCommandError::parse(...) })?` ⇒ a lex/parse error aborts formatting for that file (reported, not formatted).
* `[R9]` `crates/ruff_python_formatter/src/options.rs` — *direct*: options struct carries `line_ending: LineEnding`.

**Rust / Unicode (class definitions the tools use)**
* `[U1]` Unicode `PropList.txt` (read this run) — *direct*: `White_Space` = `0009..000D`, `0020`, `0085`, `00A0`, `1680`, `2000..200A`, `2028`, `2029`, `202F`, `205F`, `3000` (25 code points; **U+001C–U+001F are not White_Space**); `Pattern_White_Space` = `0009..000D`, `0020`, `0085`, `200E..200F`, `2028`, `2029`.
* `[U2]` `library/core/src/char/methods.rs` (rust-lang/rust, read this run) — *direct*: `pub const fn is_whitespace(self) -> bool { match self { ' ' | '\x09'..='\x0d' => true, c => c > '\x7f' && unicode::White_Space(c) } }` ⇒ Rust/ruff `is_whitespace` = {SP,TAB,LF,VT,FF,CR} ∪ White_Space.
* `[U3]` Unicode `UnicodeData.txt` (category + bidi class) — **not fetched**; category/bidi claims that depend on it are marked.

**Python lint side**
* `[A1]` `pycodestyle.py::trailing_whitespace` (read this run) — *direct*, verbatim: `physical_line = physical_line.rstrip('\n\r\x0c')` … `stripped = physical_line.rstrip(' \t\v')` ⇒ W291 (`len(stripped)`) / W293 (blank line).
* `[A2]` `autopep8.py` (read this run) — *direct*: `fix_w291`: `fixed_line = self.source[result['line'] - 1].rstrip()` then `self.source[...] = fixed_line + '\n'`; `find_newline(source)` counts lines ending CRLF/CR/LF; `normalize_line_endings(lines, newline)`: "All lines will be modified to use the most common line ending" via `line.rstrip('\n\r') + newline`; `fix_lines`: "Transform everything to line feed. Then change them back to original before returning fixed source code."; indentation helper strips `' \t\v'` only; `split_and_strip_non_empty_lines()` uses `text.splitlines()`.

**Shell**
* `[S1]` GNU Bash manual §3.5.7 Word Splitting — https://www.gnu.org/software/bash/manual/html_node/Word-Splitting.html — *direct*: default IFS is `<space><tab><newline>`; "Space, tab, and newline are always considered IFS whitespace, even if they don't appear in the locale's `space` category."
* `[S2]` GNU Bash manual §3.1 Definitions — https://www.gnu.org/software/bash/manual/html_node/Definitions.html — *direct*: `blank` = "A space or tab character."; `metacharacter` = "A metacharacter is a space, tab, newline, or one of: `| & ; ( ) < >`"; `whitespace` = "A character belonging to the `space` character class in the current locale, or for which `isspace()` returns true."
* `[S3]` GNU Bash manual §3.1.2 Single Quotes / §3.1.2.3 Double Quotes — *direct*: single quotes preserve the literal value of every character; inside double quotes only `$`, `` ` ``, `\` and `!` (history expansion) keep special meaning, all other characters are preserved literally.
* `[S4]` POSIX XCU ch. 2 (Shell Command Language) — https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html — *direct*, verbatim: "7. If the current character is an unquoted `<blank>`, any token containing the previous character is delimited and the current character shall be discarded." / "8. If the previous character was part of a word, the current character shall be appended to that word." / LC_CTYPE "Determine … which characters are defined as letters (character class `alpha`) and `<blank>` characters (character class `blank`)". There is no `<form-feed>`/`<vertical-tab>` token — they exist only as the escape sequences `\f`/`\v`.
* `[S5]` mvdan/sh `syntax/lexer.go` (shfmt), `next()` (read this run) — *direct*: `case ' ', '\t', '\r': p.spaced = true; r = p.rune()`; `case '\n': …`; `case '\x00': // Ignore null bytes while parsing, like bash.`; backslash-newline continuation via `escNewl`; a CR immediately before LF is dropped ("turns into \n"); `utf8.DecodeRune` + `"invalid UTF-8 encoding"` error.
* `[S6]` mvdan/sh `syntax/printer.go` (read this run) — *direct*: comments are written as `p.w.WriteByte('#'); p.writeLit(strings.TrimRightFunc(c.Text, unicode.IsSpace))`; program text is regenerated from tokens; `KeepPadding` pads with spaces/tabs only; newlines are written as `'\n'`.
* `[S7]` mvdan/sh `syntax/parser.go` (read this run) — three targeted searches for `unicode.IsSpace`, `isSpace`, `isBlank` found **no** Unicode-space classification; only `' '`, `'\t'`, `'\n'`, `'\r'` and shell operators are special-cased.
* `[S8]` ShellCheck `src/ShellCheck/Fixer.hs` — fetched but **not read** ⇒ all shellcheck cells UNVERIFIED.

---

## 2. The whitespace classes that actually matter

| Class | Members | Used by |
|---|---|---|
| Python-lexer whitespace | SP, TAB, FF | CPython `[P1][P4]`, `tokenize.py` `[P6]`, ruff `[R1][R2]`, black's lib2to3 tokenizer (`[ \f\t]*`) `[B10]` |
| `str.isspace()` / `strip()` (Python) | Zs ∪ bidi {WS,B,S} = SP, TAB, LF, VT, FF, CR, NEL, NBSP, OGHAM, U+2000–U+200A, LS, PS, NNBSP, U+205F, IDEO, **and per bidi class U+001C–U+001F** | black docstrings/comments `[B3][B6][B9]`, autopep8 fixer `[A2]`, pycodestyle only partly `[A1]` |
| Unicode `White_Space` | `[U1]` = TAB..CR, SP, NEL, NBSP, OGHAM, U+2000–U+200A, LS, PS, NNBSP, U+205F, IDEO — **no U+001C–U+001F** | Rust `char::is_whitespace` `[U2]` ⇒ ruff docstring/comment trimming `[R3][R4]`, ruff W291 detection `[R7]`, Go `unicode.IsSpace` in shfmt `[S6]` |
| Shell legal whitespace | SP, TAB, LF only | bash `blank`/`metacharacter` `[S2]`, POSIX rules 7/8 `[S4]`, shfmt lexer `[S5]` |

**Interpretation:** the *lexer* classes agree across the stack (3–5 code points), but the *trimming* predicates differ between black (Python) and ruff (Unicode) and between pycodestyle and autopep8 — that difference, not the lexer class, is what can silently move line anchors.

---

## 3. Table 1 — CPython (language lexer), per code point

`WS` = whitespace separator; `NL` = line terminator; `REF-npc` = refused, `invalid non-printable character U+XXXX`; `kept` = literal content, no test applied; `ID-cont` = legal only inside an identifier.

| Code point | Lexer whitespace? | Code position | Inside string literal | Inside comment |
|---|---|---|---|---|
| SP U+0020 | yes `[P1][P4]` | separator `[P1]` | kept `[P1]` | kept `[P6]` |
| HT U+0009 | yes `[P1][P4]` | separator `[P1]` | kept `[P1]` | kept `[P6]` |
| FF U+000C | yes `[P1][P4]` | separator; at line start ignored for indentation; elsewhere in leading whitespace "undefined effect (may reset the space count to zero)" `[P2]`; a blank logical line may contain FF `[P3]` | kept `[P1]` | kept `[P6]` |
| LF U+000A | not whitespace — `NL` `[P6]` | NEWLINE token | content in triple-quoted literals only `[P8]` | terminates the comment `[P6]` |
| CR U+000D | not whitespace — `NL` `[P6]` | line terminator; the real parser decodes with universal newlines so a bare CR is a newline `[P9]` (medium), while the pure-Python tokenizer only accepts `\r?\n` `[P6]` | as LF; a bare CR inside a literal is rewritten to LF by universal-newline decoding (mechanism `[B5]`, medium) | terminates the comment `[P6]` |
| VT U+000B | **no** `[P1][P4]` | **REF-npc** `[P4][P5]` (Cc ⇒ not printable) | kept `[P8]` | kept `[P6]` |
| NEL U+0085 | **no** `[P1]` | **REF-npc** `[P4][P5][P7]` (Cc; reached via the non-ASCII identifier-candidate path `[P7]`) | kept `[P8]` | kept `[P6]` |
| NBSP U+00A0 | **no** `[P1]` | **REF-npc** `[P4][P5][P7]` (Zs) | kept `[P8]` | kept `[P6]` |
| SHY U+00AD | **no** `[P1]` | **REF-npc** `[P4][P5][P7]` (Cf) | kept `[P8]` | kept `[P6]` |
| OGHAM U+1680 | **no** `[P1]` | **REF-npc** (Zs) `[P4][P5][P7]` | kept `[P8]` | kept `[P6]` |
| U+2000 … U+200A | **no** `[P1]` | **REF-npc** (Zs) `[P4][P5][P7]` | kept `[P8]` | kept `[P6]` |
| ZWSP U+200B | **no** `[P1]` | **REF-npc** (Cf) `[P4][P5][P7]` | kept `[P8]` | kept `[P6]` |
| ZWNJ U+200C | **no** `[P1]` | **ID-cont**: legal inside an identifier (XID_Continue, Unicode 15.1+), rejected as token start ⇒ REF-npc `[P7]` (`[U3]` not fetched) | kept `[P8]` | kept `[P6]` |
| ZWJ U+200D | **no** `[P1]` | as ZWNJ `[P7]` | kept `[P8]` | kept `[P6]` |
| LRM U+200E | **no** `[P1]` | **REF-npc** (Cf, not XID) `[P4][P5][P7]` | kept `[P8]` | kept `[P6]` |
| RLM U+200F | **no** `[P1]` | **REF-npc** (Cf) `[P4][P5][P7]` | kept `[P8]` | kept `[P6]` |
| LS U+2028 | **no** `[P1]` | **REF-npc** (Zl ⇒ `category[0] == 'Z'`) `[P4][P5][P7]` | kept `[P8]`; **not** a line break for the lexer `[P6]` | kept `[P6]` |
| PS U+2029 | **no** `[P1]` | **REF-npc** (Zp) `[P4][P5][P7]` | kept `[P8]`; not a line break `[P6]` | kept `[P6]` |
| NNBSP U+202F | **no** `[P1]` | **REF-npc** (Zs) `[P4][P5][P7]` | kept `[P8]` | kept `[P6]` |
| U+205F | **no** `[P1]` | **REF-npc** (Zs) `[P4][P5][P7]` | kept `[P8]` | kept `[P6]` |
| IDEO U+3000 | **no** `[P1]` | **REF-npc** (Zs) `[P4][P5][P7]` | kept `[P8]` | kept `[P6]` |
| ZWNBSP U+FEFF | **no** `[P1]` | **REF-npc** (Cf); at byte 0 of a UTF-8-BOM file the BOM is consumed by the decoder (mechanism only, medium) `[P8]` | kept `[P8]` | kept `[P6]` |
| WJ U+2060 | **no** `[P1]` | **REF-npc** (Cf) `[P4][P5][P7]` | kept `[P8]` | kept `[P6]` |
| MVS U+180E | **no** `[P1]` | **REF-npc** (Cf since Unicode 6.3; Zs before ⇒ non-printable either way) `[P4][P5][P7]` | kept `[P8]` | kept `[P6]` |
| U+0080–U+009F (group) | **no** `[P1]` | **REF-npc** — all are Cc `[P4][P5]` (U+0085 included) | kept `[P8]` | kept `[P6]` |

Off-table but in scope: for **U+001C–U+001F** the same reasoning gives REF-npc in code position; inside docstrings/comments black treats them as whitespace (`str.isspace()` = bidi WS/B/S `[P5]`) while ruff does not (not White_Space `[U1][U2]`). The bidi classes themselves are **UNVERIFIED** (`[U3]`).

---

## 4. Table 2 — black, per code point

`WS→canonical` = re-emitted with canonical spacing; `DROP` = not reproduced; `REF` = `InvalidInput` ⇒ black reports the failure and leaves the file unwritten; `trim` = removed by a trimming predicate.

| Code point | Code position | At line end | Inside string literal / docstring | Inside comment |
|---|---|---|---|---|
| SP U+0020 | WS→canonical `[B9]` (prefixes rebuilt from `(nl_count, form_feed)`) | DROP `[B9]` | kept | trailing torn off by `content.rstrip()` `[B9]`; leading whitespace of a preserved comment kept via `pc.leading_whitespace` `[B9]` |
| HT U+0009 | WS→canonical `[B9]` | DROP `[B9]` | kept in normal strings; in docstrings leading tabs → spaces and `expandtabs(4)` counts tab stops `[B3][B6][B8]` | trailing `rstrip()` `[B9]` |
| FF U+000C | **WS, not dropped: retained on otherwise-empty lines at module level, one per group, placed on the second line of a two-line gap** `[B2]`; blank-line prefixes carry an explicit `form_feed` flag `[B9]` | retained/repositioned per `[B2]` | kept in normal strings; at docstring edges removed (Python-whitespace) `[B3]` | trailing `rstrip()` (Python-whitespace) `[B9]` |
| LF U+000A | newline | n/a | inside multi-line strings: line endings normalised to the file's detected ending `[B1][B5]` | comment ends here `[B9]` |
| CR U+000D | newline (universal newlines on decode) `[B5]` | n/a | **rewritten**: `\r`/`\r\n` inside a literal becomes the file's newline on output `[B5]` (in a CRLF file a lone LF becomes CRLF; in a CR-only file a lone LF becomes CR) | comment ends here `[B9]` |
| VT U+000B | **REF** — predicted `TokenError`/`ParseError` ⇒ `InvalidInput` `[B10]`; **UNVERIFIED** for this code point | n/a (not reached) | kept | trailing `rstrip()` (Python-whitespace) `[B9]` |
| NEL U+0085 | **REF** (predicted) `[B10]`, **UNVERIFIED** | n/a | kept in normal strings; removed at docstring edges `[B3]` | trailing `rstrip()` `[B9]` |
| NBSP U+00A0 | **REF** (predicted) `[B10]`, **UNVERIFIED** | n/a | kept in normal strings; removed at docstring edges `[B3]` | trailing `rstrip()`; **as first char after `#` black has a dedicated NBSP branch** `"\N{NO-BREAK SPACE}"` `[B9]` — ruff's reimplementation documents black's rules: a space is added before it for `#\xa0type:` pragmas, otherwise the first NBSP is replaced by a space `[R4]` |
| SHY U+00AD | **REF** (predicted) `[B10]`, **UNVERIFIED** | n/a | kept (not Python-whitespace ⇒ kept even at docstring edges) `[B3][P5]` | kept (not stripped by `rstrip()`) `[B9][P5]` |
| OGHAM U+1680 | **REF** (predicted) `[B10]`, **UNVERIFIED** | n/a | kept in normal strings; trimmed at docstring edges `[B3]` | trailing `rstrip()` `[B9]` |
| U+2000 … U+200A | as OGHAM | n/a | as OGHAM | trailing `rstrip()` `[B9]` |
| ZWSP U+200B | **REF** (predicted) `[B10]`, **UNVERIFIED** | n/a | kept everywhere (Cf is not Python-whitespace) `[P5]` | kept `[B9]` |
| ZWNJ U+200C / ZWJ U+200D | **REF (predicted, medium)** — black's tokenizer is lib2to3-based with `Name = r'\w+'`, and Python's `\w` does not match Cf ⇒ ERRORTOKEN/parse error; the regex itself was **not** quoted this run ⇒ **UNVERIFIED** | n/a | kept | kept |
| LRM U+200E / RLM U+200F | **REF** (predicted) `[B10]`, **UNVERIFIED** | n/a | kept | kept |
| LS U+2028 | **REF** (predicted) `[B10]`, **UNVERIFIED** | n/a | **kept — never turned into a newline**: the string/docstring line-break regex is `\r\n|[\r\n]` and `[B6]` explicitly rejects `str.splitlines()` (which would break on LS) | kept; not a comment terminator (`re.split("\r?\n|\r", prefix)`) `[B9]` |
| PS U+2029 | as LS | n/a | as LS `[B6]` | as LS `[B9]` |
| NNBSP U+202F / U+205F / IDEO U+3000 | **REF** (predicted) `[B10]`, **UNVERIFIED** | n/a | kept in normal strings; trimmed at docstring edges `[B3]` | trailing `rstrip()` `[B9]` |
| ZWNBSP U+FEFF | **REF** (predicted) unless it is the file BOM (black strips/re-adds a UTF-8 BOM on decode; mechanism only, medium) | n/a | kept | kept |
| WJ U+2060 | **REF** (predicted) `[B10]`, **UNVERIFIED** | n/a | kept | kept |
| MVS U+180E | **REF** (predicted) `[B10]`, **UNVERIFIED** | n/a | kept | kept |
| U+0080–U+009F | **REF** (predicted) `[B10]`, **UNVERIFIED** | n/a | kept (NEL excepted: trimmed at docstring edges `[B3]`) | kept; NEL trimmed by `rstrip()` `[B9]` |

Black's docstring pass `[B3][B4][B6][B8]`: leading tabs → spaces, per-line trailing whitespace removed, whitespace around one-line docstrings removed (`docstring.strip()`), re-indent to the code indent; **tabs inside the text are preserved**; docstrings containing an escaped newline are left alone (`[R3]` reports that rule for black). This is a *string literal* whose whitespace black rewrites by design `[B4]`.

---

## 5. Table 3 — ruff (parser + formatter), per code point

`REF-lex` = lexer `UnrecognizedToken` ⇒ parse error ⇒ `[R8]` aborts formatting for that file. Ruff's Rust trims use White_Space `[U1][U2]`.

| Code point | Code position | At line end | Inside string literal / docstring | Inside comment |
|---|---|---|---|---|
| SP U+0020 | WS, skipped `[R1][R2]` | not reproduced (code regenerated) — interpretation, medium | kept | trailing `trim_end()` `[R4]` |
| HT U+0009 | WS, skipped `[R1][R2]` | not reproduced | kept; in docstrings tab stops counted at 8 (`expandtabs`) and rewritten to spaces under `indent-style = space` `[R3]` | trailing `trim_end()` `[R4]` |
| FF U+000C | WS, skipped `[R1][R2]`; in indentation it **resets the indent counter to root** `[R1]` (mirrors `[P2]`); no FF retention is documented anywhere in ruff's settings `[R6]`, unlike black `[B2]` | not reproduced (FF is consumed as whitespace; no FF-preservation mechanism found) — interpretation, needs measurement | kept in normal strings (trimmed at docstring edges: FF ∈ White_Space) `[R3][U1]` | trailing `trim_end()` `[R4]` |
| LF U+000A | newline `[R1]` | n/a | **printed as the configured line ending** `[R5]` ⇒ in a CRLF file an LF inside a multi-line string becomes CRLF | comment ends here |
| CR U+000D | newline (`eat_char('\n')`) `[R1]` | n/a | rewritten to the configured line ending on output `[R5]` | comment ends here |
| VT U+000B | **REF-lex** — unknown ASCII ⇒ `UnrecognizedToken` `[R1]` | n/a | kept (trimmed at docstring edges: VT ∈ White_Space) `[U1][U2]` | trailing `trim_end()` `[R4]` |
| NEL U+0085 | **REF-lex** (non-ASCII, not XID_Start) `[R1]` | n/a | kept; docstring edges trimmed `[R3][U1]` | trailing `trim_end()` `[R4]` |
| NBSP U+00A0 | **REF-lex** `[R1]` | n/a | kept; docstring edges trimmed `[R3][U1]` | trailing `trim_end()`; **NBSP immediately after `#` is rewritten**: a space is added before it if it precedes `type:`, otherwise the first NBSP becomes a regular space `[R4]` |
| SHY U+00AD | **REF-lex** `[R1]` | n/a | kept (not White_Space ⇒ not even docstring-edge trimmed) `[R3][U1]` | kept `[R4]` |
| OGHAM U+1680 … U+200A | **REF-lex** `[R1]` | n/a | kept; docstring edges trimmed `[R3][U1]` | trailing `trim_end()` `[R4]` |
| ZWSP U+200B | **REF-lex** `[R1]` | n/a | kept (Cf, not White_Space) `[U1]` | kept `[R4]` |
| ZWNJ U+200C / ZWJ U+200D | accepted **inside identifiers** (`is_unicode_identifier_continue`); as a token start ⇒ **REF-lex** `[R1]` | n/a | kept | kept |
| LRM U+200E / RLM U+200F | **REF-lex** `[R1]` (not XID ⇒ UnrecognizedToken) | n/a | kept | kept |
| LS U+2028 / PS U+2029 | **REF-lex** `[R1]` | n/a | **kept — never turned into a newline**: docstring handling splits on `'\n'` only `[R3]`; non-docstring string content is emitted as a source slice `[R4]` | kept `[R4]` |
| NNBSP U+202F / U+205F / IDEO U+3000 | **REF-lex** `[R1]` | n/a | kept; docstring edges trimmed `[U1][R3]` | trailing `trim_end()` `[R4]` |
| ZWNBSP U+FEFF | at offset 0 **eaten as a BOM** `[R1]` (dropped from output); anywhere else **REF-lex** `[R1]` | n/a | kept | kept `[R4]` |
| WJ U+2060 | **REF-lex** `[R1]` | n/a | kept | kept `[R4]` |
| MVS U+180E | **REF-lex** `[R1]` | n/a | kept | kept `[R4]` |
| U+0080–U+009F | **REF-lex** (all Cc, non-XID) `[R1]` | n/a | kept | kept, except a trailing NEL (U+0085 ∈ White_Space) which `trim_end()` removes `[R4][U1]` |

Ruff docstring pass `[R3]`: trailing whitespace per line trimmed (chaperone space kept), first-line leading whitespace trimmed, indentation rewritten to the suite indent, tabs re-counted at 8-column stops and rewritten to spaces for `indent-style = space`, single-line docstrings collapsed; docstrings containing an escaped newline are excluded; `docstring-code` re-formatting is opt-in `[R6]`.

---

## 6. Table 4 — Python **lint** autofixes (pycodestyle / autopep8)

Row groups list every requested code point; behaviour is identical within a group. `flag` = reported; `no-flag` = not reported; `DROP-all` = bare `str.rstrip()` (Python-whitespace `[P5]`) removes the whole trailing run.

| Code point | pycodestyle W291/W293 | autopep8 fix |
|---|---|---|
| SP, HT | `flag` — after `rstrip('\n\r\x0c')` the predicate is `rstrip(' \t\v')` `[A1]` | line truncated at the last non-` \t\v` char, then `+ '\n'` `[A2]` |
| VT U+000B | `flag` — VT **is** in the pycodestyle trailing set `[A1]` | DROP-all (VT is Python-whitespace) `[A2][P5]` |
| FF U+000C | **`no-flag`** — FF is rstripped *before* the test, so a line ending in FF is not "trailing whitespace" `[A1]` | untouched unless another trailing char triggers W291 `[A2]` |
| LF, CR | line terminators, rstripped first `[A1]` | converted to the file's dominant ending (`find_newline` counts CRLF/CR/LF) `[A2]` |
| NEL, NBSP, OGHAM, U+2000–U+200A, LS, PS, NNBSP, U+205F, IDEO | `no-flag` — not in `' \t\v'` `[A1]` | **removed anyway when W291/W293 fires for any other reason**, because `fix_w291` uses bare `.rstrip()` `[A2][P5]` |
| ZWSP, ZWNBSP, SHY, WJ, MVS, LRM, RLM | `no-flag` `[A1]` | untouched (not Python-whitespace) `[A2][P5]` |
| ZWNJ, ZWJ | `no-flag` `[A1]` | untouched `[A2]` |
| U+0080–U+009F | `no-flag` `[A1]` | untouched, except NEL (Python-whitespace) which `rstrip()` removes `[A2][P5]` |

Also: autopep8 strips only `' \t\v'` when computing indentation `[A2]`; `find_newline`/`normalize_line_endings` rewrite *every* line ending to the most common one `[A2]`; `split_and_strip_non_empty_lines()` uses `str.splitlines()` — a predicate that treats FF/VT/NEL/LS/PS/U+001C–U+001F as line breaks, and I could not establish that its result ever rebuilds output ⇒ residual risk (§11).

---

## 7. Table 5 — POSIX sh / bash, per code point

| Code point | Legal shell whitespace? | Code position | Inside single/double quotes, heredoc body |
|---|---|---|---|
| SP U+0020 | yes (`<blank>`, `metacharacter`) `[S2][S4]` | token delimiter, discarded (POSIX rule 7) `[S4]` | literal `[S3]` |
| HT U+0009 | yes (`<blank>`) `[S2]` | token delimiter `[S4]` | literal `[S3]` |
| LF U+000A | yes (`<newline>`; always IFS whitespace) `[S1][S2]` | command terminator | literal `[S3]` |
| FF U+000C | **no** `[S2][S4]` | part of a word (rule 8) `[S4]` ⇒ `echo␌x` is a single word | literal `[S3]` |
| VT U+000B | **no** `[S2][S4]` | part of a word `[S4]` | literal `[S3]` |
| CR U+000D | **no** `[S2][S4]` | part of a word `[S4]` — hence CRLF scripts whose `\r` ends up inside the command name (folklore, not cited this run) | literal `[S3]` |
| NEL, NBSP, OGHAM, U+2000–U+200A, LS, PS, NNBSP, U+205F, IDEO, ZWSP, ZWNBSP, SHY, WJ, MVS, LRM, RLM, ZWNJ, ZWJ, U+0080–U+009F | **no** metacharacter/blank; ordinary word characters `[S2][S4]` | part of a word (rule 8) `[S4]`; no error, never normalised | literal `[S3]` |

Anchor caveat: bash's *definition* of `whitespace` is locale/`isspace()`-based `[S2]`, and IFS whitespace is "space, tab and newline … always … even if they don't appear in the locale's space category" `[S1]` ⇒ in a locale whose `space` class contains other characters, those can act as IFS whitespace during expansion and for `read`, even though the *tokenizer* never treats them as blanks. Whether any real UTF-8 locale extends `isspace()`/`[[:space:]]` beyond White_Space is **UNVERIFIED**.

---

## 8. Table 6 — shfmt (mvdan/sh), per code point

| Code point | Code position | At line end | String / heredoc interior | Comment |
|---|---|---|---|---|
| SP U+0020 | whitespace (`case ' ', '\t', '\r'`) `[S5]` | not reproduced (program regenerated from tokens) `[S6]` | literal `[S6]` | trailing run trimmed by `TrimRightFunc(..., unicode.IsSpace)` `[S6]` |
| HT U+0009 | whitespace `[S5]` | not reproduced | literal | trailing trimmed `[S6]` |
| LF U+000A | newline token `[S5]`; printer writes `'\n'` `[S6]` | — | literal | comment terminator |
| CR U+000D | **whitespace**: `case ' ', '\t', '\r': p.spaced = true`; a CR before LF is dropped (`\r\n → \n`) `[S5]` | **dropped**, not a line break | CR inside a quoted string/heredoc body stays part of the literal text (interpretation from `[S5]`, medium) | trailing trimmed `[S6]` |
| FF U+000C, VT U+000B, NEL, NBSP, OGHAM, U+2000–U+200A, LS, PS, NNBSP, U+205F, IDEO, ZWSP, ZWNBSP, SHY, WJ, MVS, LRM, RLM, ZWNJ, ZWJ, U+0080–U+009F | **not whitespace** — only `' '`, `'\t'`, `'\r'`, `'\n'`, `'\0'`, backslash are special-cased `[S5]`; no Unicode-space classification exists in the parser `[S7]` ⇒ part of a word, preserved verbatim | reproduced verbatim as part of that word | literal | trailing trimmed for the White_Space members (FF, VT, NEL, NBSP, OGHAM, 2000–200A, LS, PS, NNBSP, 205F, IDEO) because Go's `unicode.IsSpace` is White_Space-based `[S6][U1]`; **kept** for ZWSP, ZWNBSP, SHY, WJ, MVS, LRM/RLM, ZWNJ/ZWJ and U+0080–U+009F (NEL excepted) |

Shfmt refusals: invalid UTF-8 (`"invalid UTF-8 encoding"`) is the only encoding-level rejection; NUL bytes are silently ignored "like bash" `[S5]`. No requested code point is refused (all are valid UTF-8 and legal word characters).

---

## 9. Table 7 — shellcheck

Every cell is **UNVERIFIED**: shellcheck's parser and fixer were not read this run (`[S8]` fetched only). From design alone (interpretation): shellcheck is a linter, never rewrites files, and its fixes exist as a diff mode implemented as textual `repair`/`replace` operations in `Fixer.hs`. Whether it flags exotic whitespace, and whether any fix inserts a non-ASCII whitespace character, must be measured (§12).

---

## 10. Table 8 — line-ending policy per tool

| Tool | Default | CRLF | bare CR | Evidence |
|---|---|---|---|---|
| CPython lexer | universal newlines on decode (LF internally) | newline | newline | `[P6]` shows `\r?\n` for the pure-Python tokenizer; the decoding statement is interpretation (medium) `[P9]` |
| black | normalise to the **first** line ending of the file; `--line-ending` can force `lf`/`crlf` | preserved if first | preserved as `"\r"`-only output (`decode_bytes` can return `"\r"`) | `[B1][B5]` |
| ruff | `line-ending = auto` (default), detected per file, first wins on mixed files; every `\n` in the output is printed as that ending, including inside string literals | preserved when detected | normalised to the detected ending | `[R5][R6][R9]` |
| autopep8 | detects the most common ending, works internally in LF, converts back | rewritten to the dominant ending | counted by `find_newline`; a CR-only file has no `\n`-delimited lines ⇒ edge case **UNVERIFIED** | `[A2]` |
| pycodestyle | read-only, writes nothing | n/a | n/a | `[A1]` |
| shfmt | LF only; `\r` consumed as whitespace, `\r\n` collapsed to `\n`; no CRLF option | **converted to LF** | **removed** (not a line break) | `[S5][S6]` |
| bash | no rewriting (bash is not a formatter) | n/a | n/a | `[S1][S2]` |
| shellcheck | does not write files (diff output only) | n/a | n/a | **UNVERIFIED** `[S8]` |

---

## 11. Explicit answers

**(a) Does any of these formatters rewrite whitespace INSIDE string literals, comments, or regex literals?**
Yes, in four distinct ways, each restricted to a specific code-point set:
1. **black docstrings** `[B3][B4][B8]`: leading tabs → spaces, per-line trailing whitespace removed, leading/trailing whitespace of one-line docstrings removed, re-indentation. Affected code points = Python's `isspace()` set `[P5]`: SP, HT, VT, FF, NEL, NBSP, OGHAM, U+2000–U+200A, LS, PS, NNBSP, U+205F, IDEO (and, per bidi class, U+001C–U+001F) — i.e. **including LS/PS/NEL/NBSP** — but not ZWSP/ZWNBSP/SHY/WJ/MVS/LRM/RLM, which Python does not consider whitespace.
2. **ruff docstrings** `[R3]`: same shape, Unicode predicate (`trim_start`/`trim_end` = White_Space `[U1][U2]` ⇒ SP, HT, LF, VT, FF, CR, NEL, NBSP, OGHAM, U+2000–U+200A, LS, PS, NNBSP, U+205F, IDEO; **not** U+001C–U+001F, **not** the Cf group). Ruff's source comment states this divergence from black explicitly `[R3]`.
3. **Comments**: black rstrip()s comment text with the Python predicate and has a dedicated NBSP branch `[B9]`; ruff trims with `trim_end()` and rewrites a leading NBSP to a space (except `#\xa0type:` pragmas) `[R4]`; shfmt trims trailing comment text with Go's `unicode.IsSpace` `[S6]`. Removed-in-comment set: SP, HT, VT, FF, NEL, NBSP, OGHAM, U+2000–U+200A, LS, PS, NNBSP, U+205F, IDEO (plus U+001C–U+001F for black). Replaced by SP: NBSP directly after `#` (black and ruff). Note ruff `[R4]` also *removes all whitespace* between comment lines inside parenthesised expressions.
4. **Line endings inside literals**: black `[B5]` and ruff `[R5]` rewrite LF/CR inside multi-line strings to the file's line ending; autopep8 rewrites line endings per physical line `[A2]`. This changes the string's *value*, and neither tool calls it out in the docs (black only via the `decode_bytes` docstring `[B5]`).
   Otherwise, plain (non-docstring) Python string interiors are preserved: no formatter here trims or rewrites SP/HT/VT/FF/Zs/LS/PS inside a plain literal. There is no regex literal in Python or shell — Python `re` patterns are ordinary strings and follow the string rules.
5. **Lint autofix**: ruff's W291 fix deletes trailing whitespace, including inside multi-line strings (marked unsafe for that reason) `[R7]`, using Rust's White_Space predicate ⇒ it can remove trailing VT/FF/NEL/NBSP/LS/PS/U+3000 *inside a multi-line string* when enabled. autopep8's W291 fix uses bare `rstrip()` ⇒ removes trailing Python-whitespace including NBSP/NEL/LS/PS `[A2][P5]`.

**(b) Do any convert LS/PS U+2028/U+2029 into a real newline (changing the line count)?**
No evidence of such a conversion, and one explicit design guard against it: black's `strings.py` comment says `str.splitlines()` "also breaks on form feed, vertical tab, NEL, the Unicode line and paragraph separators and the C0 separators, all of which are ordinary characters of a string's value", which is why black uses `LINE_BREAK_RE = \r\n|[\r\n]` `[B6]`, `output._splitlines_no_ff` `[B7]` and `re.split("\r?\n|\r", prefix)` `[B9]`; ruff's docstring path splits on `'\n'` only `[R3]`; CPython, black and ruff refuse LS/PS in code position; shfmt and bash treat them as word characters `[S4][S5]`. Residual risk: helpers that *do* call `str.splitlines()` on source (`autopep8.split_and_strip_non_empty_lines` `[A2]`) would split on LS/PS — I could not prove their result never rebuilds the file, so this is the one place a line count could change (`§14` item 3). Conversely, real CR/CRLF *are* rewritten inside literals (see (a) 4): that changes bytes but not line counts.

**(c) Can any formatter or lint autofix INTRODUCE one of these code points?**
No formatter here introduces NBSP, ZWSP, ZWNBSP, SHY, WJ, MVS, LRM, RLM or any Zs character, and none emits a form feed that was not already present; every insertion observed is ASCII SP (`make_comment`/`normalize_comment` add a space after `#` `[B9][R4]`; black's docstring padding adds a space `[B8]`; black's docstring tab expansion adds spaces `[B6]`; ruff's indentation rewrite adds spaces `[R3]`). Two exceptions worth flagging:
* **U+000D can appear inside a string literal after formatting**: black/ruff write every newline in the output — including inside literals — as the file's line ending `[B1][B5][R5][R6]`, so in a CRLF (or CR-only) file a lone LF inside a literal becomes CRLF (or CR).
* ruff *keeps* an NBSP in the `#\xa0type:` case (it adds a SP before it instead of replacing it) `[R4]`; it never creates one.

**(d) Line-ending default and CRLF/CR normalisation** — Table 8. Summary: black normalises to the file's *first* line ending and can emit CR-only `[B1][B5]`; ruff defaults to `auto` (per-file detection, first wins) `[R6]`; autopep8 normalises to the *most common* ending `[A2]`; shfmt is LF-only and deletes bare CR `[S5]`; CPython treats CR and CRLF as newlines; bash and shellcheck never rewrite files.

---

## 12. Contradictions with the measured baseline

1. **ruff's error text.** Baseline: ruff format reports `invalid non-printable character`. Source: that string exists only in CPython (`[P4]`, `[P7]`); ruff's lexer has no printable test at all and emits `LexicalErrorType::UnrecognizedToken { tok: c }` `[R1]`, rendered as "Got unexpected token …". The *refusal* is consistent (`[R8]` aborts the file); the *message attribution* looks wrong. Re-measure and record the exact string and ruff version.
2. **ruff + FF is stronger than "accepted"**: FF is whitespace *and* resets the indentation counter `[R1][R2]`, so FF at line start is semantically significant. Unlike black, ruff documents no FF retention `[R6]` — **black and ruff differ on FF survival** (one FF per blank-line group, module level, for black `[B2]`), which the JS-only baseline did not cover.
3. **pycodestyle and autopep8 disagree on trailing VT/FF**: pycodestyle flags trailing VT but *not* trailing FF `[A1]`; autopep8's fix then removes the *entire* trailing Python-whitespace run, including NBSP/NEL/LS/PS `[A2]`. "Trailing whitespace" is two different sets in one toolchain.
4. **black vs ruff trimming predicates differ by design**: black = Python `isspace()` (bidi WS/B/S ∪ Zs, includes U+001C–U+001F) `[P5]`; ruff = Unicode White_Space (excludes U+001C–U+001F) `[U1][U2]`, documented as deliberate `[R3]`. A canonical class based on "what the formatter trims" must pick one.
5. Baseline "ZWNJ/ZWJ are identifier characters" holds for ruff's `is_unicode_identifier_continue` path `[R1]`, but note CPython and ruff both reject a **leading** ZWNJ/ZWJ (XID_Continue, not XID_Start), and black may reject them outright (see Table 2).

---

## 13. Missing evidence / residual risk

**UNVERIFIED cells.**
* black code-position verdicts for every exotic code point (VT, NEL, NBSP, Zs, ZWSP, ZWNBSP, SHY, WJ, MVS, LRM/RLM, U+0080–U+009F, ZWNJ/ZWJ): predicted `InvalidInput` from the `[B10]` mechanism; black's tokenizer regexes (`blib2to3/pgen2/tokenize.py`) were not quoted this run.
* CPython in-literal acceptance `[P8]` (`scan_string` body not retrieved); the "kept" verdict rests on `[P1]` ("or in string literals"), the absence of a printable test in ruff's mirror `[R1]`, and `[P6]`.
* CPython U+001C–U+001F `isspace()` verdict (bidi classes not fetched `[U3]`), and CPython's universal-newline decoding `[P9]`.
* black's NBSP-in-comment branch tail `[B9]` (only the first condition was read).
* ruff: whether FF survives anywhere in output; whether trailing whitespace inside a comment on a code line is trimmed for every node level (the `[R4]` code path trims, but I did not audit every call site).
* shfmt: CR inside heredoc/string bodies; whether the printer can emit anything but `\n` (no CRLF option found `[S6]`).
* glibc `isspace()`/`[[:space:]]` for non-ASCII code points in UTF-8 locales (affects bash IFS/`read` `[S1][S2]`).
* everything about shellcheck `[S8]`.

**Residual risks for a canonical whitespace class.**
* `str.splitlines()`-based helpers could turn LS/PS (or FF/VT/NEL/U+001C–U+001F) into real newlines: proven avoided in black `[B6][B7][B9]` and ruff `[R3]`, only *suspected* in autopep8 `[A2]`.
* Newline-in-literal rewriting (black, ruff, autopep8) changes string values; hash line content after that rewrite, or exclude literal-interior lines.
* Comment-internal whitespace is edited by black, ruff and shfmt (trailing runs) and NBSP-after-`#` is rewritten by both Python formatters — comment anchors must ignore trailing comment whitespace and normalise `#\xa0`.

---

## 14. Sources

**Kept (primary, decision-relevant).**
* Python Reference lexical analysis §2.1.7–2.1.9 `[P1][P2][P3]` — the only official statement of the Python whitespace class and the form-feed indentation rule.
* `Parser/lexer/lexer.c`, `Tools/unicode/makeunicodedata.py`, `Lib/tokenize.py` `[P4]–[P7]` — the exact refusal predicate and the two whitespace predicates CPython defines.
* black docs (line endings, form feed, docstrings, AST differences) `[B1]–[B4]` — the only place black states FF retention and docstring whitespace rewriting.
* `black/strings.py`, `output.py`, `linegen.py`, `comments.py`, `parsing.py`, `__init__.py` `[B5]–[B10]` — the mechanisms behind those doc statements, including the deliberate rejection of `str.splitlines()`.
* ruff `lexer.rs`, `ruff_python_trivia/whitespace.rs`, `string/docstring.rs`, `comments/format.rs`, `printer/mod.rs`, `trailing_whitespace.rs`, `commands/format.rs`, `options.rs` + settings docs `[R1]–[R9]`.
* pycodestyle `trailing_whitespace`; autopep8 `fix_w291`, `find_newline`, `normalize_line_endings`, `fix_lines` `[A1][A2]`.
* POSIX XCU ch. 2 rules 7/8 + LC_CTYPE; Bash manual Definitions, Word Splitting, Quoting `[S1]–[S4]`.
* mvdan/sh `lexer.go`, `printer.go`, `parser.go` `[S5][S6][S7]`.
* Unicode `PropList.txt` and rust core `methods.rs` `[U1][U2]` — the exact White_Space list used by ruff's and Go's predicates.

**Rejected / deprioritised.**
* Search-engine summaries claiming "form feed is preserved" without naming the tool — replaced by black's own documentation `[B2]`.
* Ruff settings docs as a source for FF: no FF option is documented; kept only as *negative* evidence `[R6]`.
* `UnicodeData.txt` and `DerivedBidiClass.txt`: not fetched ⇒ bidi-class claims left UNVERIFIED rather than guessed.
* ShellCheck `Fixer.hs` (fetched, unread) and its man page — excluded rather than guessed.

---

## 15. Next steps (measurement matrix, highest value first)

1. **black, one command per code point**: `x<CP>= 1`, `x = 1<CP>`, `"""a<CP>\nb"""`, `# c<CP>` — establishes which code points black *refuses* vs drops, FF/blank-line retention, and the comment trailing/NBSP rules. Closes the largest UNVERIFIED block.
2. **ruff format + `ruff check --select W291,W293 --diff`** on the same fixtures, plus a CRLF fixture with a literal-internal LF, to confirm comment trailing trims at every node level and the line-ending-in-literal rewrite `[R5]`.
3. **autopep8 splitlines risk**: fixture with LS/PS inside a multi-line string on a line that also triggers W291/W293; diff line count before/after.
4. **shfmt**: CRLF file; heredoc containing CR; comment with trailing NBSP/VT/FF; `foo<NBSP>=bar` word binding.
5. **bash**: `echo<NBSP>x`, `echo<VT>x`, `x=1<CR>`, a CRLF script; `IFS` + `read` under a non-C locale to test the locale-dependent `whitespace` definition `[S1][S2]`.
6. **shellcheck**: `--format=diff` on a file containing NBSP/VT/FF in code and in comments; decide whether shellcheck is in scope for the canonical class at all.
