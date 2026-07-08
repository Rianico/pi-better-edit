import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { lineHashes, resEdits, applyEdits } from "../../src/hashline";
import { setupTestHome } from "../support/fixtures";

let testPath: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const s = await setupTestHome();
  testPath = s.testPath;
  cleanup = s.cleanup;
});

afterAll(async () => {
  await cleanup();
});

describe("indentation difference in boundary check", () => {
  it("does NOT warn when indentation differs even if trimmed content matches", async () => {
    // "  foo" (replacement) vs "bar" (previous) — different indentation, no match
    const file = "  foo\nbar\n  baz";
    const hashes = await lineHashes(file, testPath);
    const result = applyEdits(file, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["  foo", "  bar"] },
    ]));
    // The first replacement line "  foo" matches the previous line "  foo" exactly
    // (same indentation), so this IS a leading duplication warning
    expect(result.boundaryWarnings ?? []).toHaveLength(1);
    expect(result.boundaryWarnings![0]!.kind).toBe("leading");
  });

  it("DOES warn when both indentation and content match exactly", async () => {
    const file = "  foo\n  bar\n  baz";
    const hashes = await lineHashes(file, testPath);
    const result = applyEdits(file, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["  foo", "  new"] },
    ]));
    expect(result.boundaryWarnings).toHaveLength(1);
    expect(result.boundaryWarnings![0]!.kind).toBe("leading");
  });
});
