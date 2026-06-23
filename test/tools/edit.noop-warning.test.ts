import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import register from "../../index";
import { lineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile, getText } from "../support/fixtures";

describe("edit tool noop + warnings", () => {
  it("returns classification noop instead of throwing on identical content", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("replace");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [
            {
              old_range: [`${lineHash(2, "bbb")}`, `${lineHash(2, "bbb")}`], new_lines: ["bbb"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Classification: noop");
      expect(result.details?.classification).toBe("noop");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("warns on trailing duplicate line that matches the next surviving line", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("replace");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [
            {
              old_range: [`${lineHash(2, "bbb")}`, `${lineHash(2, "bbb")}`], new_lines: ["BBB", "ccc"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Warnings:");
      expect(getText(result)).toMatch(/Potential boundary duplication/i);
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\nccc\n");
    });
  });
});
