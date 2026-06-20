import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import register from "../../index";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

function extractHash(line: string): string {
  return line.split("│")[0]!;
}

describe("boundary duplication warning → self-correction via replace", () => {
  it("trailing }: warning fires, LLM uses surviving hash to remove duplicate", async () => {
    const file = "function foo() {\n  const x = 1;\n  return x;\n}\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("replace");

      // Step 1: Read the file to get anchors
      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text1 = getText(read1);
      const lines1 = text1.split("\n");

      // Find anchors for lines 2-3 (the function body)
      const line2Hash = extractHash(lines1.find(l => l.includes("│  const x = 1;"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  return x;"))!);
      const line4Hash = extractHash(lines1.find(l => l.includes("│}"))!);

      // Step 2: LLM edits lines 2-3, accidentally adds trailing } duplicating line 4
      const edit1 = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          edits: [{
            old_range: [line2Hash, line3Hash],
            new_lines: ["  const y = 2;", "  return y;", "}"], // trailing } duplicates line 4
          }],
        },
        undefined,
        undefined,
        ctx,
      );

      // Step 3: Warning fires with the surviving line hash
      const edit1Text = getText(edit1);
      expect(edit1Text).toContain("Potential boundary duplication");
      expect(edit1Text).toContain("Surviving line hash:");

      // Extract the surviving line hash from the warning
      const survivingHashMatch = edit1Text.match(/Surviving line hash: (\S+)/);
      expect(survivingHashMatch).toBeTruthy();
      const survivingHash = survivingHashMatch![1]!;

      // The surviving hash should match the original line 4 (the })
      expect(survivingHash).toBe(line4Hash);

      // Step 4: LLM re-reads the file to get fresh anchors for the duplicate
      const read2 = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const text2 = getText(read2);
      const lines2 = text2.split("\n");

      // The file now has: function foo() { / const y = 2; / return y; / } / } / (empty)
      // The surviving } is line 4, the duplicate } is line 5
      expect(lines2.some(l => l.includes("│  const y = 2;"))).toBe(true);
      expect(lines2.some(l => l.includes("│  return y;"))).toBe(true);

      // Find the surviving } hash (should be the same as the original)
      const survivingLine = lines2.find(l => l.endsWith("│}"));
      expect(survivingLine).toBeTruthy();
      const survivingLineHash = extractHash(survivingLine!);
      expect(survivingLineHash).toBe(survivingHash); // same hash as warning provided

      // Find the duplicate } — it's the OTHER line ending with │}
      const braceLines = lines2.filter(l => l.endsWith("│}"));
      expect(braceLines.length).toBe(2); // surviving + duplicate
      const duplicateHash = braceLines.find(l => extractHash(l) !== survivingHash);
      expect(duplicateHash).toBeTruthy();

      // Step 5: LLM uses the fresh hash to remove the duplicate line
      const edit2 = await editTool.execute(
        "e2",
        {
          path: "sample.ts",
          edits: [{
            old_range: [extractHash(duplicateHash!), extractHash(duplicateHash!)],
            new_lines: [],
          }],
        },
        undefined,
        undefined,
        ctx,
      );

      // Step 6: Verify the file is correct — no duplicate }
      const content = await readFile(path, "utf-8");
      expect(content).toBe("function foo() {\n  const y = 2;\n  return y;\n}\n");
    });
  });

  it("trailing });: warning fires, LLM removes duplicate using surviving hash", async () => {
    const file = 'app.get("/api", (req, res) => {\n  const data = fetchData();\n  res.json(data);\n});\n';
    await withTempFile("server.ts", file, async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("replace");

      const read1 = await readTool.execute("r1", { path: "server.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line2Hash = extractHash(lines1.find(l => l.includes("│  const data"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  res.json"))!);
      const line4Hash = extractHash(lines1.find(l => l.includes("│});"))!);

      // Edit lines 2-3, accidentally add }); duplicating line 4
      const edit1 = await editTool.execute(
        "e1",
        {
          path: "server.ts",
          edits: [{
            old_range: [line2Hash, line3Hash],
            new_lines: ["  const result = processData();", "  res.json(result);", "});"],
          }],
        },
        undefined,
        undefined,
        ctx,
      );

      const edit1Text = getText(edit1);
      expect(edit1Text).toContain("Surviving line hash:");
      const survivingHash = edit1Text.match(/Surviving line hash: (\S+)/)![1]!;
      expect(survivingHash).toBe(line4Hash);

      // Re-read, find duplicate, remove it
      const read2 = await readTool.execute("r2", { path: "server.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const braceLines = lines2.filter(l => l.includes("│});"));
      expect(braceLines.length).toBe(2);
      const duplicateHash = extractHash(braceLines.find(l => extractHash(l) !== survivingHash)!);

      await editTool.execute(
        "e2",
        { path: "server.ts", edits: [{ old_range: [duplicateHash, duplicateHash], new_lines: [] }] },
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
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("replace");

      const read1 = await readTool.execute("r1", { path: "logic.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line1Hash = extractHash(lines1.find(l => l.includes("│before();"))!);
      const line2Hash = extractHash(lines1.find(l => l.includes("│if (ok)"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  run();"))!);

      // Edit lines 2-3, accidentally add leading before(); duplicating line 1
      const edit1 = await editTool.execute(
        "e1",
        {
          path: "logic.ts",
          edits: [{
            old_range: [line2Hash, line3Hash],
            new_lines: ["before();", "if (ok) {", "  runSafe();"],
          }],
        },
        undefined,
        undefined,
        ctx,
      );

      const edit1Text = getText(edit1);
      expect(edit1Text).toContain("Surviving line hash:");
      const survivingHash = edit1Text.match(/Surviving line hash: (\S+)/)![1]!;
      expect(survivingHash).toBe(line1Hash);

      // Re-read, find duplicate, remove it
      const read2 = await readTool.execute("r2", { path: "logic.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const beforeLines = lines2.filter(l => l.includes("│before();"));
      expect(beforeLines.length).toBe(2); // surviving + duplicate
      const duplicateHash = extractHash(beforeLines.find(l => extractHash(l) !== survivingHash)!);

      await editTool.execute(
        "e2",
        { path: "logic.ts", edits: [{ old_range: [duplicateHash, duplicateHash], new_lines: [] }] },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("before();\nif (ok) {\n  runSafe();\n}\nafter();\n");
    });
  });

  it("trailing } with multiple identical lines: hash targets the correct occurrence", async () => {
    // File has 3 } lines. Edit targets lines 4-5 (between 2nd and 3rd }).
    // The surviving } is the 3rd one (occurrence index 2).
    const file = "if (a) {\n  x();\n}\nif (b) {\n  y();\n}\nif (c) {\n  z();\n}\n";
    await withTempFile("multi.ts", file, async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("replace");

      const read1 = await readTool.execute("r1", { path: "multi.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      // Find anchors for lines 4-5 (if (b) { and y();)
      const line4Hash = extractHash(lines1.find(l => l.includes("│if (b)"))!);
      const line5Hash = extractHash(lines1.find(l => l.includes("│  y();"))!);

      // The 3rd } (line 8) is the surviving line we expect the warning to reference
      const braceLines1 = lines1.filter(l => l.endsWith("│}"));
      expect(braceLines1.length).toBe(3);
      const survivingBraceHash = extractHash(braceLines1[1]!); // the 2nd } (after y(), occurrence index 1)

      // Edit lines 4-5, add trailing } duplicating line 6
      const edit1 = await editTool.execute(
        "e1",
        {
          path: "multi.ts",
          edits: [{
            old_range: [line4Hash, line5Hash],
            new_lines: ["if (b) {", "  yNew();", "}"],
          }],
        },
        undefined,
        undefined,
        ctx,
      );

      const edit1Text = getText(edit1);
      expect(edit1Text).toContain("Surviving line hash:");
      const survivingHash = edit1Text.match(/Surviving line hash: (\S+)/)![1]!;

      // The surviving hash should be the 2nd } hash (the one after y())
      expect(survivingHash).toBe(survivingBraceHash);

      // Re-read and verify the surviving hash is usable
      const read2 = await readTool.execute("r2", { path: "multi.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const braceLines2 = lines2.filter(l => l.endsWith("│}"));
      // 4 braces now: 3 originals + 1 duplicate
      expect(braceLines2.length).toBe(4);

      // The surviving hash should match exactly one } line — the 2nd } (after y())
      const matchingBraces = braceLines2.filter(l => extractHash(l) === survivingHash);
      expect(matchingBraces.length).toBe(1);

      // Verify it's the 2nd } (the one after yNew), not the 1st or 3rd
      const survivingIndex = braceLines2.findIndex(l => extractHash(l) === survivingHash);
      expect(survivingIndex).toBe(1); // 0-indexed: 1st=after x(), 2nd=after yNew(), 3rd=duplicate, 4th=after z()
    });
  });

  it("4th } before edit range: occurrence counting still targets the correct line", async () => {
    // 4 } lines. Edit targets lines 10-11 (after the 3rd }). Surviving is the 4th }.
    const file = [
      "if (a) {", "  x();", "}",
      "if (b) {", "  y();", "}",
      "if (c) {", "  z();", "}",
      "foo();",
      "bar();",
      "}",
    ].join("\n") + "\n";
    await withTempFile("fourth.ts", file, async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("replace");

      const read1 = await readTool.execute("r1", { path: "fourth.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      // The 4th } is the one we expect as surviving
      const braceLines1 = lines1.filter(l => l.endsWith("│}"));
      expect(braceLines1.length).toBe(4);
      const fourthBraceHash = extractHash(braceLines1[3]!);

      // Find anchors for lines 10-11 (foo(); and bar();)
      const fooHash = extractHash(lines1.find(l => l.includes("│foo();"))!);
      const barHash = extractHash(lines1.find(l => l.includes("│bar();"))!);

      // Edit lines 10-11, add trailing } duplicating line 12
      const edit1 = await editTool.execute(
        "e1",
        {
          path: "fourth.ts",
          edits: [{ old_range: [fooHash, barHash], new_lines: ["foo();", "bar();", "}"] }],
        },
        undefined,
        undefined,
        ctx,
      );

      const edit1Text = getText(edit1);
      expect(edit1Text).toContain("Surviving line hash:");
      const survivingHash = edit1Text.match(/Surviving line hash: (\S+)/)![1]!;

      // The surviving hash should be the 4th } — occurrence index 3
      expect(survivingHash).toBe(fourthBraceHash);

      // Verify with re-read
      const read2 = await readTool.execute("r2", { path: "fourth.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const braceLines2 = lines2.filter(l => l.endsWith("│}"));
      expect(braceLines2.length).toBe(5); // 4 originals + 1 duplicate
      const matchingBraces = braceLines2.filter(l => extractHash(l) === survivingHash);
      expect(matchingBraces.length).toBe(1);
      const survivingIndex = braceLines2.findIndex(l => extractHash(l) === survivingHash);
      expect(survivingIndex).toBe(3); // 0-indexed: the 4th }
    });
  });
});
