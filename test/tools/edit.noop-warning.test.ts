import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("edit tool noop + warnings", () => {
  it("returns classification noop instead of throwing on identical content", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_bounds: [hashes[1]!, hashes[1]!], new_content: "bbb",
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.classification).toBe("noop");
    });
  });

  it("auto-fixes trailing duplicate silently, file is correct", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_bounds: [hashes[1]!, hashes[1]!], new_content: "BBB\nccc",
        },
        undefined,
        undefined,
        ctx,
      );

      const { readFile } = await import("fs/promises");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });
});
