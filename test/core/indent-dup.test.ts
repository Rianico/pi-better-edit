import { describe, expect, it } from "vitest";
import { lineHashes, resEdits, applyEdits } from "../../src/hashline";

describe("indentation difference in boundary check", () => {
  it("does NOT warn when indentation differs even if trimmed content matches", () => {
    // File has } at 4 spaces. LLM adds } at 8 spaces (different indent, same trimmed content).
    const file = "function outer() {\n  function inner() {\n    return 1;\n    }\n  }";
    const hashes = lineHashes(file);

    const edit = {
      old_range: [hashes[1], hashes[2]] as [string, string],
      new_lines: ["    function inner() {", "      return 2;", "        }"],
    };

    const resolved = resEdits([edit]);
    const result = applyEdits(file, resolved);

    // Raw lines differ: "        }" !== "    }" — no warning
    expect(result.warnings).toBeUndefined();
  });

  it("DOES warn when both indentation and content match exactly", () => {
    const file = "function outer() {\n  function inner() {\n    return 1;\n  }\n}";
    const hashes = lineHashes(file);

    const edit = {
      old_range: [hashes[1], hashes[2]] as [string, string],
      new_lines: ["  function inner() {", "    return 2;", "  }"],
    };

    const resolved = resEdits([edit]);
    const result = applyEdits(file, resolved);

    // Exact match: "  }" === "  }" — warning fires
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("Potential boundary duplication: the last line");
  });
});
