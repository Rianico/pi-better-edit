import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes, applyEdits, type HEdit } from "../../src/hashline";
import { setupTestHome, withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

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

describe("stable hashing with duplicate content lines", () => {
  it("removing the first of two identical lines preserves the second line's hash", async () => {
    // Two identical closing braces at different positions.
    // Perfect hashing gives them different hashes.
    const content = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    const hashes = await lineHashes(content, testPath);

    // The two `}` lines are at indices 2 and 6 (0-based)
    const firstBraceHash = hashes[2]!;
    const secondBraceHash = hashes[6]!;
    expect(firstBraceHash).not.toBe(secondBraceHash);

    // Remove the first function (lines 1-3), leaving the second `}` in place.
    // The hash_range_inclusive tells us the first brace was targeted.
    const edits: HEdit[] = [
      {
        hash_range_inclusive: [{ hash: hashes[0]! }, { hash: firstBraceHash }],
        content_lines: [],
      },
    ];

    const result = applyEdits(content, edits, undefined, hashes, testPath);
    const newContent = result.content;
    expect(newContent).toBe("\nfunction b() {\n  return 2;\n}\n");

    // Compute stable hashes using the hash-aware algorithm.
    // Pass removedHashes so the algorithm knows the first brace was targeted.
    const resultHashes = await lineHashes(newContent, testPath, {
      content,
      hashes,
      removedHashes: new Set([hashes[0]!, firstBraceHash]),
    });

    // The surviving `}` is at result index 3 (0-based): lines are
    // ["", "function b() {", "  return 2;", "}"]
    // It should have the SECOND brace's hash (the one NOT targeted).
    expect(resultHashes[3]).toBe(secondBraceHash);
  });

  it("removing the second of two identical lines preserves the first line's hash", async () => {
    const content = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    const hashes = await lineHashes(content, testPath);

    const firstBraceHash = hashes[2]!;
    const secondBraceHash = hashes[6]!;

    // Remove the second function (lines 5-7), leaving the first `}` in place.
    // The hash_range_inclusive tells us the second brace was targeted.
    const edits: HEdit[] = [
      {
        hash_range_inclusive: [{ hash: hashes[4]! }, { hash: secondBraceHash }],
        content_lines: [],
      },
    ];

    const result = applyEdits(content, edits, undefined, hashes, testPath);
    const newContent = result.content;
    expect(newContent).toBe("function a() {\n  return 1;\n}\n\n");

    const resultHashes = await lineHashes(newContent, testPath, {
      content,
      hashes,
      removedHashes: new Set([hashes[4]!, secondBraceHash]),
    });

    // The surviving `}` (originally at index 2) is at result index 2
    // It should have the FIRST brace's hash (the one NOT targeted).
    expect(resultHashes[2]).toBe(firstBraceHash);
  });

  it("removing a unique line between two identical lines preserves both brace hashes", async () => {
    // Three identical `}` lines with unique content between them
    const content = "a\n}\nb\n}\nc\n}\nd\n";
    const hashes = await lineHashes(content, testPath);

    const brace1 = hashes[1]!;
    const brace2 = hashes[3]!;
    const brace3 = hashes[5]!;
    expect(new Set([brace1, brace2, brace3]).size).toBe(3);

    // Remove line 3 ("b") — the braces on either side are unchanged
    const edits: HEdit[] = [
      {
        hash_range_inclusive: [{ hash: hashes[2]! }, { hash: hashes[2]! }],
        content_lines: [],
      },
    ];

    const result = applyEdits(content, edits, undefined, hashes, testPath);
    const newContent = result.content;
    expect(newContent).toBe("a\n}\n}\nc\n}\nd\n");

    const resultHashes = await lineHashes(newContent, testPath, {
      content,
      hashes,
      removedHashes: new Set([hashes[2]!]),
    });

    // Each brace should have kept its original hash because the hash-aware
    // algorithm can disambiguate them by the removedHashes set.
    expect(resultHashes[1]).toBe(brace1);
    expect(resultHashes[2]).toBe(brace2);
    expect(resultHashes[4]).toBe(brace3);
  });

  it("end-to-end via tool: removing one of two identical lines preserves the correct hash", async () => {
    const file = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      // Read to get hashes
      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const firstBraceHash = extractHash(lines1.find((l) => l.includes("│}"))!);
      // Find the second `}` line (there are two)
      const braceLines = lines1.filter((l) => l.endsWith("│}"));
      expect(braceLines).toHaveLength(2);
      const secondBraceHash = extractHash(braceLines[1]!);
      expect(firstBraceHash).not.toBe(secondBraceHash);

      // Remove the first function (lines 1-3) using the first brace's hash
      const line1Hash = extractHash(lines1.find((l) => l.includes("│function a()"))!);
      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [line1Hash, firstBraceHash], content_lines: [] }],
        },
        undefined,
        undefined,
        ctx,
      );

      // Read again — the surviving `}` should have the second brace's hash
      const read2 = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const survivingBrace = lines2.find((l) => l.endsWith("│}"))!;
      expect(survivingBrace).toBeTruthy();
      const survivingHash = extractHash(survivingBrace);
      expect(survivingHash).toBe(secondBraceHash);
    });
  });

  it("end-to-end via tool: interior duplicate line (not a boundary) keeps its hash", async () => {
    // File with duplicate `b` lines. The first `b` is an INTERIOR line of the
    // edit range (not a boundary). With boundary-only removedHashes, the
    // interior `b`'s hash would NOT be marked as removed, causing the
    // surviving `b` to be matched to the wrong occurrence.
    const file = "a\nb\nc\nb\nd\n";
    await withTempFile("sample.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      // Read to get hashes
      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      // Find the two `b` lines
      const bLines = lines1.filter((l) => l.endsWith("│b"));
      expect(bLines).toHaveLength(2);
      const firstBHash = extractHash(bLines[0]!);
      const secondBHash = extractHash(bLines[1]!);
      expect(firstBHash).not.toBe(secondBHash);

      // Find the `a` and `c` lines (boundaries of the edit range)
      const aHash = extractHash(lines1.find((l) => l.endsWith("│a"))!);
      const cHash = extractHash(lines1.find((l) => l.endsWith("│c"))!);

      // Remove lines 0-2 (a, b, c). The first `b` is an interior line.
      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [aHash, cHash], content_lines: [] }],
        },
        undefined,
        undefined,
        ctx,
      );

      // Read again — the surviving `b` should have the SECOND b's hash
      const read2 = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const survivingB = lines2.find((l) => l.endsWith("│b"))!;
      expect(survivingB).toBeTruthy();
      const survivingHash = extractHash(survivingB);
      expect(survivingHash).toBe(secondBHash);
    });
  });

  it("end-to-end via tool: multi-edit bulk with interior duplicates preserves all surviving hashes", async () => {
    // File with three identical `b` lines. Two edits in one call remove
    // ranges that include the first `b` (as interior) and a unique region.
    // The surviving `b` lines (second and third) must keep their original hashes.
    const file = "a\nb\nc\nb\nd\ne\nb\nf\n";
    await withTempFile("sample.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      // Read to get hashes
      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      // Find the three `b` lines
      const bLines = lines1.filter((l) => l.endsWith("│b"));
      expect(bLines).toHaveLength(3);
      const firstBHash = extractHash(bLines[0]!);
      const secondBHash = extractHash(bLines[1]!);
      const thirdBHash = extractHash(bLines[2]!);
      expect(new Set([firstBHash, secondBHash, thirdBHash]).size).toBe(3);

      // Find boundary hashes for the two edits
      const aHash = extractHash(lines1.find((l) => l.endsWith("│a"))!);
      const cHash = extractHash(lines1.find((l) => l.endsWith("│c"))!);
      const dHash = extractHash(lines1.find((l) => l.endsWith("│d"))!);
      const eHash = extractHash(lines1.find((l) => l.endsWith("│e"))!);

      // Two edits in one call:
      // 1. Remove lines 0-2 (a, b, c) — first `b` is an interior line
      // 2. Remove lines 4-5 (d, e) — no duplicates
      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            { hash_range_inclusive: [aHash, cHash], content_lines: [] },
            { hash_range_inclusive: [dHash, eHash], content_lines: [] },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      // Read again — the surviving `b` lines should have the second and third b's hashes
      const read2 = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const survivingBLines = lines2.filter((l) => l.endsWith("│b"));
      expect(survivingBLines).toHaveLength(2);
      const survivingHashes = survivingBLines.map(extractHash);
      expect(survivingHashes).toContain(secondBHash);
      expect(survivingHashes).toContain(thirdBHash);
    });
  });
});
