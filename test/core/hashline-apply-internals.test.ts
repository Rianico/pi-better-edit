import { describe, expect, it } from "vitest";
import {
  applyEdit,
  lineHashes,
  resEdit,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("resAnchor (via applyEdit)", () => {
  it("resolves a hash that exists exactly once", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[2]!], new_content: "X\nY" },
    ));
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("reports not_found for a hash that does not exist", () => {
    const content = "a\nb\nc\nd\ne";
    expect(() =>
      applyEdit(content, resEdit(
        { hash_bounds: ["ZZZ", "ZZZ"], new_content: "X" },
      ))
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("reports ambiguous when hash matches multiple lines (synthetic collision)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const forgedHashes = [hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!];
    expect(() =>
      applyEdit(content, resEdit(
        { hash_bounds: [hashes[0]!, hashes[0]!], new_content: "X" },
      ), undefined, forgedHashes)
    ).toThrow(/E_AMBIGUOUS_ANCHOR/);
  });
});

describe("checkBoundaryDup (via applyEdit) — auto-fix", () => {
  it("auto-fixes trailing duplication", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[2]!], new_content: "X\nd" },
    ));
    expect(result.content).toBe("a\nX\nd");
    expect(result.autoFixes).toBeDefined();
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
  });

  it("auto-fixes leading duplication", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[2]!], new_content: "a\nX" },
    ));
    expect(result.content).toBe("a\nX\nd");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
  });

  it("does not auto-fix when replacement does not duplicate adjacent lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[2]!], new_content: "X\nY" },
    ));
    expect(result.autoFixes ?? []).toHaveLength(0);
  });

  it("does not auto-fix when replacement edge is empty string", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[2]!], new_content: "" },
    ));
    expect(result.autoFixes ?? []).toHaveLength(0);
  });

  it("auto-fixes trailing duplication when content_lines has trailing empty lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[2]!], new_content: `X\nd\n\n` },
    ));
    expect(result.content).toBe("a\nX\n\nd");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
    expect(result.autoFixes![0]!.removedLine).toBe("d");
  });

  it("auto-fixes leading duplication when content_lines has leading empty lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[2]!], new_content: `\na\nX` },
    ));
    expect(result.content).toBe("a\n\nX\nd");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
    expect(result.autoFixes![0]!.removedLine).toBe("a");
  });

  it("auto-fixes both trailing and leading in one edit", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[2]!], new_content: "a\nd" },
    ));
    expect(result.content).toBe("a\nd");
    expect(result.autoFixes).toHaveLength(2);
  });
});

describe("resToSpan (via applyEdit)", () => {
  it("branch: non-empty replacement in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[2]!], new_content: "X\nY" },
    ));
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("branch: empty replacement (deletion) in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[2]!], new_content: "" },
    ));
    expect(result.content).toBe("a\nd\ne");
  });

  it("branch: empty replacement covering entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(content, resEdit(
        { hash_bounds: [hashes[0]!, hashes[2]!], new_content: "" },
      ))
    ).toThrow(/E_WOULD_EMPTY/);
  });

  it("branch: empty replacement ending at last line (not full file)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[2]!, hashes[4]!], new_content: "" },
    ));
    expect(result.content).toBe("a\nb");
  });

  it("branch: noop detection returns noop span", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[1]!], new_content: "b" },
    ));
    expect(result.noopEdit).toBeDefined();
  });

  it("branch: replacement at first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[0]!, hashes[0]!], new_content: "X" },
    ));
    expect(result.content).toBe("X\nb\nc");
  });

  it("branch: replacement at last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[2]!, hashes[2]!], new_content: "X" },
    ));
    expect(result.content).toBe("a\nb\nX");
  });

  it("branch: deletion of first line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[0]!, hashes[0]!], new_content: "" },
    ));
    expect(result.content).toBe("b\nc");
  });

  it("branch: deletion of last line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[2]!, hashes[2]!], new_content: "" },
    ));
    expect(result.content).toBe("a\nb");
  });
});

describe("assemble (via applyEdit)", () => {
  it("applies a single edit in the middle", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[0]!, hashes[0]!], new_content: "A" },
    ));
    expect(result.content).toBe("A\nb\nc\nd\ne");
  });
});

describe("auto-fix via applyEdit", () => {
  it("auto-fixes trailing duplication", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[2]!], new_content: `new one\nnew two\nafter` },
    ));
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
    expect(result.autoFixes![0]!.removedLine).toBe("after");
    expect(result.content).toBe("before\nnew one\nnew two\nafter");
  });

  it("auto-fixes leading duplication", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[1]!, hashes[2]!], new_content: `before\nnew one\nnew two` },
    ));
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
    expect(result.autoFixes![0]!.removedLine).toBe("before");
    expect(result.content).toBe("before\nnew one\nnew two\nafter");
  });

  it("auto-fixes both leading and trailing in one edit", async () => {
    const content = "ctx1\nctx2\nold1\nold2\nctx3\nctx4";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { hash_bounds: [hashes[2]!, hashes[3]!], new_content: `ctx2\ndup\ndup\nctx3` },
    ));
    expect(result.autoFixes).toBeDefined();
    expect(result.autoFixes).toHaveLength(2);
    expect(result.content).toBe("ctx1\nctx2\ndup\ndup\nctx3\nctx4");
  });
});
