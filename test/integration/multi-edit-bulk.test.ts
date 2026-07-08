import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

describe("multi-edit bulk mode — multiple changes in one call", () => {
  it("applies two non-overlapping single-line edits atomically", async () => {
    const file = "aaa\nbbb\nccc\nddd\neee\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const line1Hash = extractHash(lines1.find((l) => l.includes("│aaa"))!);
      const line3Hash = extractHash(lines1.find((l) => l.includes("│ccc"))!);
      const line5Hash = extractHash(lines1.find((l) => l.includes("│eee"))!);

      // Edit line 1 and line 5 in one call (non-overlapping)
      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            { hash_range_inclusive: [line1Hash, line1Hash], content_lines: ["AAA"] },
            { hash_range_inclusive: [line5Hash, line5Hash], content_lines: ["EEE"] },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(result)).toContain("Successfully replaced in sample.ts");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("AAA\nbbb\nccc\nddd\nEEE\n");
    });
  });

  it("applies two non-overlapping range edits atomically", async () => {
    const file = "a\nb\nc\nd\ne\nf\ng\nh\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const line1Hash = extractHash(lines1.find((l) => l.includes("│a"))!);
      const line2Hash = extractHash(lines1.find((l) => l.includes("│b"))!);
      const line5Hash = extractHash(lines1.find((l) => l.includes("│e"))!);
      const line7Hash = extractHash(lines1.find((l) => l.includes("│g"))!);

      // Replace lines 1-2 and lines 5-7 in one call
      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            { hash_range_inclusive: [line1Hash, line2Hash], content_lines: ["A", "B"] },
            { hash_range_inclusive: [line5Hash, line7Hash], content_lines: ["E", "F", "G"] },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(result)).toContain("Successfully replaced in sample.ts");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("A\nB\nc\nd\nE\nF\nG\nh\n");
    });
  });

  it("applies a delete and a replace in one call", async () => {
    const file = "keep1\nremove\nkeep2\nchange\nkeep3\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const removeHash = extractHash(lines1.find((l) => l.includes("│remove"))!);
      const changeHash = extractHash(lines1.find((l) => l.includes("│change"))!);

      // Delete line 2, replace line 4
      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            { hash_range_inclusive: [removeHash, removeHash], content_lines: [] },
            { hash_range_inclusive: [changeHash, changeHash], content_lines: ["CHANGED"] },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(result)).toContain("Successfully replaced in sample.ts");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("keep1\nkeep2\nCHANGED\nkeep3\n");
    });
  });

  it("rejects overlapping edits with [E_EDIT_CONFLICT]", async () => {
    const file = "a\nb\nc\nd\n";
    await withTempFile("sample.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const line1Hash = extractHash(lines1.find((l) => l.includes("│a"))!);
      const line2Hash = extractHash(lines1.find((l) => l.includes("│b"))!);
      const line3Hash = extractHash(lines1.find((l) => l.includes("│c"))!);

      // Two edits that overlap on line 2
      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.ts",
            changes: [
              { hash_range_inclusive: [line1Hash, line2Hash], content_lines: ["A", "B"] },
              { hash_range_inclusive: [line2Hash, line3Hash], content_lines: ["B", "C"] },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_EDIT_CONFLICT/);
    });
  });

  it("reports noop for individual edits that match current content", async () => {
    const file = "aaa\nbbb\nccc\n";
    await withTempFile("sample.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const line1Hash = extractHash(lines1.find((l) => l.includes("│aaa"))!);
      const line2Hash = extractHash(lines1.find((l) => l.includes("│bbb"))!);

      // Edit 0 is a noop (same content), edit 1 is a real change
      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            { hash_range_inclusive: [line1Hash, line1Hash], content_lines: ["aaa"] },
            { hash_range_inclusive: [line2Hash, line2Hash], content_lines: ["BBB"] },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(result)).toContain("Successfully replaced in sample.ts");
      expect(result.details.metrics.edits_attempted).toBe(2);
      expect(result.details.metrics.edits_noop).toBe(1);
    });
  });

  it("classifies as noop when all edits are noop", async () => {
    const file = "aaa\nbbb\n";
    await withTempFile("sample.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const line1Hash = extractHash(lines1.find((l) => l.includes("│aaa"))!);
      const line2Hash = extractHash(lines1.find((l) => l.includes("│bbb"))!);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            { hash_range_inclusive: [line1Hash, line1Hash], content_lines: ["aaa"] },
            { hash_range_inclusive: [line2Hash, line2Hash], content_lines: ["bbb"] },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(result)).toContain("No changes made to sample.ts");
      expect(result.details.classification).toBe("noop");
    });
  });

  it("preserves unchanged line hashes after a multi-edit", async () => {
    const file = "alpha\nbeta\ngamma\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const alphaHash = extractHash(lines1.find((l) => l.includes("│alpha"))!);
      const gammaHash = extractHash(lines1.find((l) => l.includes("│gamma"))!);

      // Edit alpha and gamma, leave beta unchanged
      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            { hash_range_inclusive: [alphaHash, alphaHash], content_lines: ["ALPHA"] },
            { hash_range_inclusive: [gammaHash, gammaHash], content_lines: ["GAMMA"] },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      // Read again — beta's hash should be the same
      const read2 = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");

      const betaLine2 = lines2.find((l) => l.includes("│beta"))!;
      expect(betaLine2).toBeTruthy();
      const betaHash2 = extractHash(betaLine2);

      // The original beta hash should still match
      const betaLine1 = lines1.find((l) => l.includes("│beta"))!;
      const betaHash1 = extractHash(betaLine1);
      expect(betaHash2).toBe(betaHash1);
    });
  });
});
