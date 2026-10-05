import { describe, expect, it } from "vitest";
import { visibleLineTotal, walkLines } from "../../src/file-content/line-walker.js";
import { splitLines, visLines } from "../../src/utils.js";

// WHY: the oracle is the codebase's own line decomposition, never a hand-written expectation and
// WHY: never a private idea of what a line is: `splitLines` counts the lines the anchors are assigned
// WHY: to and `visLines` the lines a read shows, so a walk that disagrees with either is the defect.
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
  // WHY: a BOM is the first line's first character, not a line break: the loader strips it before the
  // WHY: walk, so what reaches the walk is a plain leading character and nothing more.
  "\uFEFFa\nb\n",
] as const;

function fullRange(total: number): { start: number; end: number } {
  return { start: 0, end: total };
}

describe("walkLines — the line decomposition", () => {
  it.each(ORACLE_CASES)("matches splitLines on %j, line for line and total for total", (text) => {
    const oracle = splitLines(text);
    const walk = walkLines(text, [fullRange(oracle.length)]);
    expect(walk.ranges[0]).toEqual(oracle);
    expect(walk.total).toBe(oracle.length);
  });

  it("counts the same total with no range requested (the count-only walk)", () => {
    for (const text of ORACLE_CASES) expect(walkLines(text).total).toBe(splitLines(text).length);
  });

  it("visits exactly the lines splitLines yields, in order and with their indexes", () => {
    for (const text of ORACLE_CASES) {
      const seen: Array<[number, string]> = [];
      walkLines(text, [], (line, index) => seen.push([index, line]));
      expect(seen).toEqual(splitLines(text).map((line, index) => [index, line]));
    }
  });

  it("treats a terminal newline's trailing entry as the sentinel it is, not a line", () => {
    // WHY: the one place raw `split("\n")` and the walk disagree, and they must: "a\nb\n" is two
    // WHY: lines plus the empty entry a terminal newline leaves, which `splitLines` counts away,
    // WHY: `visLines` never shows, and the anchors are never assigned to. The walk counts the lines
    // WHY: its callers count — that is what keeps one line space one line space.
    expect("a\nb\n".split("\n")).toEqual(["a", "b", ""]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(walkLines("a\nb\n", [fullRange(2)]).ranges[0]).toEqual(["a", "b"]);
    expect(walkLines("a\nb\n").total).toBe(2);
  });

  it("keeps an empty text as its one empty line, exactly as splitLines does", () => {
    expect(splitLines("")).toEqual([""]);
    expect(walkLines("").total).toBe(1);
    expect(walkLines("", [fullRange(1)]).ranges[0]).toEqual([""]);
  });

  it("does not break on a lone \\r, and does break on \\r\\n", () => {
    expect(walkLines("a\rb", [fullRange(1)]).ranges[0]).toEqual(["a\rb"]);
    expect(walkLines("a\r\nb", [fullRange(2)]).ranges[0]).toEqual(["a\r", "b"]);
  });

  it("is byte-exact on astral characters and odd whitespace (UTF-16 code units are not lines)", () => {
    expect(walkLines("😀\n\u2028\nx", [fullRange(3)]).ranges[0]).toEqual(["😀", "\u2028", "x"]);
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
    expect(walkLines("a\nb\n").total).toBe(2);
  });

  it("walks an empty text as the one empty line splitLines yields", () => {
    expect(walkLines("", [{ start: 0, end: 5 }]).ranges[0]).toEqual([""]);
    expect(walkLines("", [fullRange(1)]).ranges[0]).toEqual([""]);
  });
});

describe("walkLines — visit", () => {
  it("offers every line in order with its index, matching splitLines", () => {
    const text = "a\n\nb\n";
    const seen: Array<[number, string]> = [];
    const walk = walkLines(text, [{ start: 1, end: 2 }], (line, index) => seen.push([index, line]));
    expect(seen).toEqual(splitLines(text).map((line, index) => [index, line]));
    expect(walk.ranges[0]).toEqual([""]);
  });

  it("visits lines outside every requested range (the served read anchors every row)", () => {
    const seen: string[] = [];
    const walk = walkLines("a\nb\nc\nd", [{ start: 1, end: 2 }], (line) => seen.push(line));
    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(walk.ranges[0]).toEqual(["b"]);
  });
});

describe("visibleLineTotal — the read's line count", () => {
  it("matches visLines(text).length without materializing the lines", () => {
    for (const text of ORACLE_CASES) {
      expect(visibleLineTotal(text, walkLines(text).total)).toBe(visLines(text).length);
    }
  });

  it("counts the empty text as no lines, the one case where visLines and splitLines differ", () => {
    expect(visibleLineTotal("", 1)).toBe(0);
    expect(visibleLineTotal("a\nb\n", 2)).toBe(2);
    expect(visibleLineTotal("\r", 1)).toBe(1);
  });
});
