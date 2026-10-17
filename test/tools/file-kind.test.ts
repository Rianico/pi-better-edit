import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { lineHashes } from "../../src/hashline";
import {
  withTempFile,
  withTempBytes,
  setupIntegrationTest,
  useTestHome,
} from "../support/fixtures";

useTestHome();

describe("file kind guards in tools", () => {
  // REMEDIATION P2-3 reverses this file's old witness: a lossy edit that re-encoded U+FFFD over
  // the original bytes was the defect. The read path keeps disclosing such files; the edit path
  // now refuses before any mutation.
  it("edit discloses invalid utf-8 on read but refuses to edit it (bytes do not round-trip)", async () => {
    const bytes = new Uint8Array([0xff, 0x28, 0x0a, 0x69, 0x6e, 0x74, 0x0a]);
    await withTempBytes("bad-utf.ts", bytes, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute(
        "r1",
        { file: "bad-utf.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(readResult.content[0].text).toContain("Non-UTF-8 bytes shown as U+FFFD");

      const firstText = readResult.content[0].text as string;
      const intRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│int"))!
        .split("│")[0]!;

      await expect(
        editTool.execute(
          "e1",
          { file: "bad-utf.ts", edits: [{ anchor_from: intRef, anchor_to: intRef, text: "long" }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_LOSSY_TEXT/);
      const rawAfter = await readFile(path);
      expect(rawAfter.equals(Buffer.from(bytes))).toBe(true);
    });
  });

  it("discloses non-printable control characters verbatim instead of escaping them (I2)", async () => {
    const bytes = Buffer.from("alpha\n\u0007beta\u001b\ncharlie\n", "utf-8");
    await withTempBytes("controls.txt", bytes, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute(
        "r1",
        { file: "controls.txt" },
        undefined,
        undefined,
        ctx,
      );
      const text = readResult.content[0].text as string;

      // The bytes stay verbatim: the raw controls are emitted, never an escaped form.
      expect(text).toContain("\u0007beta\u001b");
      expect(text).not.toContain("\\x07");
      expect(text).not.toContain("\\u001b");

      // The notice names the invisible characters the rows carry.
      expect(text).toContain("2 non-printable control characters present: U+0007, U+001B");
      expect(text).toContain("shown verbatim");
    });
  });

  it("edit rejects binary files with descriptive error", async () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    await withTempBytes("image.png", bytes, async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);

      await expect(
        editTool.execute(
          "e1",
          { file: "image.png", edits: [{ anchor_from: "AAAA", anchor_to: "BBBB", text: "x" }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/image/i);
    });
  });

  it("edit rejects UTF-16 encoded text to prevent corruption", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00, 0x0a, 0x00]);
    await withTempBytes("utf16.txt", bytes, async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);

      await expect(
        editTool.execute(
          "e1",
          { file: "utf16.txt", edits: [{ anchor_from: "AAAA", anchor_to: "BBBB", text: "x" }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/UTF-16LE/);
    });
  });

  it("edit rejects directories with descriptive error", async () => {
    const { withTempSubdir } = await import("../support/fixtures");
    await withTempSubdir("mydir", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);

      await expect(
        editTool.execute(
          "e1",
          { file: "mydir", edits: [{ anchor_from: "AAAA", anchor_to: "BBBB", text: "x" }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/directory/i);
    });
  });

  it("edit rejects empty file deletion", async () => {
    await withTempFile("empty.txt", "a\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\n", join(cwd, "empty.txt"));
      await readTool.execute("r1", { file: "empty.txt" }, undefined, undefined, ctx);

      await expect(
        editTool.execute(
          "e1",
          {
            file: "empty.txt",
            edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_EMPTY_RANGE/);
    });
  });
});
