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

describe("edit tool noop + warnings", () => {
  it("returns classification noop instead of throwing on identical content", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["bbb"] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.classification).toBe("noop");
    });
  });

  it("warns on trailing duplicate line that matches the next surviving line", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB", "ccc"] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Warnings:");
    });
  });
});
