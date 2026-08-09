import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

describe("boundary duplication auto-fix", () => {
  it("trailing }: auto-fix strips duplicate, file is correct after one edit", async () => {
    const file = "function foo() {\n  const x = 1;\n  return x;\n}\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text1 = getText(read1);
      const lines1 = text1.split("\n");

      const line2Hash = extractHash(lines1.find(l => l.includes("│  const x = 1;"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  return x;"))!);

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_bounds: [line2Hash, line3Hash],
          new_content: `  const y = 2;\n  return y;\n}`,
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("function foo() {\n  const y = 2;\n  return y;\n}\n");
    });
  });

  it("reports accurate added-line counts when the boundary-dup fix removes a line", async () => {
    const file = "function foo() {\n  const x = 1;\n  return x;\n}\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line2Hash = extractHash(lines1.find(l => l.includes("│  const x = 1;"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  return x;"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_bounds: [line2Hash, line3Hash],
          new_content: `  const y = 2;\n  return y;\n}`,
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Added 2 line(s), removed 2 line(s).");
      expect(editResult.content[0].text).not.toContain("Added 3 line(s)");
      expect(editResult.details?.metrics?.added_lines).toBe(2);
      expect(editResult.details?.metrics?.removed_lines).toBe(2);

      const content = await readFile(path, "utf-8");
      expect(content).toBe("function foo() {\n  const y = 2;\n  return y;\n}\n");
    });
  });

  it("trailing });: auto-fix strips duplicate, file is correct after one edit", async () => {
    const file = 'app.get("/api", (req, res) => {\n  const data = fetchData();\n  res.json(data);\n});\n';
    await withTempFile("server.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "server.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line2Hash = extractHash(lines1.find(l => l.includes("│  const data"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  res.json"))!);

      await editTool.execute(
        "e1",
        {
          path: "server.ts",
          hash_bounds: [line2Hash, line3Hash],
          new_content: `  const result = processData();\n  res.json(result);\n});`,
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe('app.get("/api", (req, res) => {\n  const result = processData();\n  res.json(result);\n});\n');
    });
  });

  it("leading: auto-fix strips duplicate, file is correct after one edit", async () => {
    const file = "before();\nif (ok) {\n  run();\n}\nafter();\n";
    await withTempFile("logic.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "logic.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line2Hash = extractHash(lines1.find(l => l.includes("│if (ok)"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  run();"))!);

      await editTool.execute(
        "e1",
        {
          path: "logic.ts",
          hash_bounds: [line2Hash, line3Hash],
          new_content: `before();\nif (ok) {\n  runSafe();`,
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("before();\nif (ok) {\n  runSafe();\n}\nafter();\n");
    });
  });

  it("trailing } with multiple identical lines: auto-fix preserves correct hash", async () => {
    const file = "if (a) {\n  x();\n}\nif (b) {\n  y();\n}\nif (c) {\n  z();\n}\n";
    await withTempFile("multi.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "multi.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const line4Hash = extractHash(lines1.find(l => l.includes("│if (b)"))!);
      const line5Hash = extractHash(lines1.find(l => l.includes("│  y();"))!);

      const braceLines1 = lines1.filter(l => l.endsWith("│}"));
      expect(braceLines1.length).toBe(3);
      const survivingBraceHash = extractHash(braceLines1[1]!);

      await editTool.execute(
        "e1",
        {
          path: "multi.ts",
          hash_bounds: [line4Hash, line5Hash],
          new_content: `if (b) {\n  yNew();\n}`,
        },
        undefined,
        undefined,
        ctx,
      );

      const read2 = await readTool.execute("r2", { path: "multi.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const braceLines2 = lines2.filter(l => l.endsWith("│}"));
      expect(braceLines2.length).toBe(3);

      const matchingBraces = braceLines2.filter(l => extractHash(l) === survivingBraceHash);
      expect(matchingBraces.length).toBe(1);
      const survivingIndex = braceLines2.findIndex(l => extractHash(l) === survivingBraceHash);
      expect(survivingIndex).toBe(1);
    });
  });

  it("4th } before edit range: auto-fix strips duplicate, edit becomes noop", async () => {
    const file = [
      "if (a) {", "  x();", "}",
      "if (b) {", "  y();", "}",
      "if (c) {", "  z();", "}",
      "foo();",
      "bar();",
      "}",
    ].join("\n") + "\n";
    await withTempFile("fourth.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "fourth.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const fooHash = extractHash(lines1.find(l => l.includes("│foo();"))!);
      const barHash = extractHash(lines1.find(l => l.includes("│bar();"))!);

      const edit1 = await editTool.execute(
        "e1",
        {
          path: "fourth.ts",
          hash_bounds: [fooHash, barHash], new_content: `foo();\nbar();\n}`,
        },
        undefined,
        undefined,
        ctx,
      );

      const edit1Text = getText(edit1);
      expect(edit1Text).toContain("No changes made");
      expect(edit1Text).toContain("noop");

      const { readFile } = await import("fs/promises");
      const content = await readFile(path, "utf-8");
      expect(content).toBe(file);
    });
  });
});

describe("new-line boundary duplication (auto-fix)", () => {
  it("strips a new line duplicating a unique line after the range", async () => {
    const file = [
      "export class WorkflowEditorOverlay {",
      "  private activeTab = 0;",
      "  private confirmingClose = false;",
      "",
      "  constructor() {",
      "    this.activeTab = 0;",
      "  }",
      "}",
    ].join("\n") + "\n";
    await withTempFile("overlay.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "overlay.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const classHash = extractHash(lines1.find((l) => l.includes("│export class WorkflowEditorOverlay"))!);
      const blankHash = extractHash(lines1.find((l) => l.endsWith("│"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          path: "overlay.ts",
          hash_bounds: [classHash, blankHash],
          new_content: [
            "export class WorkflowEditorOverlay {",
            "  private activeTab = 0;",
            "  private confirmingClose = false;",
            "",
            "  constructor() {",
            "  }",
          ].join("\n"),
        },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(editResult);
      expect(text).toContain("Successfully replaced");
      expect(text).not.toContain("[E_BOUNDARY_DUP]");

      const content = await readFile(path, "utf-8");
      const constructorCount = content.split("\n").filter((l) => l.includes("constructor()")).length;
      expect(constructorCount).toBe(1);
    });
  });

  it("strips a new line duplicating a unique line before the range (noop)", async () => {
    const file = "foo();\nbar();\nbaz();\n";
    await withTempFile("reorder.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "reorder.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const barHash = extractHash(lines1.find((l) => l.includes("│bar();"))!);
      const bazHash = extractHash(lines1.find((l) => l.includes("│baz();"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          path: "reorder.ts",
          hash_bounds: [barHash, bazHash],
          new_content: "bar();\nbaz();\nfoo();",
        },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(editResult);
      expect(text).toContain("No changes made");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("foo();\nbar();\nbaz();\n");
    });
  });

  it("does not strip new-line duplicates when the adjacent line is not unique", async () => {
    const file = [
      "if (a) {",
      "  x();",
      "}",
      "if (b) {",
      "  y();",
      "}",
    ].join("\n") + "\n";
    await withTempFile("multi.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "multi.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const bHash = extractHash(lines1.find((l) => l.includes("│if (b)"))!);
      const yHash = extractHash(lines1.find((l) => l.includes("│  y();"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          path: "multi.ts",
          hash_bounds: [bHash, yHash],
          new_content: "if (b) {\n  yNew();\n}",
        },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(editResult);
      expect(text).toContain("Successfully replaced");
      expect(text).not.toContain("[E_BOUNDARY_DUP]");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("if (a) {\n  x();\n}\nif (b) {\n  yNew();\n}\n");
    });
  });

  it("does not strip when the first new line differs from the line after the range", async () => {
    const file = "a\nb\nc\nd\n";
    await withTempFile("plain.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "plain.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const aHash = extractHash(lines1.find((l) => l.includes("│a"))!);
      const bHash = extractHash(lines1.find((l) => l.includes("│b"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          path: "plain.ts",
          hash_bounds: [aHash, bHash],
          new_content: "a\nb\nX",
        },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(editResult);
      expect(text).not.toContain("[E_BOUNDARY_DUP]");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("a\nb\nX\nc\nd\n");
    });
  });
});
