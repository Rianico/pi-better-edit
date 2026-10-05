# Whitespace / invisible-code-point behaviour of the JS/TS stack

Scope: which invisible / whitespace code points are (a) accepted by JS/TS lexers, (b) normalized,
stripped or refused by prettier, Biome, oxc/oxfmt, and (c) reported/fixed by ESLint & oxlint —
input to freezing a "canonical whitespace class" for per-line content anchors.

Evidence legend (every cell carries one):

| Tag | Meaning |
| --- | --- |
| `SRC` | Direct primary source read in this run (spec text, formatter/linter source file, official docs). |
| `MEAS` | Measured by the *parent* run (binary diff after running the formatter on scratch files). Quoted, not re-run. |
| `INFER` | Researcher derivation from a `SRC` mechanism (labelled as such; not a source statement). |
| `UNVERIFIED` | Not verified. Do **not** treat as fact. |

Execution disclosure: this run had **no shell/exec tool available** (read/write/web only), so *no*
formatter was installed or executed here. Every `MEAS` cell is the parent's measurement; every
other cell is source-derived or marked `UNVERIFIED`. V8/Node acceptance is **not** measured here.

---

## 1. Language level (ECMA-262, 13th ed. draft / tc39.es)

`WhiteSpace :: <TAB> <VT> <FF> <ZWNBSP> <USP>` where `<USP>` = any code point with the Unicode
`Space_Separator` (`Zs`) property. LineTerminator = LF, CR, LS, PS. Sources: ECMA-262
[White Space Code Points table](https://tc39.es/ecma262/#sec-white-space),
[Line Terminator Code Points table](https://tc39.es/ecma262/#sec-line-terminators),
[format-control characters](https://tc39.es/ecma262/#sec-format-control-characters),
[string literals](https://tc39.es/ecma262/#sec-string-literals).

Key spec facts used below (`SRC`):

* White space is **TAB, VT, FF, ZWNBSP (U+FEFF) and `Zs` only** — `Zs` = SP, NBSP, OGHAM U+1680,
  U+2000–U+200A, NNBSP U+202F, MMSP U+205F, IDEO U+3000 (that list is closed, not "any space-ish char").
* ECMA-262 states explicitly that WhiteSpace **"intentionally excludes all code points that have the
  Unicode `White_Space` property but which are not classified in general category `Space_Separator` (Zs)"**
  → NEL U+0085, LS U+2028, PS U+2029, MVS U+180E are **not** white space. NEL and MVS are not
  line terminators either; LS/PS are line terminators.
* Format-control characters (`Cf`): ZWNJ U+200C, ZWJ U+200D, LRM U+200E, RLM U+200F (and other `Cf`)
  may appear **inside comments, string literals, template literals, regex literals and identifiers**;
  outside those they are not white space. ZWNBSP is special-cased as white space outside those positions.
* IdentifierPart includes ZWNJ/ZWJ (`Other_ID_Continue`-style exception), so they are legal mid-identifier.
* Since ES2019 (JSON-superset), **all code points may appear literally in a string literal except the
  closing quote code point, U+005C, U+000D (CR) and U+000A (LF)** → bare LS/PS are legal inside
  string literals; bare CR/LF are still syntax errors.

### 1.1 Lexer acceptance per parser (column: "language lexer treats as whitespace?")

| Code point | ECMA-262 | Babel (prettier's default JS parser) | oxc_parser (oxfmt) | Biome JS lexer | TypeScript `tsc`/`espree` |
| --- | --- | --- | --- | --- | --- |
| SP U+0020 | WhiteSpace | WS (`SRC`) | WS (`SRC`) | WS (`SRC`) | WS (spec; `UNVERIFIED` in source here) |
| HT U+0009 | WhiteSpace | WS (`SRC`) | WS (`SRC`) | WS (`SRC`) | WS (`UNVERIFIED`) |
| LF U+000A | LineTerminator | LT (`SRC`) | LT (`SRC`) | LT (`SRC`) | LT (`UNVERIFIED`) |
| CR U+000D | LineTerminator | LT (`SRC`) | LT (`SRC`) | LT (`SRC`) | LT (`UNVERIFIED`) |
| VT U+000B | WhiteSpace | WS (`SRC`) | irregular WS → trivia, skipped (`SRC`) | WS (`SRC`) | WS (`UNVERIFIED`) |
| FF U+000C | WhiteSpace | WS (`SRC`) | irregular WS → trivia, skipped (`SRC`) | WS (`SRC`) | WS (`UNVERIFIED`) |
| NEL U+0085 | **not WS, not LT** | **not WS → parse error** (`SRC`) | irregular WS → trivia, skipped (`SRC`) | not in lexer WS table → likely refused (`SRC` table lacks it / `INFER`) | `UNVERIFIED` |
| NBSP U+00A0 | WhiteSpace (`Zs`) | WS (`SRC`) | irregular WS → trivia, skipped (`SRC`) | WS (`SRC`) | `UNVERIFIED` |
| OGHAM U+1680 | WhiteSpace (`Zs`) | WS (`SRC`) | irregular WS → trivia (`SRC`) | WS (`SRC`) | `UNVERIFIED` |
| U+2000–U+2008 (each) | WhiteSpace (`Zs`) | WS (`SRC`) | irregular WS → trivia (`SRC`) | WS (`SRC`) | `UNVERIFIED` |
| U+2009 | WhiteSpace (`Zs`) | WS (`SRC`) | irregular WS → trivia (`SRC`) | WS (`SRC`) | `UNVERIFIED` |
| U+200A | WhiteSpace (`Zs`) | WS (`SRC`) | irregular WS → trivia (`SRC`) | WS (`SRC`) | `UNVERIFIED` |
| LS U+2028 | **LineTerminator** | LT (`SRC`) | irregular **line terminator** → trivia + `is_on_new_line` (`SRC`) | LT (`UNVERIFIED`) | `UNVERIFIED` |
| PS U+2029 | **LineTerminator** | LT (`SRC`) | irregular **line terminator** → trivia + `is_on_new_line` (`SRC`) | LT (`UNVERIFIED`) | `UNVERIFIED` |
| NNBSP U+202F | WhiteSpace (`Zs`) | WS (`SRC`) | irregular WS → trivia (`SRC`) | WS (`SRC`) | `UNVERIFIED` |
| MMSP U+205F | WhiteSpace (`Zs`) | WS (`SRC`) | irregular WS → trivia (`SRC`) | WS (`SRC`) | `UNVERIFIED` |
| IDEO U+3000 | WhiteSpace (`Zs`) | WS (`SRC`) | irregular WS → trivia (`SRC`) | WS (`SRC`) | `UNVERIFIED` |
| ZWSP U+200B | **not WS** (`Cf`, only allowed *inside* literals/comments) | **not WS → parse error** (`SRC`) | irregular WS → trivia, skipped (`SRC`) | WS (`SRC` — present in lexer table) | `UNVERIFIED` |
| ZWNJ U+200C | IdentifierPart | identifier char (`SRC`: base is `ID_Continue`; ZWNJ/ZWJ special-cased in IdentifierPart) | identifier continue char (`SRC`) | `UNVERIFIED` | `UNVERIFIED` |
| ZWJ U+200D | IdentifierPart | identifier char (`SRC`, as above) | identifier continue char (`SRC`) | `UNVERIFIED` | `UNVERIFIED` |
| LRM U+200E | `Cf`; not WS outside comments/literals | `UNVERIFIED` (outside comment/literal position) | not in irregular-WS set → invalid char → error (`SRC` + `INFER`) | `UNVERIFIED` | `UNVERIFIED` |
| RLM U+200F | `Cf`; same as LRM | `UNVERIFIED` | invalid char → error (`SRC` + `INFER`) | `UNVERIFIED` | `UNVERIFIED` |
| ZWNBSP U+FEFF | **WhiteSpace** (outside literal/comment) | WS (`SRC`) | irregular WS → trivia (`SRC`) | WS (`SRC`) | `UNVERIFIED` |
| SHY U+00AD | `Cf`; not WS | not WS → parse error (`SRC` + `INFER`) | not WS, not in irregular set → invalid char → error (`SRC`) | `UNVERIFIED` | `UNVERIFIED` |
| WJ U+2060 | `Cf`; not WS | not WS → parse error (`SRC` + `INFER`) | invalid char → error (`SRC`) | `UNVERIFIED` | `UNVERIFIED` |
| MVS U+180E | `Cf` (was White_Space pre-Unicode 6.3); not WS | not WS → parse error (`SRC` + `INFER`) | **not** in `is_irregular_whitespace` → invalid char → error (`SRC`) | `UNVERIFIED` | `UNVERIFIED` |
| U+0080–U+009F controls (group) | not WS (NEL is one of them) | not WS → parse error except NEL?? — NEL itself is **rejected** (`SRC`) | NEL skipped as irregular WS; other C1 controls → invalid char error (`SRC` + `INFER`) | `UNVERIFIED` | `UNVERIFIED` |

Source anchors for this table (`SRC`):

* [Babel `util/whitespace.ts`](https://github.com/babel/babel/blob/main/packages/babel-parser/src/util/whitespace.ts) — `isWhitespace(ch)` matches exactly the ECMA Table-31 set (TAB, VT, FF, SP, NBSP, U+1680, U+2000–U+200A, U+202F, U+205F, U+3000, U+FEFF). **No U+200B, no U+0085.** Babel's tokenizer calls this from `skipSpace`.
* [`oxc_syntax::identifier`](https://github.com/oxc-project/oxc/blob/main/crates/oxc_syntax/src/identifier.rs) — `is_white_space(c) = TAB|VT|FF|ZWNBSP || Zs`; `is_irregular_whitespace(c) = VT|FF|NBSP|ZWNBSP|NEL|OGHAM|U+2000..=U+200B|NNBSP|MMSP|IDEO` (comment references ESLint's `no-irregular-whitespace`); `is_identifier_part_unicode = ID_Continue || ZWNJ || ZWJ`. Note: **U+200B is in the irregular set and NEL is; U+180E is not.**
* [`oxc_syntax::line_terminator`](https://github.com/oxc-project/oxc/blob/main/crates/oxc_syntax/src/line_terminator.rs) — regular line terminators LF/CR; `is_irregular_line_terminator(LF|CR) = false`, i.e. LS/PS are the irregular ones.
* [`oxc_parser/src/lexer/unicode.rs`](https://github.com/oxc-project/oxc/blob/main/crates/oxc_parser/src/lexer/unicode.rs) — `unicode_char_handler` order: U+FFFD → "binary file"; `is_identifier_start_unicode` → identifier; `is_irregular_whitespace` → `handle_irregular_whitespace` (consume + trivia); `is_irregular_line_terminator` → `handle_irregular_line_terminator` (skip + newline); **else `handle_invalid_unicode_char` (error)**.
* [`oxc_parser/src/lexer/byte_handlers.rs`](https://github.com/oxc-project/oxc/blob/main/crates/oxc_parser/src/lexer/byte_handlers.rs) — ASCII: `SPS` (space/tab) → skip; `ISP` (**VT/FF**) → consume char, `trivia_builder.add_irregular_whitespace(...)`, `Kind::Skip`.
* [`oxc_parser/src/lexer/whitespace.rs`](https://github.com/oxc-project/oxc/blob/main/crates/oxc_parser/src/lexer/whitespace.rs) — fast path consumes only SP/TAB/CR/LF.
* [`biome_js_parser/src/lexer/mod.rs`](https://github.com/biomejs/biome/blob/main/crates/biome_js_parser/src/lexer/mod.rs) — whitespace table `UNICODE_SPACES` (19 entries, incl. U+200B and U+FEFF; U+0085 absent).

---

## 2. Formatter behaviour

### 2.1 oxfmt (Oxc formatter, prettier-compatible) — primary stack formatter

Mechanism (`SRC`): the Oxc lexer never lets irregular whitespace reach the parser as an error; it is
consumed as **trivia** (VT/FF in the ASCII byte handler; NBSP/NEL/Zs/U+200B/ZWNBSP via
`is_irregular_whitespace`; LS/PS via `is_irregular_line_terminator`). Code points that are neither
white space, irregular white space, irregular line terminator, nor an identifier char hit
`handle_invalid_unicode_char` → **file refused (parse error)**.

| Code point | in code position | at line end | inside string literal | inside comment | line-ending policy |
| --- | --- | --- | --- | --- | --- |
| SP, HT | one space (MEAS) | removed (MEAS) | preserved (MEAS) | preserved (MEAS) | `endOfLine`: `lf` default, `crlf`, `cr` allowed, **no `auto`** (docs, `SRC`) |
| LF, CR | line break (MEAS) | n/a | bare CR/LF in string = error per spec (`SRC`); CRLF/CR normalized to the configured ending when printed (`INFER` from config; `UNVERIFIED` measured) | preserved (MEAS) | as above |
| VT, FF | → single space (MEAS; lexer consumes as irregular whitespace `SRC`) | removed (MEAS) | preserved (MEAS) | preserved (MEAS) | as above |
| NEL, NBSP, OGHAM, U+2000–U+200A, NNBSP, MMSP, IDEO | → single space (MEAS; `internal_is_irregular_whitespace` `SRC`) | removed (MEAS) | preserved (MEAS) | preserved (MEAS) | as above |
| ZWSP U+200B | → single space (MEAS; **accepted as trivia** `SRC` — diverges from ECMA-262) | removed (MEAS) | preserved (MEAS) | preserved (MEAS) | as above |
| LS U+2028, PS U+2029 | → single space in code position (MEAS) even though the lexer flags them as irregular **line terminators** and sets `is_on_new_line` (`SRC`); whether a real LF is emitted is decided by the printer's layout, not by a char→char replacement (`INFER`) | removed (MEAS) | see §3(b) — legal literally since ES2019 (`SRC`); preserved as raw token text (`INFER`, matches MEAS) | preserved (MEAS) | as above |
| ZWNBSP U+FEFF | → single space in code position (MEAS) / removed at line end (MEAS). **File-leading BOM: `UNVERIFIED` for oxfmt** (prettier re-adds it, see §2.2) | removed (MEAS) | preserved (MEAS) | preserved (MEAS) | as above |
| ZWNJ U+200C, ZWJ U+200D | identifier characters, not whitespace (`SRC`); no normalization | untouched | untouched | untouched | as above |
| SHY U+00AD, WJ U+2060, MVS U+180E | **parse error / file refused** (MEAS; matches Oxc source: none of them is in `is_irregular_whitespace`, U+180E notably absent `SRC`) | n/a | n/a | n/a | as above |
| LRM U+200E, RLM U+200F | refusals expected from source (`SRC` + `INFER`); **not measured** → `UNVERIFIED` | n/a | legal per spec inside literals, `UNVERIFIED` for oxfmt | `UNVERIFIED` | as above |
| U+0080–U+009F group (excl. NEL) | refusals expected from source (`SRC` + `INFER`); `UNVERIFIED` | n/a | `UNVERIFIED` | `UNVERIFIED` | as above |

UNVERIFIED for oxfmt: whether a multi-line block comment whose continuation lines start with `*`
is re-indented (a "leading `*` alignment" behaviour exists in `oxc_formatter` trivia handling in
principle, but I could not confirm the source in this run). Also UNVERIFIED: oxfmt behaviour on a
file-leading U+FEFF (BOM).

### 2.2 prettier (default JS parser: Babel)

(`SRC`) `src/main/core.js`: BOM is stripped before parsing and **re-added to the output**
(`addBom`) → a file-leading U+FEFF is *preserved*, not converted to a space; if the text contains
`"\r"`, `normalizeEndOfLine(text)` runs **before parsing** (CR / CRLF normalized), and the printer
emits the configured `endOfLine` character.

(`SRC`) `src/utilities/print-string.js` + `src/utilities/make-string.js`:
if the original quote style can be kept, **`printString` returns the raw token text unchanged**;
otherwise `makeString` only escapes backslashes and quote characters. **No whitespace code point is
ever rewritten inside a string literal** — NBSP, ZWSP, LS/PS, ZWNBSP, NEL stay byte-identical if
they got past the parser. (`SRC`) `src/language-js/print/literal.js` wraps the result in
`replaceEndOfLine(printString(node.extra.raw, options))`; the definition of `replaceEndOfLine`
was **not retrievable in this run → `UNVERIFIED`** (it is the only place where a raw LS/PS inside a
printed string could be turned into a doc line break).

| Code point | in code position | at line end | inside string literal | inside comment | line-ending policy |
| --- | --- | --- | --- | --- | --- |
| TAB, SP | regenerated spacing (`INFER`: doc printer; original inter-token whitespace is not in the AST) | dropped (`INFER`, matches MEAS-class behaviour of the sibling formatter) | preserved (`SRC`) | preserved (`SRC`, comment text is carried through `replaceEndOfLine`) | `endOfLine`: `lf` (default), `crlf`, `cr`, `auto` (docs `SRC`); CR/CRLF normalized pre-parse (`SRC`) |
| VT, FF | regenerate to space (`INFER`) | dropped (`INFER`) | preserved (`SRC`) | preserved (`SRC`) | as above |
| NBSP, OGHAM, U+2000–U+200A, NNBSP, MMSP, IDEO | accepted by parser (`SRC`, Babel `isWhitespace`), regenerate to space (`INFER`) | dropped (`INFER`) | preserved (`SRC`) | preserved (`SRC`) | as above |
| NEL U+0085 | **parse error → prettier refuses the file** (`SRC`: absent from Babel `isWhitespace`) | n/a | n/a | n/a | as above |
| ZWSP U+200B | **parse error → prettier refuses the file** (`SRC`: absent from Babel `isWhitespace`; cannot be skipped) | n/a | n/a | n/a | as above |
| LS U+2028, PS U+2029 | line terminator; printer-chosen line break (`INFER`); no char→char conversion | n/a | legal literally (ES2019, `SRC`); printed raw (`SRC`) — whether `replaceEndOfLine` converts it to a real LF is `UNVERIFIED` | preserved (`SRC`/`INFER`) | as above |
| ZWNBSP U+FEFF | accepted as WS (`SRC`) → space (`INFER`); **at offset 0 preserved** (`SRC`) | dropped (`INFER`) | preserved (`SRC`) | preserved (`SRC`) | as above |
| ZWNJ, ZWJ | identifier chars; untouched (`UNVERIFIED` for prettier specifically) | untouched | preserved | preserved | as above |
| SHY U+00AD, WJ U+2060, MVS U+180E, LRM/RLM, C1 controls | not in Babel `isWhitespace` → parse error / file refused (`SRC` + `INFER`) | n/a | `UNVERIFIED` | `UNVERIFIED` | as above |

Docs corroboration (`SRC`): prettier's rationale states prettier *"only prints code"* and
*"maintains the way your string is escaped"* (e.g. it will not turn `"🙂"` into escapes), and it
preserves *empty lines* from the input — i.e. it is a re-printer, so separators between tokens are
produced by the printer, not preserved from the source.

### 2.3 Biome (formatter + linter)

(`SRC`) Biome's JS lexer whitespace table includes **U+200B and U+FEFF**; U+0085 is absent
(comment claims the set is "`Zs`", which is inaccurate for U+200B) — so biome accepts ZWSP as
whitespace trivia but very likely refuses NEL (`INFER`).
(`SRC`) `formatter.lineEnding`: `lf` (default), `crlf`, `cr`, `auto`.

| Code point | in code position | at line end | inside string literal | inside comment | line-ending policy |
| --- | --- | --- | --- | --- | --- |
| TAB, SP, VT, FF | regenerated spacing (`INFER` from CST-reprint architecture + lint rule treating them as trivia) | dropped (`INFER`) | preserved (`UNVERIFIED` measured) | preserved (`UNVERIFIED` measured) | `lineEnding` default `lf`, `crlf`/`cr`/`auto` available (docs `SRC`) |
| NBSP, OGHAM, U+2000–U+200B, NNBSP, MMSP, IDEO, ZWNBSP | accepted as whitespace trivia; the lint rule `noIrregularWhitespace` reports them as "Irregular whitespaces found" precisely because the parser classified them as whitespace trivia (`SRC`) → formatter regenerates spacing (`INFER`) | dropped (`INFER`) | `UNVERIFIED` | `UNVERIFIED` | as above |
| NEL U+0085 | not in lexer WS table → likely parse error (`SRC` + `INFER`), unlike oxfmt | n/a | n/a | n/a | as above |
| LS U+2028, PS U+2029 | line terminators (`UNVERIFIED` in source); **not** part of Biome's irregular-whitespace code-point list (`SRC`: the rule's sources are ESLint's, whose LS/PS handling lives in `IRREGULAR_LINE_TERMINATORS`) | n/a | `UNVERIFIED` | `UNVERIFIED` | as above |
| ZWNJ, ZWJ, LRM, RLM, SHY, WJ, MVS, C1 controls | `UNVERIFIED` (no source read in this run) | n/a | `UNVERIFIED` | `UNVERIFIED` | as above |

Biome lint rule (`SRC`, docs + source): `noIrregularWhitespace` — recommended, severity `warning`,
runs on `AnyJsRoot` over whitespace trivia, **has no fix** (deliberately no autofix).

### 2.4 ESLint / oxlint — "autofix" audit

(`SRC`) `lib/rules/no-irregular-whitespace.js`:

* `IRREGULAR_WHITESPACE = /[\u000c\u000b\u0085\ufeff\u00a0\u1680\u180e\u2000-\u200b\u202f\u205f\u3000]/gu`
* `IRREGULAR_LINE_TERMINATORS = /[\u2028\u2029]/gu` (reported with "Irregular whitespace" + line-break message)
* **`meta.fixable` is absent → `no-irregular-whitespace` has NO autofix.** `eslint --fix` therefore
  never rewrites or strips NBSP anywhere — including inside strings — because it never rewrites anything
  for this rule at all.
* Defaults: `skipStrings: true`, `skipComments: false`, `skipJSXText: false`, `skipRegExps: false`,
  `skipTemplates: false` (`SRC`, rule docs). With the default `skipStrings: true`, NBSP/U+2028 inside
  a *string literal* is not even reported.
* Code points ESLint treats as irregular: VT, FF, NEL, NBSP, U+1680, **U+180E**, U+2000–**U+200B**,
  U+202F, U+205F, U+3000, LS, PS, ZWNBSP. **Not** included: SHY U+00AD, WJ U+2060, ZWNJ, ZWJ, LRM, RLM.

ESLint rules that *do* touch these code points (`SRC`, rule sources):

* `unicode-bom` — `fixable: "whitespace"`; option `"never"` (default) **removes** a leading U+FEFF,
  option `"always"` **inserts** `"\uFEFF"` at position 0. This is the one lint autofix in the JS
  ecosystem that can *introduce* an invisible code point (U+FEFF), and the only one that removes one.
* `linebreak-style` — `fixable: "whitespace"`; rewrites LF↔CRLF wholesale (line-ending policy, not an
  irregular code point). Default option `unix` (`UNVERIFIED` in source here; documented).

oxlint (`SRC`, rule docs): `no-irregular-whitespace`, ESLint-derived code point set, **no fix**, but
different defaults: `skipStrings/skipTemplates/skipRegExps/skipJSXText: true`, `skipComments: false`.

---

## 3. Explicit answers

**(a) Does any formatter rewrite whitespace inside string literals, comments or regex literals?**
* **prettier: no** for string literals — `printString` returns the raw token text unchanged when the
  quote style is kept, and `makeString` only escapes `\` and quotes (`SRC`). No whitespace code point
  (NBSP, ZWSP, LS/PS, ZWNBSP, NEL, VT/FF) is rewritten. Comments: comment text is carried through
  verbatim except for line-break normalization inside the comment (`replaceEndOfLine`), which I could
  not verify (`UNVERIFIED`). Regex literals: printed as raw text (`UNVERIFIED` in source here) — in
  prettier's model a regex literal is a single token, so `INFER`: unchanged.
* **oxfmt: no** per the parent's measurement (string and comment interiors preserved). Mechanism
  consistent: a string/comment token's interior is not trivia (`SRC` + `INFER`).
* **Biome: `UNVERIFIED`.**
* **ESLint/oxlint: nothing to rewrite** — no autofix exists; and NBSP inside strings is skipped by
  default (`skipStrings: true`).

**(b) Do any convert LS/PS U+2028/U+2029 into a real newline (changing the line count)?**
* No formatter does a *character substitution* LS→LF. LS/PS are **LineTerminators** per ECMA-262, and
  oxc's lexer explicitly classifies them as *irregular line terminators*, setting `is_on_new_line` and
  a trivia newline (`SRC`) — i.e. they act as line breaks for the token stream/ASI. What appears in the
  output is then decided by the printer's layout: inside a statement kept on one line they vanish into a
  space (that is the parent's measurement: "LS/PS in code position → single space" — consistent, not
  contradictory); between statements they surface as the configured line ending (LF by default). So the
  output line count is **not** simply "input line count with LS replaced by LF".
* Inside a string literal, LS/PS are legal literally since ES2019 (`SRC`); prettier's string printing is
  byte-preserving (`SRC`), so no newline is introduced — **except** that `replaceEndOfLine` wrapping
  could in principle expand them, which I could not verify (`UNVERIFIED`, only remaining risk here).
* ESLint only *reports* LS/PS (`IRREGULAR_LINE_TERMINATORS`) — the rule has no fix.

**(c) Can any formatter or lint autofix INTRODUCE one of these code points?**
* Yes, exactly one mechanism: ESLint `unicode-bom` with option `"always"` inserts U+FEFF at offset 0
  (`fixable: "whitespace"`, `SRC`). prettier *re-adds* a U+FEFF that was already present (`SRC`) —
  preservation, not introduction.
* No formatter emits NBSP, ZWSP, NEL, VT/FF, MVS, SHY or WJ as output; the only whitespace characters
  formatters emit are SP/TAB and the configured line ending (`linebreak-style` fix can also *change*
  line endings). `eslint --fix` cannot introduce NBSP/ZWSP (no rule emits them, and
  `no-irregular-whitespace` is not fixable).

**(d) Line-ending defaults & CRLF/CR normalization**

| Tool | Default | Options | CRLF/CR handling |
| --- | --- | --- | --- |
| prettier | `lf` (docs `SRC`) | `lf`, `crlf`, `cr`, `auto` | any `"\r"` in the input is normalized **before parsing** (`SRC`); output uses the configured ending; `auto` guesses from the original text (`SRC`) |
| oxfmt | `lf` (docs `SRC`) | `lf`, `crlf`, `cr` — **no `auto`** (`SRC`) | documented as normalizing to the configured ending (`SRC` for the option; per-file measured behaviour `UNVERIFIED`) |
| Biome | `lf` | `lf`, `crlf`, `cr`, `auto` (docs `SRC`) | `UNVERIFIED` for the mixed-ending rule |
| ESLint (`--fix`) | none — linting never rewrites line endings | rule `linebreak-style` (`fixable: "whitespace"`) converts LF↔CRLF | via `linebreak-style` only |

---

## 4. Contradictions, disagreements, and where the baseline needs care

1. **OXFMT ACCEPTS CODE POINTS THE LANGUAGE DOES NOT.** The parent's measurements (ZWSP → space,
   NEL → space) are **confirmed by Oxc source**: `is_irregular_whitespace` includes VT, FF, NBSP,
   ZWNBSP, **NEL**, OGHAM, U+2000–**U+200B**, NNBSP, MMSP, IDEO. But
   ECMA-262 WhiteSpace **excludes** NEL and ZWSP, and Babel (prettier's parser) matches the spec set —
   so **prettier refuses exactly the two code points (NEL, ZWSP) that oxfmt silently normalizes to a
   space.** Do not generalize the oxfmt baseline to "JS/TS formatters": for NEL and ZWSP, prettier is a
   refusal, oxfmt is a rewrite — a semantic change (a file that Node would reject parses in oxfmt).
2. **Biome vs oxfmt on NEL:** Biome's lexer whitespace table has no U+0085 (`SRC`), so Biome is expected
   to refuse NEL where oxfmt rewrites it. `UNVERIFIED` by execution.
3. **U+180E MVS:** ESLint and (per its own list) TypeScript-era tools list it as irregular whitespace;
   Oxc dropped it from `is_irregular_whitespace` → oxfmt refuses it (matches the baseline). Biome's
   lint list still contains it (`SRC`, biome rule sources) even if its lexer may not classify it as
   whitespace — a lint/lexer mismatch worth noting.
4. **File-leading U+FEFF (BOM):** prettier *preserves* it (`addBom`, `SRC`). The baseline's
   "ZWNBSP at line end → removed" does not cover offset 0. Whether oxfmt preserves a BOM is
   `UNVERIFIED` — this is the single cell most likely to bite line-identity (a BOM is inside the first
   line's anchor if the whole line is hashed).
5. **`replaceEndOfLine`:** the one unverified path by which a raw LS/PS or CR inside a *string* could
   become a real line break in prettier's output. Prettier's own string printer is byte-preserving, so
   the risk is narrow, but the definition could not be fetched → `UNVERIFIED`.
6. **ESLint defaults differ from oxlint:** ESLint skips only strings by default; oxlint skips strings,
   templates, regexps and JSX text. A "is irregular whitespace reported?" claim must state the linter.

## 5. Missing evidence / next steps

* Unable to execute anything in this run (no shell tool): all prettier/oxfmt/Biome behavioural cells
  marked `INFER`/`UNVERIFIED` should be confirmed by running the three formatters + `eslint --fix`
  over a generated fixture matrix (one file per code point × position: code / line end / string /
  comment / regex / template).
* V8/Node acceptance was **not** measured and V8's white-space table was not located in its source
  (the scanner calls `IsWhiteSpaceOrLineTerminator`, defined outside the files fetched). Node-level
  acceptance of NEL (spec: reject) and ZWSP (spec: reject) should be checked with
  `node --check` before freezing the canonical class — this is the engine/parser divergence that
  matters most for a "canonical whitespace class" frozen from formatter behaviour.
* TypeScript's `scanner.ts` whitespace predicates could not be fetched (404 on the assumed path);
  TS acceptance cells are `UNVERIFIED`.

## 6. Sources

Kept:

* ECMA-262 lexical grammar — [tc39.es/ecma262 (multipage)](https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html) — Table 31 white space, LineTerminator table, `Cf` rules, string-literal "all code points may appear literally" text.
* [Babel `babel-parser/src/util/whitespace.ts`](https://github.com/babel/babel/blob/main/packages/babel-parser/src/util/whitespace.ts) — the exact acceptance set of prettier's default parser.
* [`oxc_syntax/src/identifier.rs`](https://github.com/oxc-project/oxc/blob/main/crates/oxc_syntax/src/identifier.rs) and [`line_terminator.rs`](https://github.com/oxc-project/oxc/blob/main/crates/oxc_syntax/src/line_terminator.rs) — the authoritative oxfmt acceptance/normalization sets.
* [`oxc_parser/src/lexer/unicode.rs`](https://github.com/oxc-project/oxc/blob/main/crates/oxc_parser/src/lexer/unicode.rs), [`byte_handlers.rs`](https://github.com/oxc-project/oxc/blob/main/crates/oxc_parser/src/lexer/byte_handlers.rs), [`whitespace.rs`](https://github.com/oxc-project/oxc/blob/main/crates/oxc_parser/src/lexer/whitespace.rs) — the trivia-vs-error dispatch order.
* [prettier `src/main/core.js`](https://github.com/prettier/prettier/blob/main/src/main/core.js), [`utilities/print-string.js`](https://github.com/prettier/prettier/blob/main/src/utilities/print-string.js), [`utilities/make-string.js`](https://github.com/prettier/prettier/blob/main/src/utilities/make-string.js), [`language-js/print/literal.js`](https://github.com/prettier/prettier/blob/main/src/language-js/print/literal.js), [`utilities/bom.js`](https://github.com/prettier/prettier/blob/main/src/utilities/bom.js) — BOM re-add, CR pre-normalization, byte-preserving string printing.
* [prettier rationale](https://prettier.io/docs/rationale) and [prettier options](https://prettier.io/docs/options) — re-printer model and `endOfLine` default/options.
* [`eslint/lib/rules/no-irregular-whitespace.js`](https://github.com/eslint/eslint/blob/main/lib/rules/no-irregular-whitespace.js) + [rule docs](https://eslint.org/docs/latest/rules/no-irregular-whitespace) — code point sets, no `fixable`, option defaults.
* [ESLint `unicode-bom`](https://github.com/eslint/eslint/blob/main/lib/rules/unicode-bom.js) and [`linebreak-style`](https://github.com/eslint/eslint/blob/main/lib/rules/linebreak-style.js) — the two fixable whitespace rules.
* [Biome `noIrregularWhitespace` (JS docs)](https://biomejs.dev/linter/rules/no-irregular-whitespace/javascript/) + [source](https://github.com/biomejs/biome/blob/main/crates/biome_js_analyze/src/lint/suspicious/no_irregular_whitespace.rs) and [Biome configuration reference](https://biomejs.dev/reference/configuration/) — no fix, `lineEnding`.
* [oxlint `no-irregular-whitespace` docs](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-irregular-whitespace) and [oxfmt config reference](https://oxc.rs/docs/guide/usage/formatter/config-file-reference.html) — oxlint skip defaults; oxfmt `endOfLine` (no `auto`).
* [Biome `biome_js_parser/src/lexer/mod.rs`](https://github.com/biomejs/biome/blob/main/crates/biome_js_parser/src/lexer/mod.rs) — whitespace table incl. U+200B.

Rejected / deprioritized: V8 `src/parsing/scanner.cc`, `scanner.h`, `scanner-inl.h`, `strings/unicode.cc`, `unicode-inl.h` — fetched, but none contains the white-space code-point table (only `IsWhiteSpaceOrLineTerminator` call sites), so no V8 cell could be sourced; the v8.dev scanner blog describes the scanning strategy without a code-point table. `oxc_formatter/src/formatter/trivia.rs` — no irregular-whitespace handling found. `tests/format/js/unicode/nbsp-jsx.js` (prettier) — JSX-specific, not decision-relevant for code/string positions. TypeScript `src/compiler/scanner.ts` — 404 on the assumed path.
