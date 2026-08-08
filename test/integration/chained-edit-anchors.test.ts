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
        { path: "sample.ts", hash_bounds: [betaRef, betaRef], new_content: "BETA" },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully replaced in sample.ts");
      expect(editResult.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
      const secondRead = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const freshRef = secondRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│BETA"))!
        .split("│")[0]!;

      const editResult2 = await editTool.execute(
        "e2",
        { path: "sample.ts", hash_bounds: [freshRef, freshRef], new_content: "BETA-CHAINED" },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult2.content[0].text).toContain("Successfully replaced in sample.ts");
      expect(editResult2.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    });
  });

  it("omits anchors when post-edit affected span is too large", async () => {

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

      const newLines = Array.from({ length: 15 }, (_, i) => `NEW ${i + 1}`);
      const editResult = await editTool.execute(
        "e1",
        {
          path: "big.ts",
          hash_bounds: [line1Ref, line15Ref], new_content: newLines.join("\n"),
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully replaced in big.ts");
    });
  });
  it("omits anchors when single-line replace expands beyond budget", async () => {

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
        { path: "expand.ts", hash_bounds: [targetRef, targetRef], new_content: newLines.join("\n") },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully replaced in expand.ts");
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

      await editTool.execute(
        "e1",
        { path: "stale.ts", hash_bounds: [betaRef, betaRef], new_content: "BETA" },
        undefined,
        undefined,
        ctx,
      );
      await expect(
        editTool.execute(
          "e2-stale",
          { path: "stale.ts", hash_bounds: [betaRef, betaRef], new_content: "BETA-AGAIN" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/stale anchor/);

      const alphaEdit = await editTool.execute(
        "e3",
        { path: "stale.ts", hash_bounds: [alphaRef, alphaRef], new_content: "ALPHA" },
        undefined,
        undefined,
        ctx,
      );
      expect(alphaEdit.content[0].text).toContain("Successfully replaced in stale.ts");
    });
  });

  it("keeps untouched-line anchors valid after a reversed-range replace", async () => {
    await withTempFile("stable.ts", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "stable.ts" }, undefined, undefined, ctx);
      const alphaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│alpha"))!
        .split("│")[0]!;
      const betaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;
      const gammaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│gamma"))!
        .split("│")[0]!;

      const editResult = await editTool.execute(
        "e1",
        { path: "stable.ts", hash_bounds: [gammaRef, betaRef], new_content: "X" },
        undefined,
        undefined,
        ctx,
      );
      expect(editResult.content[0].text).toContain("Successfully replaced in stable.ts");
      expect(editResult.content[0].text).toContain("Warnings:");

      const alphaEdit = await editTool.execute(
        "e2",
        { path: "stable.ts", hash_bounds: [alphaRef, alphaRef], new_content: "ALPHA" },
        undefined,
        undefined,
        ctx,
      );
      expect(alphaEdit.content[0].text).toContain("Successfully replaced in stable.ts");
    });
  });
});
