import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

async function finalAnchor(ctx: any, readTool: any, file: string): Promise<string> {
  const first = await readTool.execute("r1", { file }, undefined, undefined, ctx);
  const rows = getText(first)
    .split("\n")
    .filter((line) => line.includes("│"));
  const last = rows.at(-1);
  if (last === undefined) throw new Error("expected at least one served row");
  return extractHash(last);
}

async function editAfterFinal(cwd: string, file: string, text: string): Promise<void> {
  const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
  const last = await finalAnchor(ctx, readTool, file);
  await editTool.execute(
    "e1",
    {
      file,
      edits: [{ anchor_from: last, anchor_to: last, at: "after", text }],
    },
    undefined,
    undefined,
    ctx,
  );
}

describe("edit EOF / trailing-newline contract (byte-exact through the edit path)", () => {
  it("after on the final anchor of a newline-terminated file preserves the POSIX ending", async () => {
    await withTempFile("sample.txt", "a\nb\n", async ({ cwd, path }) => {
      await editAfterFinal(cwd, "sample.txt", "P");
      expect(await readFile(path, "utf8")).toBe("a\nb\nP\n");
    });
  });

  it("after on the final anchor of a file without a trailing newline stays unterminated", async () => {
    await withTempFile("sample.txt", "a\nb", async ({ cwd, path }) => {
      await editAfterFinal(cwd, "sample.txt", "P");
      const bytes = await readFile(path, "utf8");
      expect(bytes).toBe("a\nb\nP");
      expect(bytes.endsWith("\n")).toBe(false);
    });
  });

  it("one trailing newline in text terminates an unterminated file", async () => {
    await withTempFile("sample.txt", "a\nb", async ({ cwd, path }) => {
      await editAfterFinal(cwd, "sample.txt", "P\n");
      expect(await readFile(path, "utf8")).toBe("a\nb\nP\n");
    });
  });

  it("one trailing newline in text on a terminated file appends a blank line", async () => {
    await withTempFile("sample.txt", "a\nb\n", async ({ cwd, path }) => {
      await editAfterFinal(cwd, "sample.txt", "P\n");
      expect(await readFile(path, "utf8")).toBe("a\nb\nP\n\n");
    });
  });
});
