import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import {
  withTempFile,
  setupIntegrationTest,
  useTestHome,
} from "../support/fixtures";

const home = useTestHome();

describe("edit tool noop + warnings", () => {
  it("returns classification noop instead of throwing on identical content", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
      await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "bbb"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.classification).toBe("noop");
    });
  });

  it("keeps trailing duplicate (pure edit), file has duplicate", async () => {
    await withTempFile(
      "sample.ts",
      "aaa\nbbb\nccc\n",
      async ({ cwd, path }) => {
        const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
        const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
        await readTool.execute(
          "r1",
          { path: "sample.ts" },
          undefined,
          undefined,
          ctx,
        );

        await editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "BBB\nccc"]] },
          undefined,
          undefined,
          ctx,
        );

        const { readFile } = await import("fs/promises");
        const content = await readFile(path, "utf-8");
        expect(content).toBe("aaa\nBBB\nccc\nccc\n");
      },
    );
  });
});
