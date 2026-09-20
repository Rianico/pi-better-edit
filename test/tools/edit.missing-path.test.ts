import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { createEditTool } from "../../src/edit-tool.js";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures";

describe("edit — missing file fails closed", () => {
  it("rejects a null file with E_BAD_PAYLOAD and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);

      const tool = createEditTool();
      const error = await tool
        .execute(
          {
            file: null,
            edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "BBB" }],
          },
          undefined,
          ctx,
        )
        .then(
          () => {
            throw new Error("expected rejection");
          },
          (entry) => entry as Error,
        );
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain('"file"');
      expect(String(error.message)).toContain("nothing was written");
      expect(String(error.message)).not.toContain("resolved to");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("rejects a preview with a null file carrying E_BAD_PAYLOAD", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", path);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);

      const tool = createEditTool();
      const result = await tool.preview(
        {
          file: null,
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "AAA" }],
        },
        cwd,
      );
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("[E_BAD_PAYLOAD]");
        expect(result.error).toContain('"file"');
      }
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("requires file on the tool surface", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);

      await expect(
        editTool.execute(
          "e1",
          {
            edits: [
              {
                anchor_from: hashes[1]!,
                anchor_to: hashes[1]!,
                replace_with: "BBB",
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_BAD_PAYLOAD/);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("a successful edit carries no inference marker", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);

      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "BBB" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).not.toContain("resolved to");
      expect(text).not.toContain("[E_BAD_PAYLOAD]");
      expect(JSON.stringify(result.details)).not.toContain("resolved to");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });
});
