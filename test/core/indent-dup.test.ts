import { describe, expect, it } from "vitest";
import { lineHashes, resEdits, applyEdits } from "../../src/hashline";

describe("indentation difference in boundary check", () => {
  it("does NOT warn when indentation differs even if trimmed content matches", () => {

    const file = "function outer() {\n  function inner() {\n    return 1;\n    }\n  }";
    const hashes = lineHashes(file);

    const edit = {
      hash_range_incl: [hashes[1], hashes[2]] as [string, string],
      content_lines: ["    function inner() {", "      return 2;", "        }"],
    };
    const resolved = resEdits([edit]);
    const result = applyEdits(file, resolved);

    expect(result.warnings).toBeUndefined();
  });

  it("DOES warn when both indentation and content match exactly", () => {
    const file = "function outer() {\n  function inner() {\n    return 1;\n  }\n}";
    const hashes = lineHashes(file);

    const edit = {
      hash_range_incl: [hashes[1], hashes[2]] as [string, string],
      content_lines: ["  function inner() {", "    return 2;", "  }"],
    };
    const resolved = resEdits([edit]);
    const result = applyEdits(file, resolved);

    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("Potential boundary duplication: the last line");
  });
});
