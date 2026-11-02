/**
 * SAFETY: FileContent — frozen invisible-codepoint classification.
 *
 * One class per codepoint, checked in order: control, then `canon_stripped`,
 * then `canon_surviving` (the sets overlap only at U+000B, U+000C and U+0085,
 * which the control class wins). Explicit frozen code-point lists only:
 * no Unicode property escapes, no global regex flags.
 */

export type InvisibleClass = "canon_stripped" | "canon_surviving" | "non_printable_control";

export interface CodepointOccurrence {
  /** 1-indexed, counted in CODE POINTS (astral-plane characters count as one). */
  readonly column: number;
  readonly codePoint: number;
  readonly class: InvisibleClass;
  readonly name?: string;
  readonly bidi: boolean;
}

function expand(low: number, high: number): number[] {
  const out: number[] = [];
  for (let code = low; code <= high; code++) out.push(code);
  return out;
}

// WHY: today's scope exactly — C0 except the three text whitespaces that render
// WHY: as layout (TAB, LF, CR), plus DEL and the C1 block. U+0085 stays here,
// WHY: so the existing control disclosure keeps its bytes.
const NON_PRINTABLE_CONTROL: ReadonlySet<number> = new Set([
  ...expand(0x00, 0x08),
  0x0b,
  0x0c,
  ...expand(0x0e, 0x1f),
  ...expand(0x7f, 0x9f),
]);

// WHY: the 21 non-ASCII codepoints the line canon strips (`CANON_CODE_POINTS`
// WHY: in `src/hashline/hash-identity.ts`, minus U+0085 which the control class wins).
const CANON_STRIPPED: ReadonlySet<number> = new Set([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x200e, 0x200f, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

// WHY: the 16 zero-width, soft-hyphen and bidi format codepoints the canon keeps.
const CANON_SURVIVING: ReadonlySet<number> = new Set([
  0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

// WHY: the 12 bidi codepoints. A bidi codepoint carries the layout-override
// WHY: hazard in addition to its class hazard.
const BIDI: ReadonlySet<number> = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

const NAMES: Readonly<Record<number, string>> = {
  0x00a0: "NO-BREAK SPACE",
  0x1680: "OGHAM SPACE MARK",
  0x2000: "EN QUAD",
  0x2001: "EM QUAD",
  0x2002: "EN SPACE",
  0x2003: "EM SPACE",
  0x2004: "THREE-PER-EM SPACE",
  0x2005: "FOUR-PER-EM SPACE",
  0x2006: "SIX-PER-EM SPACE",
  0x2007: "FIGURE SPACE",
  0x2008: "PUNCTUATION SPACE",
  0x2009: "THIN SPACE",
  0x200a: "HAIR SPACE",
  0x2028: "LINE SEPARATOR",
  0x2029: "PARAGRAPH SEPARATOR",
  0x202f: "NARROW NO-BREAK SPACE",
  0x205f: "MEDIUM MATHEMATICAL SPACE",
  0x3000: "IDEOGRAPHIC SPACE",
  0x200e: "LEFT-TO-RIGHT MARK",
  0x200f: "RIGHT-TO-LEFT MARK",
  0xfeff: "ZERO WIDTH NO-BREAK SPACE",
  0x00ad: "SOFT HYPHEN",
  0x061c: "ARABIC LETTER MARK",
  0x180e: "MONGOLIAN VOWEL SEPARATOR",
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x2060: "WORD JOINER",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
  // WHY: names are the real Unicode aliases — NameAliases.txt (alias type
  // WHY: control) for the C0 controls and DEL, UnicodeData.txt and the C1
  // WHY: Controls chart for C1. U+0009, U+000A and U+000D stay deliberately
  // WHY: absent: text whitespaces that render as layout, never data.
  0x0000: "NULL",
  0x0001: "START OF HEADING",
  0x0002: "START OF TEXT",
  0x0003: "END OF TEXT",
  0x0004: "END OF TRANSMISSION",
  0x0005: "ENQUIRY",
  0x0006: "ACKNOWLEDGE",
  0x0007: "BELL",
  0x0008: "BACKSPACE",
  0x000b: "LINE TABULATION",
  0x000c: "FORM FEED",
  0x000e: "SHIFT OUT",
  0x000f: "SHIFT IN",
  0x0010: "DATA LINK ESCAPE",
  0x0011: "DEVICE CONTROL ONE",
  0x0012: "DEVICE CONTROL TWO",
  0x0013: "DEVICE CONTROL THREE",
  0x0014: "DEVICE CONTROL FOUR",
  0x0015: "NEGATIVE ACKNOWLEDGE",
  0x0016: "SYNCHRONOUS IDLE",
  0x0017: "END OF TRANSMISSION BLOCK",
  0x0018: "CANCEL",
  0x0019: "END OF MEDIUM",
  0x001a: "SUBSTITUTE",
  0x001b: "ESCAPE",
  0x001c: "FILE SEPARATOR",
  0x001d: "GROUP SEPARATOR",
  0x001e: "RECORD SEPARATOR",
  0x001f: "UNIT SEPARATOR",
  0x007f: "DELETE",
  0x0080: "PADDING CHARACTER",
  0x0081: "HIGH OCTET PRESET",
  0x0082: "BREAK PERMITTED HERE",
  0x0083: "NO BREAK HERE",
  0x0084: "INDEX",
  0x0085: "NEXT LINE",
  0x0086: "START OF SELECTED AREA",
  0x0087: "END OF SELECTED AREA",
  0x0088: "CHARACTER TABULATION SET",
  0x0089: "CHARACTER TABULATION WITH JUSTIFICATION",
  0x008a: "LINE TABULATION SET",
  0x008b: "PARTIAL LINE FORWARD",
  0x008c: "PARTIAL LINE BACKWARD",
  0x008d: "REVERSE LINE FEED",
  0x008e: "SINGLE SHIFT TWO",
  0x008f: "SINGLE SHIFT THREE",
  0x0090: "DEVICE CONTROL STRING",
  0x0091: "PRIVATE USE ONE",
  0x0092: "PRIVATE USE TWO",
  0x0093: "SET TRANSMIT STATE",
  0x0094: "CANCEL CHARACTER",
  0x0095: "MESSAGE WAITING",
  0x0096: "START OF GUARDED AREA",
  0x0097: "END OF GUARDED AREA",
  0x0098: "START OF STRING",
  0x0099: "SINGLE GRAPHIC CHARACTER INTRODUCER",
  0x009a: "SINGLE CHARACTER INTRODUCER",
  0x009b: "CONTROL SEQUENCE INTRODUCER",
  0x009c: "STRING TERMINATOR",
  0x009d: "OPERATING SYSTEM COMMAND",
  0x009e: "PRIVACY MESSAGE",
  0x009f: "APPLICATION PROGRAM COMMAND",
};

export function classifyCodepoint(codePoint: number): InvisibleClass | undefined {
  if (NON_PRINTABLE_CONTROL.has(codePoint)) return "non_printable_control";
  if (CANON_STRIPPED.has(codePoint)) return "canon_stripped";
  if (CANON_SURVIVING.has(codePoint)) return "canon_surviving";
  return undefined;
}

export function invisibleName(codePoint: number): string | undefined {
  return NAMES[codePoint];
}

/**
 * Scans one line for invisible codepoints. The column counts code points
 * (`for (const char of line)`), so an astral-plane character counts as one.
 */
export function scanInvisibleLine(line: string): CodepointOccurrence[] {
  const out: CodepointOccurrence[] = [];
  let column = 0;
  for (const char of line) {
    column++;
    const codePoint = char.codePointAt(0)!;
    const found = classifyCodepoint(codePoint);
    if (found === undefined) continue;
    const name = invisibleName(codePoint);
    const occurrence: { -readonly [K in keyof CodepointOccurrence]: CodepointOccurrence[K] } = {
      column,
      codePoint,
      class: found,
      bidi: BIDI.has(codePoint),
    };
    if (name !== undefined) occurrence.name = name;
    out.push(occurrence);
  }
  return out;
}
