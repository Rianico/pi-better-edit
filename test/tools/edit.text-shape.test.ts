import { describe, expect, it } from "vitest";
import register from "../../index";
import { lineHashes } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile, getText } from "../support/fixtures";

describe("edit tool text shape (token budget)", () => {
  it("changed mode keeps only anchors in LLM-visible text and line counts in details", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("replace");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            {
              hash_range_inclusive: [lineHashes("aaa\nbbb\nccc\n")[1], lineHashes("aaa\nbbb\nccc\n")[1]], content_lines: ["BBB"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      const text = getText(result);

      expect(text).toBe("");
      expect(text).not.toContain("Updated sample.ts");
      expect(text).not.toContain("Changes: +1 -1");
      expect(text).not.toContain("Updated anchors");
      expect(result.details?.diff).toContain(`+${lineHashes("aaa\nBBB\nccc\n")[1]}`);
      expect(result.details?.diff).toContain("│BBB");
      expect(result.details?.metrics).toMatchObject({
        added_lines: 1,
        removed_lines: 1,
      });
    });
  });

  it("changed mode uses short anchor header without instructional clause", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("replace");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            {
              hash_range_inclusive: [lineHashes("aaa\nbbb\nccc\n")[1], lineHashes("aaa\nbbb\nccc\n")[1]], content_lines: ["BBB"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      const text = getText(result);

      expect(text).toBe("");
      expect(text).not.toMatch(/use these for subsequent edits/);
    });
  });

  it("changed mode rejects deleting all content from a non-empty file", async () => {
    await withTempFile("sample.txt", "only\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("replace");

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.txt",
            changes: [
              {
                hash_range_inclusive: [lineHashes("only\n")[0], lineHashes("only\n")[0]], content_lines: [],
              },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/^\[E_WOULD_EMPTY\]/);
    });
  });

  it("changed mode omits oversized anchor payloads even when the changed span fits by line count", async () => {
    const longLine = "a".repeat(60_000);
    await withTempFile("sample.txt", `before\n${longLine}\nafter\n`, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("replace");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          changes: [
            {
              hash_range_inclusive: [lineHashes(`before\n${longLine}\nafter\n`)[1], lineHashes(`before\n${longLine}\nafter\n`)[1]], content_lines: [`b${longLine.slice(1)}`],
            },
          ],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      const text = getText(result);

      expect(text).toBe("");
      expect(text).not.toContain("--- Anchors");
    });
  });
});
