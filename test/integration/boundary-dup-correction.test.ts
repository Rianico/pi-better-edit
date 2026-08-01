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
          changes: [{
            hash_range_inclusive: [line2Hash, line3Hash],
            content_lines: ["  const y = 2;", "  return y;", "}"],
          }],
        },
        undefined,
        undefined,
        ctx,
      );

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
          changes: [{
            hash_range_inclusive: [line2Hash, line3Hash],
            content_lines: ["  const result = processData();", "  res.json(result);", "});"],
          }],
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
          changes: [{
            hash_range_inclusive: [line2Hash, line3Hash],
            content_lines: ["before();", "if (ok) {", "  runSafe();"],
          }],
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
          changes: [{
            hash_range_inclusive: [line4Hash, line5Hash],
            content_lines: ["if (b) {", "  yNew();", "}"],
          }],
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
          changes: [{ hash_range_inclusive: [fooHash, barHash], content_lines: ["foo();", "bar();", "}"] }],
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
