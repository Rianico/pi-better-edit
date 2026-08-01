import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { withTempFile, withTempBytes, setupIntegrationTest, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("file kind guards in tools", () => {
  it("edit decodes invalid utf-8 as replacement chars and writes them back as utf-8", async () => {
    const bytes = new Uint8Array([0xFF, 0x28, 0x0A, 0x69, 0x6E, 0x74, 0x0A]);
    await withTempBytes("bad-utf.ts", bytes, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "bad-utf.ts" }, undefined, undefined, ctx);
      expect(readResult.content[0].text).toContain("Non-UTF-8 bytes shown as U+FFFD");

      const firstText = readResult.content[0].text as string;
      const intRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│int"))!
        .split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          path: "bad-utf.ts",
          changes: [{ hash_range_inclusive: [intRef, intRef], content_lines: ["long"] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    });
  });

  it("edit rejects binary files with descriptive error", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52]);
    await withTempBytes("image.png", bytes, async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "image.png",
            changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["x"] }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/image/i);
    });
  });

  it("edit rejects directories with descriptive error", async () => {
    const { withTempSubdir } = await import("../support/fixtures");
    await withTempSubdir("mydir", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "mydir",
            changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["x"] }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/directory/i);
    });
  });

  it("edit rejects empty file deletion", async () => {
    await withTempFile("empty.txt", "a\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\n", home.testPath);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "empty.txt",
            changes: [{ hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: [] }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_WOULD_EMPTY/);
    });
  });
});
