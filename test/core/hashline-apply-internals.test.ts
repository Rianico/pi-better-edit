import { describe, expect, it } from "vitest";
import {
  buildIdx,
  changedRange,
  applyEdits,
  valEdits,
  lineHashes,
  type HEdit,
  type HTEdit,
} from "../../src/hashline";
import { makeTag } from "../support/fixtures";

// ---------------------------------------------------------------------------
// buildIdx — line index construction
// ---------------------------------------------------------------------------
describe("buildIdx", () => {
  it("handles empty string", () => {
    const idx = buildIdx("");
    expect(idx.fileLines).toEqual([""]);
    expect(idx.lineStarts).toEqual([0]);
    expect(idx.hasTerminalNewline).toBe(false);
  });

  it("handles single line without trailing newline", () => {
    const idx = buildIdx("hello");
    expect(idx.fileLines).toEqual(["hello"]);
    expect(idx.lineStarts).toEqual([0]);
    expect(idx.hasTerminalNewline).toBe(false);
  });

  it("handles single line with trailing newline", () => {
    const idx = buildIdx("hello\n");
    expect(idx.fileLines).toEqual(["hello", ""]);
    expect(idx.lineStarts).toEqual([0, 6]);
    expect(idx.hasTerminalNewline).toBe(true);
  });

  it("handles content with only a newline (one blank line)", () => {
    const idx = buildIdx("\n");
    expect(idx.fileLines).toEqual(["", ""]);
    expect(idx.lineStarts).toEqual([0, 1]);
    expect(idx.hasTerminalNewline).toBe(true);
  });

  it("handles multiple lines without trailing newline", () => {
    const idx = buildIdx("a\nb\nc");
    expect(idx.fileLines).toEqual(["a", "b", "c"]);
    expect(idx.lineStarts).toEqual([0, 2, 4]);
    expect(idx.hasTerminalNewline).toBe(false);
  });

  it("handles multiple lines with trailing newline", () => {
    const idx = buildIdx("a\nb\nc\n");
    expect(idx.fileLines).toEqual(["a", "b", "c", ""]);
    expect(idx.lineStarts).toEqual([0, 2, 4, 6]);
    expect(idx.hasTerminalNewline).toBe(true);
  });

  it("lineStarts point to correct character offsets", () => {
    const idx = buildIdx("alpha\nbeta\ngamma");
    // a(0) l(1) p(2) h(3) a(4) \n(5) b(6) e(7) t(8) a(9) \n(10) g(11) ...
    expect(idx.lineStarts[0]).toBe(0);  // "alpha" starts at 0
    expect(idx.lineStarts[1]).toBe(6);  // "beta" starts at 6
    expect(idx.lineStarts[2]).toBe(11); // "gamma" starts at 11
  });
});

// ---------------------------------------------------------------------------
// changedRange — edge cases
// ---------------------------------------------------------------------------
describe("changedRange — edge cases", () => {
  it("returns null for identical content", () => {
    expect(changedRange("a\nb\nc", "a\nb\nc")).toBeNull();
  });

  it("tracks appending to a file that ends with newline (with trailing newline)", () => {
    // original = "a\nb\n", result = "a\nb\nc\n"
    const r = changedRange("a\nb\n", "a\nb\nc\n");
    expect(r).toEqual({ firstChangedLine: 3, lastChangedLine: 3 });
  });

  it("tracks appending to a file that ends with newline (no trailing newline in append)", () => {
    // original = "a\nb\n", result = "a\nb\nc"
    // This is the edge case: firstChangedLine could be > lastChangedLine
    const r = changedRange("a\nb\n", "a\nb\nc");
    expect(r).not.toBeNull();
    expect(r!.firstChangedLine).toBeLessThanOrEqual(r!.lastChangedLine);
  });

  it("tracks prepending at BOF", () => {
    const r = changedRange("a\nb\nc", "X\na\nb\nc");
    expect(r).toEqual({ firstChangedLine: 1, lastChangedLine: 1 });
  });

  it("tracks replacing entire content", () => {
    const r = changedRange("a\nb\nc", "x\ny\nz");
    expect(r).toEqual({ firstChangedLine: 1, lastChangedLine: 3 });
  });

  it("tracks empty original becoming non-empty", () => {
    const r = changedRange("", "hello");
    expect(r).toEqual({ firstChangedLine: 1, lastChangedLine: 1 });
  });

  it("tracks non-empty becoming empty", () => {
    const r = changedRange("a", "");
    expect(r).toEqual({ firstChangedLine: 1, lastChangedLine: 1 });
  });

  it("tracks single character change", () => {
    const r = changedRange("abc", "aBc");
    expect(r).toEqual({ firstChangedLine: 1, lastChangedLine: 1 });
  });

  it("tracks change on last line of multi-line file", () => {
    const r = changedRange("a\nb\nc", "a\nb\nC");
    expect(r).toEqual({ firstChangedLine: 3, lastChangedLine: 3 });
  });
});

// ---------------------------------------------------------------------------
// resAnchor — anchor resolution (through valEdits)
// ---------------------------------------------------------------------------
describe("resAnchor (via valEdits)", () => {
  it("resolves a hash that exists exactly once", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = lineHashes(content);
    const fileLines = content.split("\n");
    const edits: HEdit[] = [
      { hash_range_inclusive: [{ hash: hashes[1]! }, { hash: hashes[1]! }], content_lines: ["BETA"] },
    ];
    const { resolved, mismatches } = valEdits(edits, fileLines, hashes, [], undefined);
    expect(mismatches).toHaveLength(0);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.hash_range_inclusive[0].line).toBe(2);
  });

  it("reports not_found for a hash that does not exist", () => {
    const content = "alpha\nbeta";
    const hashes = lineHashes(content);
    const fileLines = content.split("\n");
    const edits: HEdit[] = [
      { hash_range_inclusive: [{ hash: "ZZZ" }, { hash: "ZZZ" }], content_lines: ["X"] },
    ];
    const { resolved, mismatches } = valEdits(edits, fileLines, hashes, [], undefined);
    expect(resolved).toHaveLength(0);
    expect(mismatches).toHaveLength(2);
    expect(mismatches[0]!.kind).toBe("not_found");
  });

  it("reports ambiguous when hash matches multiple lines (synthetic collision)", () => {
    const content = "alpha\nbeta\nalpha";
    const hashes = lineHashes(content);
    const fileLines = content.split("\n");
    // Forge a collision: make line 3's hash match line 1's
    const forgedHashes = [...hashes];
    forgedHashes[2] = hashes[0]!;
    const edits: HEdit[] = [
      { hash_range_inclusive: [{ hash: hashes[0]! }, { hash: hashes[0]! }], content_lines: ["X"] },
    ];
    const { resolved, mismatches } = valEdits(edits, forgedHashes, forgedHashes, [], undefined);
    expect(resolved).toHaveLength(0);
    expect(mismatches).toHaveLength(2);
    expect(mismatches[0]!.kind).toBe("ambiguous");
  });
});

// ---------------------------------------------------------------------------
// checkBoundaryDup — boundary duplication detection (through valEdits)
// ---------------------------------------------------------------------------
describe("checkBoundaryDup (via valEdits)", () => {
  it("detects trailing duplication", () => {
    const content = "before\ntarget\nafter";
    const hashes = lineHashes(content);
    const fileLines = content.split("\n");
    // Replace line 2 with content that ends with "after" (duplicating line 3)
    const edits: HEdit[] = [
      { hash_range_inclusive: [{ hash: hashes[1]! }, { hash: hashes[1]! }], content_lines: ["new", "after"] },
    ];
    const { boundaryWarnings } = valEdits(edits, fileLines, hashes, [], undefined);
    expect(boundaryWarnings).toHaveLength(1);
    expect(boundaryWarnings[0]!.kind).toBe("trailing");
    expect(boundaryWarnings[0]!.survivingLineContent).toBe("after");
  });

  it("detects leading duplication", () => {
    const content = "before\ntarget\nafter";
    const hashes = lineHashes(content);
    const fileLines = content.split("\n");
    // Replace line 2 with content that starts with "before" (duplicating line 1)
    const edits: HEdit[] = [
      { hash_range_inclusive: [{ hash: hashes[1]! }, { hash: hashes[1]! }], content_lines: ["before", "new"] },
    ];
    const { boundaryWarnings } = valEdits(edits, fileLines, hashes, [], undefined);
    expect(boundaryWarnings).toHaveLength(1);
    expect(boundaryWarnings[0]!.kind).toBe("leading");
    expect(boundaryWarnings[0]!.survivingLineContent).toBe("before");
  });

  it("does not warn when replacement does not duplicate adjacent lines", () => {
    const content = "before\ntarget\nafter";
    const hashes = lineHashes(content);
    const fileLines = content.split("\n");
    const edits: HEdit[] = [
      { hash_range_inclusive: [{ hash: hashes[1]! }, { hash: hashes[1]! }], content_lines: ["new"] },
    ];
    const { boundaryWarnings } = valEdits(edits, fileLines, hashes, [], undefined);
    expect(boundaryWarnings).toHaveLength(0);
  });

  it("does not warn when replacement edge is empty string", () => {
    const content = "before\ntarget\nafter";
    const hashes = lineHashes(content);
    const fileLines = content.split("\n");
    const edits: HEdit[] = [
      { hash_range_inclusive: [{ hash: hashes[1]! }, { hash: hashes[1]! }], content_lines: [] },
    ];
    const { boundaryWarnings } = valEdits(edits, fileLines, hashes, [], undefined);
    expect(boundaryWarnings).toHaveLength(0);
  });

  it("detects both trailing and leading in one edit", () => {
    const content = "before\ntarget\nafter";
    const hashes = lineHashes(content);
    const fileLines = content.split("\n");
    // Replace line 2 with content that both starts with "before" and ends with "after"
    const edits: HEdit[] = [
      { hash_range_inclusive: [{ hash: hashes[1]! }, { hash: hashes[1]! }], content_lines: ["before", "new", "after"] },
    ];
    const { boundaryWarnings } = valEdits(edits, fileLines, hashes, [], undefined);
    expect(boundaryWarnings).toHaveLength(2);
    expect(boundaryWarnings[0]!.kind).toBe("trailing");
    expect(boundaryWarnings[1]!.kind).toBe("leading");
  });
});

// ---------------------------------------------------------------------------
// resToSpan — span computation (through applyEdits)
// ---------------------------------------------------------------------------
describe("resToSpan (via applyEdits)", () => {
  it("branch: non-empty replacement in middle of file", () => {
    const content = "a\nb\nc\nd";
    const result = applyEdits(content, [
      { hash_range_inclusive: [makeTag(content, 2), makeTag(content, 3)], content_lines: ["X", "Y"] },
    ]);
    expect(result.content).toBe("a\nX\nY\nd");
  });

  it("branch: empty replacement (deletion) in middle of file", () => {
    const content = "a\nb\nc\nd";
    const result = applyEdits(content, [
      { hash_range_inclusive: [makeTag(content, 2), makeTag(content, 3)], content_lines: [] },
    ]);
    expect(result.content).toBe("a\nd");
  });

  it("branch: empty replacement covering entire file", () => {
    const content = "a\nb";
    expect(() => applyEdits(content, [
      { hash_range_inclusive: [makeTag(content, 1), makeTag(content, 2)], content_lines: [] },
    ])).toThrow(/E_WOULD_EMPTY/);
  });

  it("branch: empty replacement ending at last line (not full file)", () => {
    const content = "a\nb\nc";
    const result = applyEdits(content, [
      { hash_range_inclusive: [makeTag(content, 2), makeTag(content, 3)], content_lines: [] },
    ]);
    expect(result.content).toBe("a");
  });

  it("branch: noop detection returns null span", () => {
    const content = "a\nb\nc";
    const result = applyEdits(content, [
      { hash_range_inclusive: [makeTag(content, 2), makeTag(content, 2)], content_lines: ["b"] },
    ]);
    expect(result.noopEdits).toHaveLength(1);
    expect(result.content).toBe("a\nb\nc");
  });

  it("branch: replacement at first line", () => {
    const content = "a\nb\nc";
    const result = applyEdits(content, [
      { hash_range_inclusive: [makeTag(content, 1), makeTag(content, 1)], content_lines: ["X"] },
    ]);
    expect(result.content).toBe("X\nb\nc");
  });

  it("branch: replacement at last line", () => {
    const content = "a\nb\nc";
    const result = applyEdits(content, [
      { hash_range_inclusive: [makeTag(content, 3), makeTag(content, 3)], content_lines: ["X"] },
    ]);
    expect(result.content).toBe("a\nb\nX");
  });

  it("branch: deletion of first line only", () => {
    const content = "a\nb\nc";
    const result = applyEdits(content, [
      { hash_range_inclusive: [makeTag(content, 1), makeTag(content, 1)], content_lines: [] },
    ]);
    expect(result.content).toBe("b\nc");
  });

  it("branch: deletion of last line only", () => {
    const content = "a\nb\nc";
    const result = applyEdits(content, [
      { hash_range_inclusive: [makeTag(content, 3), makeTag(content, 3)], content_lines: [] },
    ]);
    expect(result.content).toBe("a\nb");
  });
});

// ---------------------------------------------------------------------------
// assemble — span application ordering (through applyEdits)
// ---------------------------------------------------------------------------
describe("assemble (via applyEdits)", () => {
  it("applies multiple non-overlapping edits in correct order", () => {
    const content = "a\nb\nc\nd\ne";
    const result = applyEdits(content, [
      { hash_range_inclusive: [makeTag(content, 1), makeTag(content, 1)], content_lines: ["A"] },
      { hash_range_inclusive: [makeTag(content, 3), makeTag(content, 3)], content_lines: ["C"] },
      { hash_range_inclusive: [makeTag(content, 5), makeTag(content, 5)], content_lines: ["E"] },
    ]);
    expect(result.content).toBe("A\nb\nC\nd\nE");
  });

  it("applies edits bottom-up so earlier edits don't shift later offsets", () => {
    const content = "a\nb\nc\nd\ne";
    // Delete line 5 first (bottom), then line 1 (top)
    const result = applyEdits(content, [
      { hash_range_inclusive: [makeTag(content, 1), makeTag(content, 1)], content_lines: [] },
      { hash_range_inclusive: [makeTag(content, 5), makeTag(content, 5)], content_lines: [] },
    ]);
    expect(result.content).toBe("b\nc\nd");
  });
});

// ---------------------------------------------------------------------------
// resSpans — deduplication and conflict detection (through applyEdits)
// ---------------------------------------------------------------------------
describe("resSpans (via applyEdits)", () => {
  it("deduplicates identical edits", () => {
    const content = "a\nb\nc";
    const tag = makeTag(content, 2);
    const result = applyEdits(content, [
      { hash_range_inclusive: [{ ...tag }, { ...tag }], content_lines: ["B"] },
      { hash_range_inclusive: [{ ...tag }, { ...tag }], content_lines: ["B"] },
    ]);
    expect(result.content).toBe("a\nB\nc");
  });

  it("throws on overlapping edits", () => {
    const content = "a\nb\nc\nd";
    expect(() => applyEdits(content, [
      { hash_range_inclusive: [makeTag(content, 2), makeTag(content, 3)], content_lines: ["X"] },
      { hash_range_inclusive: [makeTag(content, 3), makeTag(content, 3)], content_lines: ["Y"] },
    ])).toThrow(/E_EDIT_CONFLICT/);
  });
});

// ---------------------------------------------------------------------------
// fmtBoundaryWarning — warning content (through applyEdits)
// ---------------------------------------------------------------------------
describe("fmtBoundaryWarning (via applyEdits)", () => {
  it("trailing warning contains header and hashline rows", () => {
    const content = "if (ok) {\n  run();\n}\nafter();";
    const result = applyEdits(content, [
      {
        hash_range_inclusive: [makeTag(content, 1), makeTag(content, 2)],
        content_lines: ["if (ok) {", "  runSafe();", "}"],
      },
    ]);
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain("Boundary duplication (trailing)");
    expect(result.warnings![0]).toMatch(/[A-Za-z0-9_-]{3}│/); // hashline rows
  });

  it("leading warning contains header and hashline rows", () => {
    const content = "before();\nif (ok) {\n  run();\n}\nafter();";
    const result = applyEdits(content, [
      {
        hash_range_inclusive: [makeTag(content, 2), makeTag(content, 3)],
        content_lines: ["before();", "if (ok) {", "  runSafe();"],
      },
    ]);
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain("Boundary duplication (leading)");
    expect(result.warnings![0]).toMatch(/[A-Za-z0-9_-]{3}│/);
  });

  it("warning window includes context lines around the duplicate pair", () => {
    const content = "a\nb\nc\nd\ne\nf\ng";
    const result = applyEdits(content, [
      {
        hash_range_inclusive: [makeTag(content, 3), makeTag(content, 4)],
        content_lines: ["c", "d", "e"],
      },
    ]);
    // After edit: a\nb\nc\nd\ne\ne\nf\ng — "e" is duplicated at lines 5-6
    expect(result.warnings).toBeDefined();
    if (result.warnings) {
      const rows = result.warnings[0]!.split("\n");
      // Should have header + blank line + at least 5 hashline rows (dup pair + 2 context each side)
      const hashlineRows = rows.filter((r) => /[A-Za-z0-9_-]{3}│/.test(r));
      expect(hashlineRows.length).toBeGreaterThanOrEqual(5);
    }
  });
});
