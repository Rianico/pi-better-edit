import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";
import { resolveMissingPath } from "../../src/edit";
import {
  withTempFile,
  withTempDir,
  setupIntegrationTest,
} from "../support/fixtures";

describe("edit — legacy file inference (resolveMissingPath)", () => {
  it("resolves a missing file when the anchors uniquely identify a file", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", path);
      await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      const resolution = await resolveMissingPath({
        anchor_from: hashes[0]!,
        anchor_to: hashes[0]!,
      });

      expect(resolution?.file.endsWith("sample.ts")).toBe(true);
      expect(resolution?.warning).toContain('missing "file" resolved to');
    });
  });

  it("rejects a missing file when the anchors match multiple files", async () => {
    await withTempDir("ambig-", async (dir) => {
      setupIntegrationTest(dir);
      const first = join(dir, "a.txt");
      const second = join(dir, "b.txt");
      await writeFile(first, "same\n", "utf-8");
      await writeFile(second, "same\n", "utf-8");
      const hashes = await lineHashes("same\n", first);
      await lineHashes("same\n", second);

      await expect(
        resolveMissingPath({
          anchor_from: hashes[0]!,
          anchor_to: hashes[0]!,
        }),
      ).rejects.toThrow(/match multiple known files/);
    });
  });

  it("returns undefined when the anchors match no file", async () => {
    await withTempFile("sample.ts", "aaa\n", async ({ cwd }) => {
      setupIntegrationTest(cwd);

      const resolution = await resolveMissingPath({
        anchor_from: "AAA",
        anchor_to: "AAA",
      });
      expect(resolution).toBeUndefined();
    });
  });

  it("requires file on the tool surface", async () => {
    await withTempFile(
      "sample.ts",
      "aaa\nbbb\nccc\n",
      async ({ cwd, path }) => {
        const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
        const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
        await readTool.execute(
          "r1",
          { path: "sample.ts" },
          undefined,
          undefined,
          ctx,
        );

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
      },
    );
  });
});
