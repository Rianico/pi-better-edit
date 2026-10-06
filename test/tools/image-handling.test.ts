import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { makeFakePiRegistry, withTempFile, testSessionManager } from "../support/fixtures";

const minimalPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("read tool image rejection", () => {
  it("rejects a PNG read with E_UNSUPPORTED_FILE (plain text only)", async () => {
    await withTempFile("test.png", "", async ({ cwd }) => {
      const path = join(cwd, "test.png");
      await writeFile(path, minimalPng);

      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      await expect(
        readTool.execute("r1", { file: "test.png" }, undefined, undefined, {
          cwd,
          sessionManager: testSessionManager,
        } as any),
      ).rejects.toThrow(/Path is an image file/);
    });
  });

  it("rejects an image read even when the filename contains spaces", async () => {
    await withTempFile("test.png", "", async ({ cwd }) => {
      const fileName = "Screenshot 2026-06-22 at 15.02.44.png";
      const path = join(cwd, fileName);
      await writeFile(path, minimalPng);

      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      await expect(
        readTool.execute("r1", { file: fileName }, undefined, undefined, {
          cwd,
          sessionManager: testSessionManager,
        } as any),
      ).rejects.toThrow(/Path is an image file/);
    });
  });
});
