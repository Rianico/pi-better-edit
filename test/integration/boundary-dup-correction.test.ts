import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

describe("boundary duplication warning → self-correction via replace", () => {
  it("trailing }: warning fires, LLM uses surviving hash to remove duplicate", async () => {
    const file = "function foo() {\n  const x = 1;\n  return x;\n}\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text1 = getText(read1);
      const lines1 = text1.split("\n");

      const line2Hash = extractHash(lines1.find(l => l.includes("│  const x = 1;"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  return x;"))!);
      const line4Hash = extractHash(lines1.find(l => l.includes("│}"))!);

      const edit1 = await editTool.execute(
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

      const edit1Text = getText(edit1);
      expect(edit1Text).toContain("Boundary duplication (trailing)");
      expect(edit1Text).toContain(`${line4Hash}│`);

      const survivingHash = line4Hash;

      const read2 = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const text2 = getText(read2);
      const lines2 = text2.split("\n");

      expect(lines2.some(l => l.includes("│  const y = 2;"))).toBe(true);
      expect(lines2.some(l => l.includes("│  return y;"))).toBe(true);

      const survivingLine = lines2.find(l => l.endsWith("│}"));
      expect(survivingLine).toBeTruthy();
      const survivingLineHash = extractHash(survivingLine!);
      expect(survivingLineHash).toBe(survivingHash);

      const braceLines = lines2.filter(l => l.endsWith("│}"));
      expect(braceLines.length).toBe(2);
      const duplicateHash = braceLines.find(l => extractHash(l) !== survivingHash);
      expect(duplicateHash).toBeTruthy();

      const edit2 = await editTool.execute(
        "e2",
        {
          path: "sample.ts",
          changes: [{
            hash_range_inclusive: [extractHash(duplicateHash!), extractHash(duplicateHash!)],
            content_lines: [],
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

  it("trailing });: warning fires, LLM removes duplicate using surviving hash", async () => {
    const file = 'app.get("/api", (req, res) => {\n  const data = fetchData();\n  res.json(data);\n});\n';
    await withTempFile("server.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "server.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line2Hash = extractHash(lines1.find(l => l.includes("│  const data"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  res.json"))!);
      const line4Hash = extractHash(lines1.find(l => l.includes("│});"))!);

      const edit1 = await editTool.execute(
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

      const edit1Text = getText(edit1);
      expect(edit1Text).toContain("Boundary duplication (trailing)");
      expect(edit1Text).toContain(`${line4Hash}│`);

      const survivingHash = line4Hash;

      const read2 = await readTool.execute("r2", { path: "server.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const braceLines = lines2.filter(l => l.includes("│});"));
      expect(braceLines.length).toBe(2);
      const duplicateHash = extractHash(braceLines.find(l => extractHash(l) !== survivingHash)!);

      await editTool.execute(
        "e2",
        { path: "server.ts", changes: [{ hash_range_inclusive: [duplicateHash, duplicateHash], content_lines: [] }] },
        undefined,
        undefined,
        ctx,
      );
      const content = await readFile(path, "utf-8");
      expect(content).toBe('app.get("/api", (req, res) => {\n  const result = processData();\n  res.json(result);\n});\n');
    });
  });

  it("leading: warning fires, LLM removes duplicate using surviving hash", async () => {
    const file = "before();\nif (ok) {\n  run();\n}\nafter();\n";
    await withTempFile("logic.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "logic.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line1Hash = extractHash(lines1.find(l => l.includes("│before();"))!);
      const line2Hash = extractHash(lines1.find(l => l.includes("│if (ok)"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  run();"))!);

      const edit1 = await editTool.execute(
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

      const edit1Text = getText(edit1);
      expect(edit1Text).toContain("Boundary duplication (leading)");
      expect(edit1Text).toContain(`${line1Hash}│`);

      const survivingHash = line1Hash;

      const read2 = await readTool.execute("r2", { path: "logic.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const beforeLines = lines2.filter(l => l.includes("│before();"));
      expect(beforeLines.length).toBe(2);
      const duplicateHash = extractHash(beforeLines.find(l => extractHash(l) !== survivingHash)!);

      await editTool.execute(
        "e2",
        { path: "logic.ts", changes: [{ hash_range_inclusive: [duplicateHash, duplicateHash], content_lines: [] }] },
        undefined,
        undefined,
        ctx,
      );
      const content = await readFile(path, "utf-8");
      expect(content).toBe("before();\nif (ok) {\n  runSafe();\n}\nafter();\n");
    });
  });

  it("trailing } with multiple identical lines: hash targets the correct occurrence", async () => {

    const file = "if (a) {\n  x();\n}\nif (b) {\n  y();\n}\nif (c) {\n  z();\n}\n";
    await withTempFile("multi.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "multi.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const line4Hash = extractHash(lines1.find(l => l.includes("│if (b)"))!);
      const line5Hash = extractHash(lines1.find(l => l.includes("│  y();"))!);

      const braceLines1 = lines1.filter(l => l.endsWith("│}"));
      expect(braceLines1.length).toBe(3);
      const survivingBraceHash = extractHash(braceLines1[1]!);

      const edit1 = await editTool.execute(
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

      const edit1Text = getText(edit1);
      expect(edit1Text).toContain("Boundary duplication (trailing)");
      expect(edit1Text).toContain(`${survivingBraceHash}│`);

      const survivingHash = survivingBraceHash;

      const read2 = await readTool.execute("r2", { path: "multi.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const braceLines2 = lines2.filter(l => l.endsWith("│}"));

      expect(braceLines2.length).toBe(4);

      const matchingBraces = braceLines2.filter(l => extractHash(l) === survivingHash);
      expect(matchingBraces.length).toBe(1);

      const survivingIndex = braceLines2.findIndex(l => extractHash(l) === survivingHash);
      expect(survivingIndex).toBe(1);
    });
  });

  it("4th } before edit range: occurrence counting still targets the correct line", async () => {

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

      const braceLines1 = lines1.filter(l => l.endsWith("│}"));
      expect(braceLines1.length).toBe(4);
      const fourthBraceHash = extractHash(braceLines1[3]!);

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
      expect(edit1Text).toContain("Boundary duplication (trailing)");
      expect(edit1Text).toContain(`${fourthBraceHash}│`);

      const survivingHash = fourthBraceHash;

      const read2 = await readTool.execute("r2", { path: "fourth.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const braceLines2 = lines2.filter(l => l.endsWith("│}"));
      expect(braceLines2.length).toBe(5);
      const matchingBraces = braceLines2.filter(l => extractHash(l) === survivingHash);
      expect(matchingBraces.length).toBe(1);
      const survivingIndex = braceLines2.findIndex(l => extractHash(l) === survivingHash);
      expect(survivingIndex).toBe(3);
    });
  });
});
