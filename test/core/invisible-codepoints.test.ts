import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyCodepoint,
  invisibleName,
  scanInvisibleLine,
} from "../../src/file-content/invisible.js";

/** Strips line/block comments and string literals, leaving only live code. */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'(?:\\.|[^'\\\n])*'/g, "")
    .replace(/"(?:\\.|[^"\\\n])*"/g, "")
    .replace(/`(?:\\.|[^`\\])*`/g, "");
}

/** The flag strings of every regex literal in live code. */
function regexLiteralFlags(code: string): string[] {
  return [...code.matchAll(/\/(?:\\.|[^/\n])+\/([a-z]*)/g)].map((match) => match[1] ?? "");
}
const STRIPPED: number[] = [
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x200e, 0x200f, 0x202f, 0x205f, 0x3000, 0xfeff,
];

const SURVIVING: number[] = [
  0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060,
  0x2066, 0x2067, 0x2068, 0x2069,
];

function hexOf(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Every codepoint the frozen classifier claims, derived from the classifier itself. */
const ALL_CLASSIFIED: number[] = [];
/** Named codepoints the classifier claims nothing about — the drift guard population. */
const STRAY_NAMES: string[] = [];
for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
  if (classifyCodepoint(codePoint) !== undefined) ALL_CLASSIFIED.push(codePoint);
  else if (invisibleName(codePoint) !== undefined) STRAY_NAMES.push(hexOf(codePoint));
}
describe("invisible codepoint classification", () => {
  it("names the three classes with one representative codepoint each", () => {
    expect(classifyCodepoint(0x00a0)).toBe("canon_stripped");
    expect(classifyCodepoint(0x200b)).toBe("canon_surviving");
    expect(classifyCodepoint(0x0001)).toBe("non_printable_control");
  });

  it("classifies every frozen stripped codepoint as canon_stripped", () => {
    expect(STRIPPED).toHaveLength(21);
    for (const codePoint of STRIPPED) {
      expect(classifyCodepoint(codePoint)).toBe("canon_stripped");
    }
  });

  it("classifies every frozen surviving codepoint as canon_surviving", () => {
    expect(SURVIVING).toHaveLength(16);
    for (const codePoint of SURVIVING) {
      expect(classifyCodepoint(codePoint)).toBe("canon_surviving");
    }
  });

  it("classifies the control range as non_printable_control", () => {
    for (const codePoint of [0x0000, 0x0008, 0x000b, 0x000c, 0x000e, 0x001f, 0x007f, 0x009f]) {
      expect(classifyCodepoint(codePoint)).toBe("non_printable_control");
    }
  });

  it("gives the control class priority over the canon sets at the overlap", () => {
    expect(classifyCodepoint(0x0085)).toBe("non_printable_control");
    for (const codePoint of [0x001c, 0x001d, 0x001e, 0x001f]) {
      expect(classifyCodepoint(codePoint)).toBe("non_printable_control");
    }
  });

  it("leaves ordinary text and the text whitespaces unclassified", () => {
    for (const codePoint of [0x0041, 0x0020, 0x0009, 0x000a, 0x000d, 0x00e9, 0x1f600]) {
      expect(classifyCodepoint(codePoint)).toBeUndefined();
    }
  });

  it("yields no occurrence for carriage return", () => {
    expect(scanInvisibleLine("a\rb")).toEqual([]);
  });
});

describe("invisible name table", () => {
  it("names a stripped and a surviving codepoint by their uppercase Unicode names", () => {
    expect(invisibleName(0x00a0)).toBe("NO-BREAK SPACE");
    expect(invisibleName(0x200d)).toBe("ZERO WIDTH JOINER");
    expect(invisibleName(0x202e)).toBe("RIGHT-TO-LEFT OVERRIDE");
  });

  it("reports no name for a codepoint outside the table", () => {
    expect(invisibleName(0x0009)).toBeUndefined();
    expect(invisibleName(0x0041)).toBeUndefined();
  });
});

describe("scanInvisibleLine", () => {
  it("yields a clean line with no occurrences", () => {
    expect(scanInvisibleLine("hello, world")).toEqual([]);
    expect(scanInvisibleLine("")).toEqual([]);
  });

  it("reports column, codepoint, class, name and bidi for one invisible codepoint", () => {
    expect(scanInvisibleLine("ab\u00A0c")).toEqual([
      {
        column: 3,
        codePoint: 0x00a0,
        class: "canon_stripped",
        name: "NO-BREAK SPACE",
        bidi: false,
      },
    ]);
  });

  it("marks bidi codepoints in both classes", () => {
    const [mark] = scanInvisibleLine("x\u200Fy");
    expect(mark?.class).toBe("canon_stripped");
    expect(mark?.bidi).toBe(true);
    const [isolate] = scanInvisibleLine("x\u2066y");
    expect(isolate?.class).toBe("canon_surviving");
    expect(isolate?.bidi).toBe(true);
    const [space] = scanInvisibleLine("x\u200By");
    expect(space?.bidi).toBe(false);
  });

  it("counts the column in code points after an astral-plane character", () => {
    const [found] = scanInvisibleLine("\u{1F600}\u00A0");
    expect(found?.column).toBe(2);
    expect(found?.codePoint).toBe(0x00a0);
  });

  it("names a control occurrence with its Unicode control alias", () => {
    expect(scanInvisibleLine("a\u0001b")).toEqual([
      {
        column: 2,
        codePoint: 0x0001,
        class: "non_printable_control",
        name: "START OF HEADING",
        bidi: false,
      },
    ]);
  });

  it("keeps page order across one line", () => {
    const found = scanInvisibleLine("\u200B-a\u00A0");
    expect(found.map((entry) => entry.column)).toEqual([1, 4]);
  });

  it("names every classified codepoint across all three sets, 99 total, with no entries outside them", () => {
    expect(ALL_CLASSIFIED).toHaveLength(99);
    expect(
      ALL_CLASSIFIED.filter(
        (codePoint) => classifyCodepoint(codePoint) === "non_printable_control",
      ),
    ).toHaveLength(62);
    const unnamed: string[] = [];
    for (const codePoint of ALL_CLASSIFIED) {
      if (invisibleName(codePoint) === undefined) unnamed.push(hexOf(codePoint));
    }
    expect(unnamed).toEqual([]);
    expect(STRAY_NAMES).toEqual([]);
  });
});

describe("invisible classifier source — frozen data discipline", () => {
  it("keeps the module pattern-free: no literal, no constructor, no property escape", () => {
    // WHY: (A2) the class sets are frozen explicit lists — a property escape
    // WHY: would drift with engine versions, the same reason CANON_CODE_POINTS
    // WHY: in hash-identity.ts is an explicit list. A future edit adding a
    // WHY: pattern must consciously remove this guard first. (A3) the class
    // WHY: sets are sets, never patterns, so a pattern of any kind — literal
    // WHY: or constructed — is a drift risk, not a style choice.
    const source = readFileSync("src/file-content/invisible.ts", "utf-8");
    expect(source).not.toContain("\\p{");
    expect(source).not.toContain("\\P{");
    expect(source).not.toContain("RegExp");
    expect(regexLiteralFlags(stripCommentsAndStrings(source))).toEqual([]);
    expect(stripCommentsAndStrings(source)).not.toContain("/");
  });

  it("rejects a planted global-flag literal through the same scanners", () => {
    const planted = "const re = /[a/b]/g;";
    expect(() => expect(regexLiteralFlags(stripCommentsAndStrings(planted))).toEqual([])).toThrow();
  });

  it("rejects a planted constructed pattern through the same scanners", () => {
    const planted = 'const re = new RegExp("[\\\\u00ad]", "g");';
    expect(() => expect(planted).not.toContain("RegExp")).toThrow();
  });

  it("rejects a slash inside a character class through the same scanners", () => {
    const planted = "const RE = /[a//b]/;";
    expect(stripCommentsAndStrings(planted)).toContain("/");
  });

  it("rejects an uppercase escape through the same scanners", () => {
    const planted = "const re = /\\P{Cf}/u;";
    expect(() => expect(planted).not.toContain("\\P{")).toThrow();
  });
});
