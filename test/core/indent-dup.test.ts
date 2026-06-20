import { describe, expect, it } from "vitest";
import { computeLineHashes, resolveEditAnchors, applyHashlineEdits } from "../../src/hashline";

describe("indentation difference in boundary check", () => {
  it("does NOT warn when indentation differs even if trimmed content matches", () => {
    // File has } at 4 spaces. LLM adds } at 8 spaces (different indent, same trimmed content).
    const file = "function outer() {\n  function inner() {\n    return 1;\n    }\n  }";
    const hashes = computeLineHashes(file);

    const edit = {
      old_range: [hashes[1], hashes[2]], // lines 2-3
      new_lines: ["    function inner() {", "      return 2;", "        }"], // 8 spaces + }
    };

    const resolved = resolveEditAnchors([edit]);
    const result = applyHashlineEdits(file, resolved);

    // Raw lines differ: "        }" !== "    }" — no warning
    expect(result.warnings).toBeUndefined();
  });

  it("DOES warn when both indentation and content match exactly", () => {
    const file = "function outer() {\n  function inner() {\n    return 1;\n  }\n}";
    const hashes = computeLineHashes(file);

    const edit = {
      old_range: [hashes[1], hashes[2]], // lines 2-3
      new_lines: ["  function inner() {", "    return 2;", "  }"], // exact same indent as next line
    };

    const resolved = resolveEditAnchors([edit]);
    const result = applyHashlineEdits(file, resolved);

    // Exact match: "  }" === "  }" — warning fires
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("Potential boundary duplication: the last line");
  });
});
