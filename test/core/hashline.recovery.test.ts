import { describe, expect, it } from "vitest";
import {
  applyEdits,
  lineHashes,
  resEdits,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("applyEdits — recovery scenarios", () => {
  it("rejects reversed range (start > end)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: [hashes[3]!, hashes[1]!], content_lines: ["X"] },
      ]))
    ).toThrow(/E_BAD_OP/);
  });

  it("rejects overlapping edits", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["X", "Y"] },
        { hash_range_inclusive: [hashes[2]!, hashes[3]!], content_lines: ["Y"] },
      ]))
    ).toThrow(/E_EDIT_CONFLICT/);
  });

  it("rejects stale anchor", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: [hashes[0]!, hashes[1]!], content_lines: ["X", "Y"] },
      ]), undefined, ["STALE", "STALE", "STALE", "STALE", "STALE"])
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("rejects ambiguous anchor", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const forgedHashes = [hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!];
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: ["X"] },
      ]), undefined, forgedHashes)
    ).toThrow(/E_AMBIGUOUS_ANCHOR/);
  });

  it("rejects unknown fields in edit items", () => {
    const edits = [{ hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: ["x"], extra: true }] as any;
    expect(() => resEdits(edits)).toThrow(/unknown or unsupported fields/);
  });

  it("rejects missing content_lines", () => {
    const edits = [{ hash_range_inclusive: ["ZZZ", "ZZZ"] }] as any;
    expect(() => resEdits(edits)).toThrow(/requires a "content_lines" field/);
  });

  it("rejects null content_lines", () => {
    const edits = [{ hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: null }] as any;
    expect(() => resEdits(edits)).toThrow(/content_lines" must be a string array/);
  });

  it("rejects string content_lines", () => {
    const edits = [{ hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: "hello\nworld\n" }] as any;
    expect(() => resEdits(edits)).toThrow(/must be a native JSON array of strings, not a JSON string/);
  });

  it("rejects malformed hash_range_inclusive", () => {
    const edits = [{ hash_range_inclusive: ["not-valid", "not-valid"] as [string, string], content_lines: ["x"] }];
    expect(() => resEdits(edits)).toThrow(/Invalid anchor/);
  });

  it("rejects bare hash prefix in content_lines", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: [hashes[1]!, hashes[2]!] as [string, string], content_lines: [`${hashes[1]!}│b`, "X"] },
      ]))
    ).toThrow(/E_BARE_HASH_PREFIX/);
  });

  it("rejects diff preview rows in content_lines", () => {
    const edits = [{ hash_range_inclusive: ["ZZZ", "ZZZ"] as [string, string], content_lines: ["+ZZZ│new"] }];
    expect(() => resEdits(edits)).toThrow(/E_INVALID_PATCH/);
  });

  it("warns on unicode escape sequences in content", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["\\uDDDD"] },
    ]));
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("\\uDDDD");
  });

  it("handles tab characters in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: ["\t\treplaced"] },
    ]));
    expect(result.content).toBe("a\nb\n\t\treplaced");
  });

  it("preserves literal tab in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: ["\t\treplaced"] },
    ]));
    expect(result.content).toContain("\t\treplaced");
  });

  it("handles multiple edits in one call", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["x1", "x2", "x3"] },
      { hash_range_inclusive: [hashes[3]!, hashes[3]!], content_lines: ["y1"] },
    ]));
    expect(result.content).toBe("a\nx1\nx2\nx3\nc\ny1\ne");
  });

  it("detects noop when content unchanged", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["b"] },
    ]));
    expect(result.noopEdits).toHaveLength(1);
  });

  it("detects noop for range", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["b", "c"] },
    ]));
    expect(result.noopEdits).toHaveLength(1);
  });

  it("handles empty edits array", () => {
    const result = applyEdits("hello\nworld", []);
    expect(result.content).toBe("hello\nworld");
  });

  it("handles single-line file", async () => {
    const content = "hello";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: ["world"] },
    ]));
    expect(result.content).toBe("world");
  });

  it("handles append to last line", async () => {
    const content = "a\nb";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["b", "c"] },
    ]));
    expect(result.content).toBe("a\nb\nc");
  });

  it("handles delete of first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: [] },
    ]));
    expect(result.content).toBe("b\nc");
  });

  it("handles delete of last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: [] },
    ]));
    expect(result.content).toBe("a\nb");
  });

  it("handles replace of entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[0]!, hashes[2]!], content_lines: ["x", "y"] },
    ]));
    expect(result.content).toBe("x\ny");
  });
});
