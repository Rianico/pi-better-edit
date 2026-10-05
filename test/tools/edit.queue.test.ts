import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { lineHashes } from "../../src/hashline";
import {
  withTempFile,
  setupIntegrationTest,
  useTestHome,
  getWritableTempRoot,
} from "../support/fixtures";

useTestHome();

describe("edit tool file mutation queue", () => {
  it("uses the same queue key for repeated edits to the same path", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);

      const r1 = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "ALPHA" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(r1.content[0].text).toContain("Successfully edited");
      expect(r1.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
      const r2 = await editTool.execute(
        "e2",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BETA" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(r2.content[0].text).toContain("Successfully edited");
      expect(r2.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    });
  });

  it.skipIf(process.platform === "win32")(
    "canonicalizes the queue key when a symlink points at the same file",
    async () => {
      await withTempFile("target.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
        const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
        const { symlink } = await import("fs/promises");
        await symlink(cwd + "/target.ts", cwd + "/link.ts");
        const hashes = await lineHashes("alpha\nbeta\ngamma\n", join(cwd, "target.ts"));
        await readTool.execute("r1", { file: "target.ts" }, undefined, undefined, ctx);

        const r1 = await editTool.execute(
          "e1",
          {
            file: "target.ts",
            edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "ALPHA" }],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(r1.content[0].text).toContain("Successfully edited");
        expect(r1.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
        const r2 = await editTool.execute(
          "e2",
          {
            file: "link.ts",
            edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BETA" }],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(r2.content[0].text).toContain("Successfully edited");
        expect(r2.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "canonicalizes the queue key when a parent directory is a symlink",
    async () => {
      const { mkdtemp, mkdir, symlink, writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const tmpDir = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-test-"));
      const subDir = join(tmpDir, "sub");
      await mkdir(subDir, { recursive: true });
      const filePath = join(subDir, "target.ts");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf-8");
      const linkDir = join(tmpDir, "linkdir");
      await mkdir(linkDir, { recursive: true });
      await symlink(subDir, join(linkDir, "sub"));

      const { ctx, readTool, editTool } = setupIntegrationTest(tmpDir);
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", join(tmpDir, "sub", "target.ts"));
      await readTool.execute("r1", { file: "sub/target.ts" }, undefined, undefined, ctx);

      const r1 = await editTool.execute(
        "e1",
        {
          file: "sub/target.ts",
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "ALPHA" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(r1.content[0].text).toContain("Successfully edited");
      expect(r1.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
      const r2 = await editTool.execute(
        "e2",
        {
          file: "linkdir/sub/target.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BETA" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(r2.content[0].text).toContain("Successfully edited");
      expect(r2.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
      const { rm } = await import("fs/promises");
      await rm(tmpDir, { recursive: true, force: true });
    },
  );
});
