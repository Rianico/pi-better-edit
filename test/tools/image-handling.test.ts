import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import { loadHashStore } from "../../src/hash-store";
import { resolveTarget } from "../../src/fs-write";
import { loadLeases } from "../../src/served-session";
import {
  TEST_SESSION_ID,
  anchorRows,
  getText,
  setupIntegrationTest,
  withTempFile,
} from "../support/fixtures";

const minimalPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

interface TextBlock {
  type: "text";
  text: string;
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

function isTextBlock(block: unknown): block is TextBlock {
  if (typeof block !== "object" || block === null) return false;
  return (block as Record<string, unknown>).type === "text";
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
      const result = await readTool.execute(
        "r1",
        { files: [{ file: "test.png" }] },
        undefined,
        undefined,
        ctx,
      );

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
      const result = await readTool.execute(
        "r1",
        { files: [{ file: fileName }] },
        undefined,
        undefined,
        ctx,
      );

      const images = imageBlocksOf(result);
      expect(images).toHaveLength(1);
      const [image] = images;
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data.length).toBeGreaterThan(0);
    });
  });

  it("aggregates image blocks in request order with the text target untouched", async () => {
    await withTempFile("hello.txt", "hello\n", async ({ cwd }) => {
      const pngPath = join(cwd, "pic.png");
      await writeFile(pngPath, minimalPng);

      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { files: [{ file: "hello.txt" }, { file: "pic.png" }] },
        undefined,
        undefined,
        ctx,
      );

      // WHY: request order — the text section first, then the builtin's note plus image block.
      const [first] = result.content;
      expect(isTextBlock(first)).toBe(true);
      expect(getText(result)).toContain("[hello.txt (1 lines total)]");
      expect(getText(result)).toMatch(/[A-Za-z0-9]{4}│hello/);
      const images = imageBlocksOf(result);
      expect(images).toHaveLength(1);
      const [image] = images;
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data.length).toBeGreaterThan(0);
      expect(result.content.at(-1)).toBe(image);
      // WHY: zero anchors for the image target — its note carries no served rows.
      for (const block of result.content) {
        if (block === first || !isTextBlock(block)) continue;
        expect(anchorRows(block.text)).toEqual([]);
      }
      // WHY: no snapshot id and no lease for the image target — it never entered served state.
      // WHY: the text sibling keeps its own snapshot id; the assertion pins that it names the text
      // WHY: file, never the image.
      const details: { snapshotId?: string } = result.details ?? {};
      expect(details.snapshotId ?? "").not.toContain("pic.png");
      const store = await loadHashStore();
      expect(loadLeases(store, TEST_SESSION_ID, await resolveTarget(pngPath))).toEqual([]);

      // WHY: request order the other way — the image blocks lead and the text section trails.
      const reversed = await readTool.execute(
        "r2",
        { files: [{ file: "pic.png" }, { file: "hello.txt" }] },
        undefined,
        undefined,
        ctx,
      );
      const [lead] = reversed.content;
      expect(isTextBlock(lead) && lead.text).toContain("Read image file [image/png]");
      expect(imageBlocksOf(reversed)).toHaveLength(1);
      expect(getText(reversed)).not.toContain("[hello.txt (1 lines total)]");
      const trailing = reversed.content.at(-1);
      expect(isTextBlock(trailing) && trailing.text).toContain("[hello.txt (1 lines total)]");
    });
  });
});
