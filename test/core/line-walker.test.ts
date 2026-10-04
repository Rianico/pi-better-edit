import { describe, expect, it } from "vitest";
import { visibleLineTotal, walkLines } from "../../src/file-content/line-walker.js";
import { visLines } from "../../src/utils.js";

// WHY: `split("\n")` is the oracle, never a hand-written expectation: the walker exists to hand a
// WHY: reader the SAME line sequence without materializing it, so any difference between the two is
// WHY: the defect — including the trailing empty entry a terminal newline adds, the single empty
// WHY: entry an empty text is, and a lone `\r`, which is not a break at all.
const ORACLE_CASES = [
  "",
  "\n",
  "\n\n\n",
  "\r",
  "a",
  "a\n",
  "a\nb",
  "a\nb\n",
  "a\nb\n\n",
  "\n\n",
  "a\r\nb\r\n",
  "a\rb",
  "a\r\nb",
  "a\r",
  "\r\n",
  "a\u2028b",
  "😀\n😀\n",
  "  \n\t\n",
  "no trailing",
  "one\nline",
] as const;

function fullRange(total: number): { start: number; end: number } {
  return { start: 0, end: total };
}

describe('walkLines — the split("\\n") equivalence', () => {
  it.each(ORACLE_CASES)('matches split("\\n") on %j, line for line and total for total', (text) => {
    const oracle = text.split("\n");
    const walk = walkLines(text, [fullRange(oracle.length)]);
    expect(walk.total).toBe(oracle.length);
    expect(walk.ranges[0]).toEqual(oracle);
  });

  it("counts the same total with no range requested (the count-only walk)", () => {
    for (const text of ORACLE_CASES) expect(walkLines(text).total).toBe(text.split("\n").length);
  });

  it("reports the trailing empty entry of a terminal newline and the one empty line of empty text", () => {
    expect(walkLines("a\nb\n").total).toBe(3);
    expect(walkLines("a\nb\n", [fullRange(3)]).ranges[0]).toEqual(["a", "b", ""]);
    expect(walkLines("").total).toBe(1);
    expect(walkLines("", [fullRange(1)]).ranges[0]).toEqual([""]);
  });

  it('does not break on a lone \\r, and does break on \\r\\n (as split("\\n") does)', () => {
    expect(walkLines("a\rb", [fullRange(1)]).ranges[0]).toEqual(["a\rb"]);
    expect(walkLines("a\r\nb", [fullRange(2)]).ranges[0]).toEqual(["a\r", "b"]);
  });

  it("is byte-exact on astral characters and odd whitespace (UTF-16 code units are not lines)", () => {
    const oracle = "😀\n\u2028\nx".split("\n");
    expect(walkLines("😀\n\u2028\nx", [fullRange(oracle.length)]).ranges[0]).toEqual(oracle);
  });
});

describe("walkLines — ranges", () => {
  const text = "l0\nl1\nl2\nl3\nl4";

  it("takes 0-indexed, half-open ranges", () => {
    expect(walkLines(text, [{ start: 1, end: 3 }]).ranges[0]).toEqual(["l1", "l2"]);
    expect(walkLines(text, [{ start: 0, end: 1 }]).ranges[0]).toEqual(["l0"]);
    expect(walkLines(text, [{ start: 2, end: 2 }]).ranges[0]).toEqual([]);
  });

  it("intersects the sequence instead of running past either end", () => {
    expect(walkLines(text, [{ start: 3, end: 99 }]).ranges[0]).toEqual(["l3", "l4"]);
    expect(walkLines(text, [{ start: 99, end: 120 }]).ranges[0]).toEqual([]);
    expect(walkLines(text, [{ start: -5, end: 2 }]).ranges[0]).toEqual(["l0", "l1"]);
    expect(walkLines(text, [{ start: 0, end: -1 }]).ranges[0]).toEqual([]);
  });

  it("keeps the request order and gives every range its own lines", () => {
    const walk = walkLines(text, [
      { start: 3, end: 5 },
      { start: 0, end: 2 },
    ]);
    expect(walk.ranges).toEqual([
      ["l3", "l4"],
      ["l0", "l1"],
    ]);
  });

  it("hands an overlapping line to every range that asked for it", () => {
    const walk = walkLines(text, [
      { start: 1, end: 3 },
      { start: 2, end: 4 },
    ]);
    expect(walk.ranges).toEqual([
      ["l1", "l2"],
      ["l2", "l3"],
    ]);
    expect(walk.total).toBe(5);
  });

  it("reports the whole sequence's total whatever the ranges are", () => {
    expect(walkLines(text, [{ start: 0, end: 1 }]).total).toBe(5);
    expect(walkLines(text, [{ start: 4, end: 5 }]).total).toBe(5);
    expect(walkLines("a\nb\n").total).toBe(3);
  });

  it('walks an empty text as the one empty line split("\\n") yields', () => {
    expect(walkLines("", [{ start: 0, end: 5 }]).ranges[0]).toEqual([""]);
    expect(walkLines("", [fullRange(1)]).ranges[0]).toEqual([""]);
  });
});

describe("walkLines — visit", () => {
  it('offers every line in order with its index, matching split("\\n")', () => {
    const text = "a\n\nb\n";
    const seen: Array<[number, string]> = [];
    const walk = walkLines(text, [{ start: 1, end: 2 }], (line, index) => seen.push([index, line]));
    expect(seen).toEqual(text.split("\n").map((line, index) => [index, line]));
    expect(walk.ranges[0]).toEqual([""]);
  });

  it("visits lines outside every requested range (the served read counts its rows)", () => {
    const seen: string[] = [];
    const walk = walkLines("a\nb\nc\nd", [{ start: 1, end: 2 }], (line) => seen.push(line));
    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(walk.ranges[0]).toEqual(["b"]);
  });
});

describe("visibleLineTotal — the read's total", () => {
  it("matches visLines(text).length without materializing the lines", () => {
    for (const text of ORACLE_CASES) {
      expect(visibleLineTotal(text, text.split("\n").length)).toBe(visLines(text).length);
    }
  });

  it("drops the terminal newline sentinel and reports an empty text as no lines", () => {
    expect(visibleLineTotal("a\nb\n", 3)).toBe(2);
    expect(visibleLineTotal("a\nb", 2)).toBe(2);
    expect(visibleLineTotal("", 1)).toBe(0);
    expect(visibleLineTotal("\n", 2)).toBe(1);
  });

  it("uses the text, not the total, to decide: the loader derives it from a newline count", () => {
    expect(visibleLineTotal("a\nb", 1 + 1)).toBe(2);
    expect(visibleLineTotal("a\nb\n", 2 + 1)).toBe(2);
    expect(visibleLineTotal("\r", 0 + 1)).toBe(1);
    expect(visibleLineTotal("", 0 + 1)).toBe(0);
  });
});
