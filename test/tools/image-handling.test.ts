import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures";

const minimalPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

function isImageBlock(block: unknown): block is ImageBlock {
  if (typeof block !== "object" || block === null) return false;
  const record = block as Record<string, unknown>;
  return (
    record.type === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string"
  );
}

function imageBlocksOf(result: { content: unknown[] }): ImageBlock[] {
  return result.content.filter(isImageBlock);
}

describe("read tool image delegation", () => {
  it("delegates a single PNG read to the builtin and returns its image block", async () => {
    await withTempFile("test.png", "", async ({ cwd }) => {
      const path = join(cwd, "test.png");
      await writeFile(path, minimalPng);

      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute("r1", { file: "test.png" }, undefined, undefined, ctx);

      const images = imageBlocksOf(result);
      expect(images).toHaveLength(1);
      const [image] = images;
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data.length).toBeGreaterThan(0);
      // WHY: the image block is the builtin's own shape — exactly these keys, nothing served.
      expect(Object.keys(image ?? {}).sort()).toEqual(["data", "mimeType", "type"]);
      // WHY: interception on `prepared.kind === "image"` keeps image bytes out of the served
      // WHY: path — a lone image read owes no snapshot id.
      expect(JSON.stringify(result.details ?? {})).not.toContain("snapshotId");
    });
  });

  it("delegates an image read even when the filename contains spaces", async () => {
    await withTempFile("test.png", "", async ({ cwd }) => {
      const fileName = "Screenshot 2026-06-22 at 15.02.44.png";
      await writeFile(join(cwd, fileName), minimalPng);

      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute("r1", { file: fileName }, undefined, undefined, ctx);

      const images = imageBlocksOf(result);
      expect(images).toHaveLength(1);
      const [image] = images;
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data.length).toBeGreaterThan(0);
    });
  });

  it("leaves the text target untouched around image delegation", async () => {
    await withTempFile("hello.txt", "hello\n", async ({ cwd }) => {
      const pngPath = join(cwd, "pic.png");
      await writeFile(pngPath, minimalPng);

      const { ctx, readTool } = setupIntegrationTest(cwd);
      // WHY: one file per call — the image delegates to the builtin and the text reads alone;
      // WHY: the text section keeps its own header and rows either way.
      const text = getText(
        await readTool.execute("r1", { file: "hello.txt" }, undefined, undefined, ctx),
      );
      expect(text).toContain("[hello.txt (1 lines total)]");
      expect(text).toMatch(/[A-Za-z0-9]{4}│hello/);
      const image = await readTool.execute("r2", { file: "pic.png" }, undefined, undefined, ctx);
      expect(imageBlocksOf(image)).toHaveLength(1);
    });
  });
});
