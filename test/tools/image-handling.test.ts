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
      expect(Object.keys(image ?? {}).sort()).toEqual(["data", "mimeType", "type"]);
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
      const text = getText(
        await readTool.execute("r1", { file: "hello.txt" }, undefined, undefined, ctx),
      );
      expect(text).toContain("[hello.txt (1 lines total)]");
      expect(text).toMatch(/[A-Za-z0-9]{4}│hello/);
      const image = await readTool.execute("r2", { file: "pic.png" }, undefined, undefined, ctx);
      expect(imageBlocksOf(image)).toHaveLength(1);
    });
  });

  it("declares the codemode output contract: text, or an image block with its note", () => {
    const { readTool } = setupIntegrationTest(process.cwd());
    const branches = readTool.outputSchema.anyOf;
    expect(branches).toHaveLength(2);
    expect(branches).toContainEqual({ type: "string" });
    const image = branches.find((branch: { type: string }) => branch.type === "object");
    expect(image?.properties).toEqual({
      type: { type: "string", const: "image" },
      data: { type: "string" },
      mimeType: { type: "string" },
      note: { type: "string" },
    });
    expect([...image.required].sort()).toEqual(["data", "mimeType", "note", "type"]);
  });

  it("hands a programmatic caller the image block with the model's text as its note", async () => {
    await withTempFile("test.png", "", async ({ cwd }) => {
      await writeFile(join(cwd, "test.png"), minimalPng);

      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute("r1", { file: "test.png" }, undefined, undefined, ctx);

      const [image] = imageBlocksOf(result);
      expect(getText(result).length).toBeGreaterThan(0);
      expect(result.structuredContent).toEqual({
        type: "image",
        data: image?.data,
        mimeType: "image/png",
        note: getText(result),
      });
    });
  });

  it("hands a programmatic caller the text the model sees for a text read", async () => {
    await withTempFile("hello.txt", "hello\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      for (const mode of ["served", "verbatim"]) {
        const result = await readTool.execute(
          "r1",
          { file: "hello.txt", mode },
          undefined,
          undefined,
          ctx,
        );
        expect(result.structuredContent).toBe(getText(result));
        expect(result.structuredContent).toContain("hello");
      }
    });
  });
});
