import { describe, expect, it } from "vitest";
import {
  applyEdit,
  lineHashes,
  resEdit,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("applyEdit — recovery scenarios", () => {
  it("autocorrects reversed range (start > end)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[3]!, hashes[1]!], content_lines: ["X"] },
    ));
    expect(result.content).toBe("a\nX\ne");
    expect(result.warnings?.[0]).toMatch(/Autocorrected: hash_range_inclusive was reversed/);
  });

  it("rejects stale anchor", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(content, resEdit(
        { hash_range_inclusive: [hashes[0]!, hashes[1]!], content_lines: ["X", "Y"] },
      ), undefined, ["STALE", "STALE", "STALE", "STALE", "STALE"])
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("shows current context around the resolved anchor when only one anchor of a range is stale", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const staleStart = "ZZZ";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { hash_range_inclusive: [staleStart, hashes[2]!], content_lines: ["X"] },
      ));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/E_STALE_ANCHOR/);
    expect(caught!.message).toMatch(/Current context around resolved anchor/);
    expect(caught!.message).toContain(` 3: ${hashes[2]}│c`);
  });

  it("shows context anchored on the start when only the end is stale", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const staleEnd = "ZZZ";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { hash_range_inclusive: [hashes[0]!, staleEnd], content_lines: ["X"] },
      ));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/Current context around resolved anchor/);
    expect(caught!.message).toContain(` 1: ${hashes[0]}│a`);
  });

  it("omits context when both anchors are stale", async () => {
    const content = "a\nb\nc";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { hash_range_inclusive: ["ZZZ", "YYY"], content_lines: ["X"] },
      ));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toMatch(/Current context around resolved anchor/);
  });

  it("rejects ambiguous anchor", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const forgedHashes = [hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!];
    expect(() =>
      applyEdit(content, resEdit(
        { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: ["X"] },
      ), undefined, forgedHashes)
    ).toThrow(/E_AMBIGUOUS_ANCHOR/);
  });

  it("rejects unknown fields in edit items", () => {
    const edit = { hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: ["x"], extra: true } as any;
    expect(() => resEdit(edit)).toThrow(/unknown or unsupported fields/);
  });

  it("rejects missing content_lines", () => {
    const edit = { hash_range_inclusive: ["ZZZ", "ZZZ"] } as any;
    expect(() => resEdit(edit)).toThrow(/requires a "content_lines" field/);
  });

  it("rejects null content_lines", () => {
    const edit = { hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: null } as any;
    expect(() => resEdit(edit)).toThrow(/content_lines" must be a string array/);
  });

  it("rejects string content_lines", () => {
    const edit = { hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: "hello\nworld\n" } as any;
    expect(() => resEdit(edit)).toThrow(/must be a native JSON array of strings, not a JSON string/);
  });

  it("rejects malformed hash_range_inclusive", () => {
    const edit = { hash_range_inclusive: ["not-valid", "not-valid"] as [string, string], content_lines: ["x"] };
    expect(() => resEdit(edit)).toThrow(/Invalid anchor/);
  });

  it("strips bare hash prefix in content_lines", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[1]!, hashes[2]!] as [string, string], content_lines: [`${hashes[1]!}│b`, "X"] },
    ));
    expect(result.content).toBe("a\nb\nX\nd\ne");
    expect(result.warnings?.[0]).toMatch(/stripped "HASH│" prefix/);
  });

  it("strips diff preview rows in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[1]!, hashes[1]!] as [string, string], content_lines: [`+${hashes[1]!}│B`] },
    ));
    expect(result.content).toBe("a\nB\nc");
    expect(result.warnings?.[0]).toMatch(/stripped diff-preview marker/);
  });

  it("warns on unicode escape sequences in content", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["\\uDDDD"] },
    ));
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("\\uDDDD");
  });

  it("handles tab characters in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: ["\t\treplaced"] },
    ));
    expect(result.content).toBe("a\nb\n\t\treplaced");
  });

  it("preserves literal tab in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: ["\t\treplaced"] },
    ));
    expect(result.content).toContain("\t\treplaced");
  });

  it("detects noop when content unchanged", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["b"] },
    ));
    expect(result.noopEdit).toBeDefined();
  });

  it("detects noop for range", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["b", "c"] },
    ));
    expect(result.noopEdit).toBeDefined();
  });

  it("handles single-line file", async () => {
    const content = "hello";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: ["world"] },
    ));
    expect(result.content).toBe("world");
  });

  it("handles append to last line", async () => {
    const content = "a\nb";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["b", "c"] },
    ));
    expect(result.content).toBe("a\nb\nc");
  });

  it("handles delete of first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: [] },
    ));
    expect(result.content).toBe("b\nc");
  });

  it("handles delete of last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: [] },
    ));
    expect(result.content).toBe("a\nb");
  });

  it("handles replace of entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_range_inclusive: [hashes[0]!, hashes[2]!], content_lines: ["x", "y"] },
    ));
    expect(result.content).toBe("x\ny");
  });
});
