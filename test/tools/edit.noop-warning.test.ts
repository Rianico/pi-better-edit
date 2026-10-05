import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, useTestHome } from "../support/fixtures";

useTestHome();

describe("edit tool noop + warnings", () => {
  it("returns classification noop instead of throwing on identical content", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);

      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.classification).toBe("noop");
    });
  });

  it("keeps trailing duplicate (pure edit), file has duplicate", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);

      await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BBB\nccc" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const { readFile } = await import("fs/promises");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\nccc\n");
    });
  });
});
