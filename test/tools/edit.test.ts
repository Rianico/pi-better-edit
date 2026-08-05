import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("regReplace", () => {
  it("rejects malformed null lines during direct execute without modifying the file", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", home.testPath);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.ts",
            hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: null,
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow();
    });
  });

  it("rejects content_lines entries containing line breaks without modifying the file", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", home.testPath);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.ts",
            hash_range_inclusive: [hashes[0]!, hashes[0]!],
            content_lines: ["a\nb"],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/line break/);

      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nbbb\n");
    });
  });

  it("renders details diff while keeping diff out of LLM-visible text", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
      expect(result.details?.diff).toBeDefined();
      expect(result.details?.diff).toContain("BBB");
    });
  });

  it("autocorrects bare HASH│ prefix in content_lines with a warning", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: [`${hashes[1]!}│BBB`],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Warnings:");
      expect(result.content[0].text).toContain(`stripped "HASH│" prefix`);
      expect(result.details?.diff).toContain("BBB");
      expect(result.details?.diff).not.toContain(`${hashes[1]}│BBB`);
    });
  });

  it("autocorrects diff-preview rows in content_lines with a warning", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: [`+${hashes[1]!}│BBB`],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Warnings:");
      expect(result.content[0].text).toContain(`stripped diff-preview marker`);
      expect(result.details?.diff).toContain("BBB");
      expect(result.details?.diff).not.toContain(`+${hashes[1]}│BBB`);
    });
  });

  it("autocorrects reversed hash_range_inclusive with correct line counts", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_range_inclusive: [hashes[2]!, hashes[1]!], content_lines: ["X"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 2 line(s).");
      expect(result.content[0].text).toContain("Warnings:");
      expect(result.content[0].text).toContain("was reversed");
      expect(result.details?.diff).toContain("X");
    });
  });
});
