import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, useTestHome } from "../support/fixtures";

useTestHome();

describe("stale-position compound edits", () => {
  it("rejects stale anchors after an edit", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute(
        "r1",
        { file: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const firstText = firstRead.content[0].text as string;
      const line5Hash = firstText
        .split("\n")
        .find((line: string) => line.includes("│e"))!
        .split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        { file: "sample.ts", edits: [{ anchor_from: line5Hash, anchor_to: line5Hash, text: "E" }] },
        undefined,
        undefined,
        ctx,
      );

      // The pre-edit anchor for line 5 no longer resolves: its line identity was retired.
      await expect(
        editTool.execute(
          "e2",
          {
            file: "sample.ts",
            edits: [{ anchor_from: line5Hash, anchor_to: line5Hash, text: "E-STALE" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_TARGET_LOST/);

      // Re-pointed for I4 (spec §5): the model-visible anchored diff carries the fresh anchor for
      // the modified row, so a follow-up edit chains with no intermediate read.
      const freshHash = (result.content[0].text as string)
        .split("\n")
        .find((line: string) => line.startsWith("+") && line.includes("│E"))!
        .slice(1)
        .split("│")[0]!;
      const chained = await editTool.execute(
        "e3",
        {
          file: "sample.ts",
          edits: [{ anchor_from: freshHash, anchor_to: freshHash, text: "E-AGAIN" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(chained.content[0].text).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\nE-AGAIN\nf\ng\n");
    });
  });

  it("tracks correct final coordinates for a range edit", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute(
        "r1",
        { file: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const firstText = firstRead.content[0].text as string;
      const lines = firstText.split("\n");
      const line2Hash = lines.find((l: string) => l.includes("│b"))!.split("│")[0]!;
      const line4Hash = lines.find((l: string) => l.includes("│d"))!.split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: line2Hash, anchor_to: line4Hash, text: "B\nC_D" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully edited");
      expect(result.content[0].text).toContain("Added 2 line(s), removed 3 line(s).");
    });
  });

  it("tracks correct coordinates when the edit shrinks lines", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute(
        "r1",
        { file: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const firstText = firstRead.content[0].text as string;
      const lines = firstText.split("\n");
      const line2Hash = lines.find((l: string) => l.includes("│b"))!.split("│")[0]!;
      const line4Hash = lines.find((l: string) => l.includes("│d"))!.split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: line2Hash, anchor_to: line4Hash, text: "B\nC_D" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully edited");
      expect(result.content[0].text).toContain("Added 2 line(s), removed 3 line(s).");
    });
  });
});
