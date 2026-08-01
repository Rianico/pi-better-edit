import { describe, expect, it } from "vitest";
import { lineHashes, resEdits, applyEdits } from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("indentation difference in boundary auto-fix", () => {
  it("auto-fixes leading duplication when indentation matches exactly", async () => {
    const file = "  foo\nbar\n  baz";
    const hashes = await lineHashes(file, home.testPath);
    const result = applyEdits(file, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["  foo", "  bar"] },
    ]));
    expect(result.content).toBe("  foo\n  bar\n  baz");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
  });

  it("auto-fixes leading duplication when both indentation and content match exactly", async () => {
    const file = "  foo\n  bar\n  baz";
    const hashes = await lineHashes(file, home.testPath);
    const result = applyEdits(file, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["  foo", "  new"] },
    ]));
    expect(result.content).toBe("  foo\n  new\n  baz");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
  });
});
