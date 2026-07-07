import { describe, expect, it } from "vitest";
import { fmtBoundaryWarning, lineHashes } from "../../src/hashline";

describe("fmtBoundaryWarning", () => {
  it("formats a leading duplication warning with header and hashline window", () => {
    const resultLines = [
      "before",
      "before",
      "new one",
      "new two",
      "after",
    ];
    const resultHashes = lineHashes(resultLines.join("\n"));

    const output = fmtBoundaryWarning({
      kind: "leading",
      survivingContent: "before",
      matchIndex: 1,
      resultLines,
      resultHashes,
    });

    expect(output).toContain("Boundary duplication (leading)");
    expect(output).toContain(
      "the first replacement line duplicated the previous line",
    );
    // Should contain hashline-anchored rows
    expect(output).toContain("│before");
    expect(output).toContain("│new two");
    // Should contain hashline-anchored rows (2 context before + 2 dup + 2 after = up to 6)
    expect(output).toContain("│before");
    expect(output).toContain("│new two");
    // Each row should have a hash prefix
    for (const line of output.split("\n")) {
      if (line.includes("│")) {
        const hash = line.split("│")[0]!;
        expect(hash).toMatch(/^[A-Za-z0-9_\-]{3}$/);
      }
    }
  });

  it("formats a trailing duplication warning with header and hashline window", () => {
    const resultLines = [
      "before",
      "old one",
      "new trailing",
      "new trailing",
      "after",
    ];
    const resultHashes = lineHashes(resultLines.join("\n"));

    const output = fmtBoundaryWarning({
      kind: "trailing",
      survivingContent: "new trailing",
      matchIndex: 3,
      resultLines,
      resultHashes,
    });

    expect(output).toContain("Boundary duplication (trailing)");
    expect(output).toContain(
      "the last replacement line duplicated the next line",
    );
    expect(output).toContain("│new trailing");
    expect(output).toContain("│after");
  });

  it("clamps the window to file start when pair is near line 1", () => {
    const resultLines = [
      "dup",
      "dup",
      "middle",
      "end",
    ];
    const resultHashes = lineHashes(resultLines.join("\n"));

    const output = fmtBoundaryWarning({
      kind: "leading",
      survivingContent: "dup",
      matchIndex: 0,
      resultLines,
      resultHashes,
    });

    const rows = output.split("\n").filter((l) => l.includes("│"));
    // Window should start at line 0 (no negative index)
    expect(rows[0]).toContain("│dup");
    expect(rows).toHaveLength(4); // 0..3 (pairStart=0, winStart=0, winEnd=min(3, 0+3)=3, so 0..3 = 4 rows)
  });

  it("clamps the window to file end when pair is near the last line", () => {
    const resultLines = [
      "start",
      "middle",
      "dup",
      "dup",
    ];
    const resultHashes = lineHashes(resultLines.join("\n"));

    const output = fmtBoundaryWarning({
      kind: "trailing",
      survivingContent: "dup",
      matchIndex: 3,
      resultLines,
      resultHashes,
    });

    const rows = output.split("\n").filter((l) => l.includes("│"));
    // Window should end at the last line (no overflow)
    expect(rows[rows.length - 1]).toContain("│dup");
  });

  it("picks the adjacent pair nearest matchIndex when multiple identical lines exist", () => {
    // File with multiple "dup" lines; the duplication is at positions 3-4
    const resultLines = [
      "dup",
      "a",
      "dup",
      "dup",
      "dup",
      "b",
    ];
    const resultHashes = lineHashes(resultLines.join("\n"));

    const output = fmtBoundaryWarning({
      kind: "leading",
      survivingContent: "dup",
      matchIndex: 3, // occurrence index 3 → line 4 (0-based), which is inside the 3-4 pair
      resultLines,
      resultHashes,
    });

    // The window should center on the pair at 3-4 (the one nearest matchIndex=3)
    const rows = output.split("\n").filter((l) => l.includes("│"));
    // Should include context around the 3-4 pair
    const rowContents = rows.map((r) => r.split("│")[1] ?? "");
    expect(rowContents).toContain("a");
    expect(rowContents).toContain("dup");
    expect(rowContents).toContain("b");
  });

  it("falls back to matchIndex as pairStart when no adjacent pair is found", () => {
    const resultLines = [
      "alpha",
      "beta",
      "gamma",
    ];
    const resultHashes = lineHashes(resultLines.join("\n"));

    // No adjacent pair exists, but we still get a window centered on matchIndex
    const output = fmtBoundaryWarning({
      kind: "leading",
      survivingContent: "beta",
      matchIndex: 1,
      resultLines,
      resultHashes,
    });

    expect(output).toContain("│beta");
    expect(output).toContain("│alpha");
    expect(output).toContain("│gamma");
  });

  it("includes exactly 2 lines of context before and after the pair", () => {
    const resultLines = [
      "ctx1",
      "ctx2",
      "dup",
      "dup",
      "ctx3",
      "ctx4",
    ];
    const resultHashes = lineHashes(resultLines.join("\n"));

    const output = fmtBoundaryWarning({
      kind: "trailing",
      survivingContent: "dup",
      matchIndex: 2,
      resultLines,
      resultHashes,
    });

    const rows = output.split("\n").filter((l) => l.includes("│"));
    expect(rows).toHaveLength(6); // 2 before + 2 dup + 2 after
    expect(rows[0]).toContain("│ctx1");
    expect(rows[1]).toContain("│ctx2");
    expect(rows[2]).toContain("│dup");
    expect(rows[3]).toContain("│dup");
    expect(rows[4]).toContain("│ctx3");
    expect(rows[5]).toContain("│ctx4");
  });
});
