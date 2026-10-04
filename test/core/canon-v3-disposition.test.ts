import { describe, expect, it, beforeAll } from "vitest";

import { canon, canonDigest, _lineHashesPure } from "../../src/hashline";
import { initHasher } from "../../src/hashline/hasher";

beforeAll(async () => {
  await initHasher();
});

type Disposition = "normalize" | "significant";

interface CpRow {
  cp: string;
  name: string;
  disposition: Disposition;
}

/**
 * The executable record of the canon v3 class (issue #22): every code point the policy names,
 * with its disposition. A future class change must consciously edit a row here. Hash identity is
 * asserted uniformly through `canonDigest`; `_lineHashesPure` backs the anchor surface for a few
 * representative rows at the bottom.
 */
const DISPOSITIONS: CpRow[] = [
  // Table 1 — the frozen 28-cp NORMALIZE class (6 + 3 + 11 + 5 + 3).
  { cp: "\u0009", name: "TAB U+0009", disposition: "normalize" },
  { cp: "\u000A", name: "LF U+000A", disposition: "normalize" },
  { cp: "\u000B", name: "VT U+000B", disposition: "normalize" },
  { cp: "\u000C", name: "FF U+000C", disposition: "normalize" },
  { cp: "\u000D", name: "CR U+000D", disposition: "normalize" },
  { cp: "\u0020", name: "SPACE U+0020", disposition: "normalize" },
  { cp: "\u0085", name: "NEL U+0085", disposition: "normalize" },
  { cp: "\u00A0", name: "NBSP U+00A0", disposition: "normalize" },
  { cp: "\u1680", name: "OGHAM SPACE MARK U+1680", disposition: "normalize" },
  { cp: "\u2000", name: "EN QUAD U+2000", disposition: "normalize" },
  { cp: "\u2001", name: "EM QUAD U+2001", disposition: "normalize" },
  { cp: "\u2002", name: "EN SPACE U+2002", disposition: "normalize" },
  { cp: "\u2003", name: "EM SPACE U+2003", disposition: "normalize" },
  { cp: "\u2004", name: "THREE-PER-EM SPACE U+2004", disposition: "normalize" },
  { cp: "\u2005", name: "FOUR-PER-EM SPACE U+2005", disposition: "normalize" },
  { cp: "\u2006", name: "SIX-PER-EM SPACE U+2006", disposition: "normalize" },
  { cp: "\u2007", name: "FIGURE SPACE U+2007", disposition: "normalize" },
  { cp: "\u2008", name: "PUNCTUATION SPACE U+2008", disposition: "normalize" },
  { cp: "\u2009", name: "THIN SPACE U+2009", disposition: "normalize" },
  { cp: "\u200A", name: "HAIR SPACE U+200A", disposition: "normalize" },
  { cp: "\u2028", name: "LINE SEPARATOR U+2028", disposition: "normalize" },
  { cp: "\u2029", name: "PARAGRAPH SEPARATOR U+2029", disposition: "normalize" },
  { cp: "\u202F", name: "NARROW NO-BREAK SPACE U+202F", disposition: "normalize" },
  { cp: "\u205F", name: "MEDIUM MATHEMATICAL SPACE U+205F", disposition: "normalize" },
  { cp: "\u3000", name: "IDEOGRAPHIC SPACE U+3000", disposition: "normalize" },
  { cp: "\u200E", name: "LEFT-TO-RIGHT MARK U+200E", disposition: "normalize" },
  { cp: "\u200F", name: "RIGHT-TO-LEFT MARK U+200F", disposition: "normalize" },
  { cp: "\uFEFF", name: "ZERO WIDTH NO-BREAK SPACE U+FEFF", disposition: "normalize" },
  // Table 2 — the explicitly SIGNIFICANT controls that must survive canon untouched.
  { cp: "\u200B", name: "ZERO WIDTH SPACE U+200B", disposition: "significant" },
  { cp: "\u200C", name: "ZERO WIDTH NON-JOINER U+200C", disposition: "significant" },
  { cp: "\u200D", name: "ZERO WIDTH JOINER U+200D", disposition: "significant" },
  { cp: "\u00AD", name: "SOFT HYPHEN U+00AD", disposition: "significant" },
  { cp: "\u2060", name: "WORD JOINER U+2060", disposition: "significant" },
  { cp: "\u180E", name: "MONGOLIAN VOWEL SEPARATOR U+180E", disposition: "significant" },
  { cp: "\u001C", name: "FILE SEPARATOR U+001C", disposition: "significant" },
  { cp: "\u001D", name: "GROUP SEPARATOR U+001D", disposition: "significant" },
  { cp: "\u001E", name: "RECORD SEPARATOR U+001E", disposition: "significant" },
  { cp: "\u001F", name: "UNIT SEPARATOR U+001F", disposition: "significant" },
  // C1 sample rows for named visibility; the full U+0080–U+009F range (except U+0085 NEL, which
  // normalizes) is asserted by the range check below, so enumerating all 31 here would be noise.
  { cp: "\u0080", name: "PADDING CHARACTER U+0080", disposition: "significant" },
  { cp: "\u0081", name: "HIGH OCTET PRESET U+0081", disposition: "significant" },
  { cp: "\u009F", name: "APPLICATION PROGRAM COMMAND U+009F", disposition: "significant" },
];

describe("canon v3 disposition table — executable record (issue #22)", () => {
  it.each(DISPOSITIONS.map((row) => [row.name, row] as const))(
    "%s",
    (_name: string, row: CpRow) => {
      const { cp, disposition } = row;
      const cases: [string, string][] = [
        ["leading", `${cp}ab`],
        ["middle", `a${cp}b`],
        ["trailing", `ab${cp}`],
      ];
      for (const [position, probe] of cases) {
        if (disposition === "normalize") {
          expect(canon(probe), `${row.name} ${position}`).toBe(canon("ab"));
          expect(canonDigest(probe), `${row.name} ${position}`).toBe(canonDigest("ab"));
        } else {
          expect(canon(probe), `${row.name} ${position}`).not.toBe(canon("ab"));
          expect(canonDigest(probe), `${row.name} ${position}`).not.toBe(canonDigest("ab"));
        }
      }
    },
  );

  it("keeps every C1 code point except NEL U+0085 significant", () => {
    for (let cp = 0x0080; cp <= 0x009f; cp++) {
      const char = String.fromCharCode(cp);
      if (cp === 0x0085) {
        expect(canon(`a${char}b`), `NEL U+0085`).toBe("ab");
        continue;
      }
      const name = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(canon(`a${char}b`), name).toBe(`a${char}b`);
      expect(canonDigest(`a${char}b`), name).not.toBe(canonDigest("ab"));
    }
  });

  it("carries the disposition through the anchor hashing surface for representative cps", () => {
    const base = _lineHashesPure("ab\n");
    for (const cp of ["\u00A0", "\u2003", "\u3000", "\uFEFF"]) {
      expect(_lineHashesPure(`a${cp}b\n`)[0], `normalize ${cp.codePointAt(0)}`).toBe(base[0]);
    }
    for (const cp of ["\u200B", "\u00AD", "\u2060"]) {
      expect(_lineHashesPure(`a${cp}b\n`)[0], `significant ${cp.codePointAt(0)}`).not.toBe(base[0]);
    }
  });
});
