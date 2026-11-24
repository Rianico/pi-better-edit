/**
 * The shared unserved-interior formatter (ticket #319). One pure function owns both voices the
 * unserved interior is reported in: the strict `[E_UNSERVED_RANGE]` refusal and the hint
 * `[W_UNSERVED_INTERIOR]` applied warning. The summary names the count, the path (strict) and the
 * replaced file-line denominator; the list carries absolute file lines with contiguous runs
 * compressed and a five-entry cap.
 */
import { describe, expect, it } from "vitest";
import { formatUnservedSpanMessage } from "../../src/unserved-span-message.js";

const HINT_TAIL =
  "Edits should only modify lines previously read and served (enforced under strict mode); " +
  "verify this uninspected replacement was intended.";

describe("formatUnservedSpanMessage — strict voice", () => {
  it("names one unserved line without a range", () => {
    expect(
      formatUnservedSpanMessage({
        voice: "strict",
        path: "hole.txt",
        unservedLines: [2],
        replacedLineCount: 3,
      }),
    ).toBe(
      "Strict span mode refused the edit to hole.txt: 1 of the 3 file lines it replaces was never served.\n" +
        "Unserved file line: 2",
    );
  });

  it("compresses a contiguous run", () => {
    expect(
      formatUnservedSpanMessage({
        voice: "strict",
        path: "sample.txt",
        unservedLines: [4, 5, 6],
        replacedLineCount: 9,
      }),
    ).toBe(
      "Strict span mode refused the edit to sample.txt: 3 of the 9 file lines it replaces were never served.\n" +
        "Unserved file lines: 4-6",
    );
  });

  it("comma-separates non-contiguous runs", () => {
    expect(
      formatUnservedSpanMessage({
        voice: "strict",
        path: "m5.txt",
        unservedLines: [4, 5, 6, 9],
        replacedLineCount: 9,
      }),
    ).toBe(
      "Strict span mode refused the edit to m5.txt: 4 of the 9 file lines it replaces were never served.\n" +
        "Unserved file lines: 4-6, 9",
    );
  });

  it("sorts and de-duplicates raw input before compressing runs", () => {
    expect(
      formatUnservedSpanMessage({
        voice: "strict",
        path: "unsorted.txt",
        unservedLines: [9, 4, 5, 6, 4],
        replacedLineCount: 10,
      }),
    ).toBe(
      "Strict span mode refused the edit to unsorted.txt: 4 of the 10 file lines it replaces were never served.\n" +
        "Unserved file lines: 4-6, 9",
    );
  });

  it("omits the remainder suffix at exactly the run cap", () => {
    expect(
      formatUnservedSpanMessage({
        voice: "strict",
        path: "cap.txt",
        unservedLines: [2, 4, 6, 8, 10],
        replacedLineCount: 12,
      }),
    ).toBe(
      "Strict span mode refused the edit to cap.txt: 5 of the 12 file lines it replaces were never served.\n" +
        "Unserved file lines: 2, 4, 6, 8, 10",
    );
  });

  it("caps the list at five runs while the summary keeps the exact count", () => {
    expect(
      formatUnservedSpanMessage({
        voice: "strict",
        path: "big.txt",
        unservedLines: [402, 403, 404, 410, 418, 419, 420, 451, 477, 478, 479, 480, 490, 500],
        replacedLineCount: 100,
      }),
    ).toBe(
      "Strict span mode refused the edit to big.txt: 14 of the 100 file lines it replaces were never served.\n" +
        "Unserved file lines: 402-404, 410, 418-420, 451, 477-480 (+2 more lines)",
    );
  });

  it("agrees the cap's remainder in the singular", () => {
    expect(
      formatUnservedSpanMessage({
        voice: "strict",
        path: "big.txt",
        unservedLines: [1, 3, 5, 7, 9, 11],
        replacedLineCount: 12,
      }),
    ).toBe(
      "Strict span mode refused the edit to big.txt: 6 of the 12 file lines it replaces were never served.\n" +
        "Unserved file lines: 1, 3, 5, 7, 9 (+1 more line)",
    );
  });

  it("counts the cap's hidden remainder in lines when the hidden run spans several", () => {
    expect(
      formatUnservedSpanMessage({
        voice: "strict",
        path: "tail.txt",
        unservedLines: [1, 3, 5, 7, 9, 20, 21, 22, 23, 24, 25],
        replacedLineCount: 30,
      }),
    ).toBe(
      "Strict span mode refused the edit to tail.txt: 11 of the 30 file lines it replaces were never served.\n" +
        "Unserved file lines: 1, 3, 5, 7, 9 (+6 more lines)",
    );
  });

  it("degrades to a pathless clause when the call site has no path", () => {
    expect(
      formatUnservedSpanMessage({
        voice: "strict",
        unservedLines: [4, 5, 6],
        replacedLineCount: 9,
      }),
    ).toBe(
      "Strict span mode refused the edit: 3 of the 9 file lines it replaces were never served.\n" +
        "Unserved file lines: 4-6",
    );
  });

  it("agrees the replaced span noun in the singular", () => {
    expect(
      formatUnservedSpanMessage({
        voice: "strict",
        path: "single.txt",
        unservedLines: [5],
        replacedLineCount: 1,
      }),
    ).toBe(
      "Strict span mode refused the edit to single.txt: 1 of the 1 file line it replaces was never served.\n" +
        "Unserved file line: 5",
    );
  });
});

describe("formatUnservedSpanMessage — hint voice", () => {
  it("names the replaced file lines, the unserved count, and the remedy", () => {
    expect(
      formatUnservedSpanMessage({
        voice: "hint",
        unservedLines: [3, 4, 6, 7, 8],
        replacedLineCount: 8,
      }),
    ).toBe(
      [
        "Span replaced 8 file lines, 5 of which were never served; the edit applied.",
        "Unserved file lines: 3-4, 6-8",
        HINT_TAIL,
      ].join("\n"),
    );
  });

  it("agrees both clauses in the singular", () => {
    expect(
      formatUnservedSpanMessage({
        voice: "hint",
        unservedLines: [3],
        replacedLineCount: 3,
      }),
    ).toBe(
      [
        "Span replaced 3 file lines, 1 of which was never served; the edit applied.",
        "Unserved file line: 3",
        HINT_TAIL,
      ].join("\n"),
    );
  });
});

describe("formatUnservedSpanMessage — non-empty precondition", () => {
  it("throws instead of formatting a fail-open clause for an empty unserved set", () => {
    const emptyStrict = () =>
      formatUnservedSpanMessage({
        voice: "strict",
        path: "empty.txt",
        unservedLines: [],
        replacedLineCount: 3,
      });
    const emptyHint = () =>
      formatUnservedSpanMessage({ voice: "hint", unservedLines: [], replacedLineCount: 0 });

    expect(emptyStrict).toThrow(TypeError);
    expect(emptyStrict).toThrow(/at least one unserved line/);
    expect(emptyHint).toThrow(TypeError);
    expect(emptyHint).toThrow(/at least one unserved line/);
  });
});
