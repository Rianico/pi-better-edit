import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, setupTestHome } from "../support/fixtures";

let testPath: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const s = await setupTestHome();
  testPath = s.testPath;
  cleanup = s.cleanup;
});

afterAll(async () => {
  await cleanup();
});

describe("regReplace", () => {
  it("rejects malformed null lines during direct execute without modifying the file", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", testPath);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.ts",
            changes: [{ hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: null }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow();
    });
  });

  it("renders details diff while keeping diff out of LLM-visible text", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }],
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
});
