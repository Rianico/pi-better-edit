import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  applyEdits,
  lineHashes,
  resEdits,
  type HTEdit,
} from "../../src/hashline";
import { makeTag, setupTestHome } from "../support/fixtures";

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

describe("resAnchor (via valEdits)", () => {
  it("resolves a hash that exists exactly once", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["X", "Y"] },
    ]));
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("reports not_found for a hash that does not exist", () => {
    const content = "a\nb\nc\nd\ne";
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: ["X"] },
      ]))
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("reports ambiguous when hash matches multiple lines (synthetic collision)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, testPath);
    const forgedHashes = [hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!];
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: ["X"] },
      ]), undefined, forgedHashes)
    ).toThrow(/E_AMBIGUOUS_ANCHOR/);
  });
});

describe("checkBoundaryDup (via valEdits) — auto-fix", () => {
  it("auto-fixes trailing duplication", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["X", "d"] },
    ]));
    expect(result.content).toBe("a\nX\nd");
    expect(result.autoFixes).toBeDefined();
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
  });

  it("auto-fixes leading duplication", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["a", "X"] },
    ]));
    expect(result.content).toBe("a\nX\nd");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
  });

  it("does not auto-fix when replacement does not duplicate adjacent lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["X", "Y"] },
    ]));
    expect(result.autoFixes ?? []).toHaveLength(0);
  });

  it("does not auto-fix when replacement edge is empty string", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: [] },
    ]));
    expect(result.autoFixes ?? []).toHaveLength(0);
  });

  it("auto-fixes both trailing and leading in one edit", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["a", "d"] },
    ]));
    expect(result.content).toBe("a\nd");
    expect(result.autoFixes).toHaveLength(2);
  });
});

describe("resToSpan (via applyEdits)", () => {
  it("branch: non-empty replacement in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["X", "Y"] },
    ]));
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("branch: empty replacement (deletion) in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: [] },
    ]));
    expect(result.content).toBe("a\nd\ne");
  });

  it("branch: empty replacement covering entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, testPath);
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: [hashes[0]!, hashes[2]!], content_lines: [] },
      ]))
    ).toThrow(/E_WOULD_EMPTY/);
  });

  it("branch: empty replacement ending at last line (not full file)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[2]!, hashes[4]!], content_lines: [] },
    ]));
    expect(result.content).toBe("a\nb");
  });

  it("branch: noop detection returns null span", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["b"] },
    ]));
    expect(result.noopEdits).toHaveLength(1);
  });

  it("branch: replacement at first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: ["X"] },
    ]));
    expect(result.content).toBe("X\nb\nc");
  });

  it("branch: replacement at last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: ["X"] },
    ]));
    expect(result.content).toBe("a\nb\nX");
  });

  it("branch: deletion of first line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: [] },
    ]));
    expect(result.content).toBe("b\nc");
  });

  it("branch: deletion of last line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: [] },
    ]));
    expect(result.content).toBe("a\nb");
  });
});

describe("assemble (via applyEdits)", () => {
  it("applies multiple non-overlapping edits in correct order", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: ["A"] },
      { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: ["C"] },
      { hash_range_inclusive: [hashes[4]!, hashes[4]!], content_lines: ["E"] },
    ]));
    expect(result.content).toBe("A\nb\nC\nd\nE");
  });

  it("applies edits bottom-up so earlier edits don't shift later offsets", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: [] },
      { hash_range_inclusive: [hashes[4]!, hashes[4]!], content_lines: [] },
    ]));
    expect(result.content).toBe("b\nc\nd");
  });
});

describe("resSpans (via applyEdits)", () => {
  it("deduplicates identical edits", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, testPath);
    const hash = hashes[1]!;
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hash, hash], content_lines: ["X"] },
      { hash_range_inclusive: [hash, hash], content_lines: ["X"] },
    ]));
    expect(result.content).toBe("a\nX\nc\nd\ne");
  });

  it("throws on overlapping edits", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, testPath);
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["X"] },
        { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: ["Y"] },
      ]))
    ).toThrow(/E_EDIT_CONFLICT/);
  });
});

describe("auto-fix via applyEdits", () => {
  it("auto-fixes trailing duplication", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["new one", "new two", "after"] },
    ]));
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
    expect(result.autoFixes![0]!.removedLine).toBe("after");
    expect(result.content).toBe("before\nnew one\nnew two\nafter");
  });

  it("auto-fixes leading duplication", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["before", "new one", "new two"] },
    ]));
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
    expect(result.autoFixes![0]!.removedLine).toBe("before");
    expect(result.content).toBe("before\nnew one\nnew two\nafter");
  });

  it("auto-fixes both leading and trailing in one edit", async () => {
    const content = "ctx1\nctx2\nold1\nold2\nctx3\nctx4";
    const hashes = await lineHashes(content, testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[2]!, hashes[3]!], content_lines: ["ctx2", "dup", "dup", "ctx3"] },
    ]));
    expect(result.autoFixes).toBeDefined();
    expect(result.autoFixes).toHaveLength(2);
    expect(result.content).toBe("ctx1\nctx2\ndup\ndup\nctx3\nctx4");
  });
});
