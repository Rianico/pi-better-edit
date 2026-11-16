import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { lineHashes } from "../../src/hashline/hash-identity.js";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

describe("disjoint batch drift gap", () => {
  it("interval-aware drift surfaces gap drift and no longer warns (C4)", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const firstRead = await readTool.execute(
        "r1",
        { file: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const bRef = extractHash(text.split("\n").find((l) => l.includes("│b"))!);
      const hRef = extractHash(text.split("\n").find((l) => l.includes("│h"))!);
      await writeFile(path, "a\nb\nc\nd\nE\nf\ng\nh\ni\nJ\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [
            { anchor_from: bRef, anchor_to: bRef, text: "B" },
            { anchor_from: hRef, anchor_to: hRef, text: "H" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      const resultText = getText(result);
      expect((result as any).details?.warnings?.join("\n") ?? "").not.toContain("Batch drift note");
      expect(resultText).not.toContain("Batch drift note");
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\nd\nE\nf\ng\nH\ni\nJ\n");
      const gapDrift = (result as any).details?.driftNotice ?? "";
      expect(gapDrift).toContain("│E");
      const _hashes = await lineHashes("a\nB\nc\nd\nE\nf\ng\nH\ni\nJ\n", path);
      expect(resultText).toContain("Successfully edited");
    });
  });

  it("single-edit drift still reports outside correctly", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const firstRead = await readTool.execute(
        "r1",
        { file: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const bRef = extractHash(
        getText(firstRead)
          .split("\n")
          .find((l) => l.includes("│b"))!,
      );
      await writeFile(path, "a\nb\nc\nd\nE\n", "utf-8");
      const result = await editTool.execute(
        "e1",
        { file: "sample.ts", edits: [{ anchor_from: bRef, anchor_to: bRef, text: "B" }] },
        undefined,
        undefined,
        ctx,
      );
      const resultText = getText(result);
      const driftNotice = (result as any).details?.driftNotice ?? "";
      expect(driftNotice).toContain("drift:");
      expect(driftNotice).toContain("│E");
      expect(resultText).not.toContain("drift:");
    });
  });
});
