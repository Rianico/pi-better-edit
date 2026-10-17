import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

describe("boundary duplication — pure edit (no auto-fix)", () => {
  it("trailing }: pure edit keeps duplicate brace", async () => {
    const file = "function foo() {\n  const x = 1;\n  return x;\n}\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const read1 = await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line2Hash = extractHash(lines1.find((l) => l.includes("│  const x = 1;"))!);
      const line3Hash = extractHash(lines1.find((l) => l.includes("│  return x;"))!);
      await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [
            {
              anchor_from: line2Hash,
              anchor_to: line3Hash,
              text: `  const y = 2;\n  return y;\n}`,
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      const content = await readFile(path, "utf-8");
      // pure edit: trailing "}" duplicates the line after range → preserved verbatim
      expect(content).toBe("function foo() {\n  const y = 2;\n  return y;\n}\n}\n");
    });
  });

  it("leading: pure edit keeps duplicate leading line", async () => {
    const file = "before();\nif (ok) {\n  run();\n}\nafter();\n";
    await withTempFile("logic.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const read1 = await readTool.execute("r1", { file: "logic.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line2Hash = extractHash(lines1.find((l) => l.includes("│if (ok)"))!);
      const line3Hash = extractHash(lines1.find((l) => l.includes("│  run();"))!);
      await editTool.execute(
        "e1",
        {
          file: "logic.ts",
          edits: [
            {
              anchor_from: line2Hash,
              anchor_to: line3Hash,
              text: `before();\nif (ok) {\n  runSafe();`,
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      const content = await readFile(path, "utf-8");
      expect(content).toBe("before();\nbefore();\nif (ok) {\n  runSafe();\n}\nafter();\n");
    });
  });

  it("minimal a/b over a: keeps duplicate (3 lines)", async () => {
    const file = "a\nb\n";
    await withTempFile("mini.txt", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const read1 = await readTool.execute("r1", { file: "mini.txt" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const aHash = extractHash(lines1.find((l) => l.includes("│a"))!);
      await editTool.execute(
        "e1",
        { file: "mini.txt", edits: [{ anchor_from: aHash, anchor_to: aHash, text: "a\nb" }] },
        undefined,
        undefined,
        ctx,
      );
      const content = await readFile(path, "utf-8");
      expect(content).toBe("a\nb\nb\n");
    });
  });

  it("multi-line run: keeps all duplicated lines verbatim", async () => {
    const file = "function a() {\n  const x = 1;\n}\n}\nafter();\n";
    await withTempFile("nested.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const read1 = await readTool.execute("r1", { file: "nested.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const bodyHash = extractHash(lines1.find((l) => l.includes("│  const x = 1;"))!);
      await editTool.execute(
        "e1",
        {
          file: "nested.ts",
          edits: [{ anchor_from: bodyHash, anchor_to: bodyHash, text: "  const x = 2;\n}\n}" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const content = await readFile(path, "utf-8");
      // replacement 2 braces + original 2 braces = 4 braces
      expect(content).toBe("function a() {\n  const x = 2;\n}\n}\n}\n}\nafter();\n");
    });
  });
});
