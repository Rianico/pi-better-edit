import { describe, expect, it } from "vitest";
import { withTempFile, setupIntegrationTest } from "../support/fixtures";

describe("chained edit anchors", () => {
  it("returns updated anchors in edit result for a single-line replace", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      const editResult = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [{ old_range: [betaRef, betaRef], new_lines: ["BETA"] }] },
        undefined,
        undefined,
        ctx,
      );

      // With contextLines=0, no anchor block is shown
      // The LLM would need to call read for fresh anchors
      expect(editResult.content[0].text).toBe("");

      // For chained edits, the LLM must call read first to get fresh anchors
      const secondRead = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const freshRef = secondRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│BETA"))!
        .split("│")[0]!;

      // Second edit using the fresh anchor from read
      const editResult2 = await editTool.execute(
        "e2",
        { path: "sample.ts", edits: [{ old_range: [freshRef, freshRef], new_lines: ["BETA-CHAINED"] }] },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult2.content[0].text).toBe("");
    });
  });

  it("omits anchors when post-edit affected span is too large", async () => {
    // Replace 15 lines with 15 new lines: span=15, +4 context = 19 > 12 budget.
    const fifteenLines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
    await withTempFile("big.ts", fifteenLines, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "big.ts" }, undefined, undefined, ctx);
      const line1Ref = firstRead.content[0].text
        .split("\n")
	        .find((line: string) => line.includes("│line 1"))!
	        .split("│")[0]!;
      const line15Ref = firstRead.content[0].text
        .split("\n")
	        .find((line: string) => line.includes("│line 15"))!
	        .split("│")[0]!;

      // Replace lines 1-15 with 15 new lines.
      const newLines = Array.from({ length: 15 }, (_, i) => `NEW ${i + 1}`);
      const editResult = await editTool.execute(
        "e1",
        {
          path: "big.ts",
          edits: [{ old_range: [line1Ref, line15Ref], new_lines: newLines }],
        },
        undefined,
        undefined,
        ctx,
      );

      // Post-edit: nothing is shown with contextLines=0
      expect(editResult.content[0].text).toBe("");
    });
  });
  it("omits anchors when single-line replace expands beyond budget", async () => {
    // Replace 1 line with 11 new lines: span=11, +4 context = 15 > 12 budget.
    await withTempFile("expand.ts", "before\ntarget\nafter\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "expand.ts" }, undefined, undefined, ctx);
      const targetRef = firstRead.content[0].text
        .split("\n")
	        .find((line: string) => line.includes("│target"))!
	        .split("│")[0]!;

      const newLines = Array.from({ length: 11 }, (_, i) => `EXPANDED ${i + 1}`);
      const editResult = await editTool.execute(
        "e1",
        { path: "expand.ts", edits: [{ old_range: [targetRef, targetRef], new_lines: newLines }] },
        undefined,
        undefined,
        ctx,
      );

    // 11 new lines span 2-12, no context = 11 ≤ 12 → but with contextLines=0, no anchor block.
      expect(editResult.content[0].text).toBe("");
    });
  });

  it("unchanged line anchors from original read remain valid after chained edits", async () => {
    await withTempFile("stale.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "stale.ts" }, undefined, undefined, ctx);
      const betaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;
      const alphaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│alpha"))!
        .split("│")[0]!;

      // First edit changes beta.
      await editTool.execute(
        "e1",
        { path: "stale.ts", edits: [{ old_range: [betaRef, betaRef], new_lines: ["BETA"] }] },
        undefined,
        undefined,
        ctx,
      );

      // The stale betaRef should now fail (line 2 hash changed).
      await expect(
        editTool.execute(
          "e2-stale",
          { path: "stale.ts", edits: [{ old_range: [betaRef, betaRef], new_lines: ["BETA-AGAIN"] }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/stale anchor/);

      // But alphaRef (unchanged line) should still work.
      const alphaEdit = await editTool.execute(
        "e3",
        { path: "stale.ts", edits: [{ old_range: [alphaRef, alphaRef], new_lines: ["ALPHA"] }] },
        undefined,
        undefined,
        ctx,
      );
      expect(alphaEdit.content[0].text).toBe("");
    });
  });
});
