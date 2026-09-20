import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

const SMALL_CPP = `int f1(int x) {
\tif (x > 0) {
\t\treturn x;
\t}
\treturn -x;
}

int f2(int x) {
\tif (x > 0) {
\t\treturn x;
\t}
\treturn -x;
}
`;

const F2_ONLY = `int f2(int x) {
\tif (x > 0) {
\t\treturn x;
\t}
\treturn -x;
}
`;

describe("p0-drift-line-identity probes", () => {
  // Probe E: Full read -> external delete f1 -> edit with deleted f1 anchor psM
  it("probe E: full read -> external delete f1 -> edit with deleted f1 anchor psM fails closed with E_TARGET_LOST", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "small.cpp" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(readRes).split("\n");
      const line2Hash = extractHash(lines[1]!); // f1 guard (psM)

      await writeFile(path, F2_ONLY, "utf-8");

      const editPromise = editTool.execute(
        "e1",
        {
          path: "small.cpp",
          edits: [[line2Hash, line2Hash, "\tif (x > 100) {"]],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(editPromise).rejects.toThrow(/E_TARGET_LOST/);
      expect(await readFile(path, "utf-8")).toBe(F2_ONLY);
    });
  });

  // Probe A: Partial read -> external delete f1 -> edit with deleted f1 anchor psM
  it("probe A: partial read -> external delete f1 -> edit with deleted f1 anchor psM fails closed with E_TARGET_LOST", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "small.cpp", offset: 1, limit: 6 },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(readRes).split("\n");
      const line2Hash = extractHash(lines[1]!); // f1 guard (psM)

      await writeFile(path, F2_ONLY, "utf-8");

      const editPromise = editTool.execute(
        "e1",
        {
          path: "small.cpp",
          edits: [[line2Hash, line2Hash, "\tif (x > 100) {"]],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(editPromise).rejects.toThrow(/E_TARGET_LOST/);
      expect(await readFile(path, "utf-8")).toBe(F2_ONLY);
    });
  });

  // Probe B: Full read -> external delete f1 -> edit surviving f2 line AKU
  it("probe B: full read -> external delete f1 -> edit surviving f2 line AKU auto-rebases to line 2", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "small.cpp" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(readRes).split("\n");
      const line9Hash = extractHash(lines[8]!); // f2 guard (AKU)

      await writeFile(path, F2_ONLY, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          path: "small.cpp",
          edits: [[line9Hash, line9Hash, "\tif (x > 200) {"]],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toContain("\tif (x > 200) {");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  // Probe C: Full read -> external insert 7 lines at top -> edit with AKU
  it("probe C: full read -> external insert 7 lines at top -> edit with AKU auto-rebases to line 16", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "small.cpp" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(readRes).split("\n");
      const line9Hash = extractHash(lines[8]!); // f2 guard (line 9)

      const header = "// 1\n// 2\n// 3\n// 4\n// 5\n// 6\n// 7\n";
      await writeFile(path, header + SMALL_CPP, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          path: "small.cpp",
          edits: [[line9Hash, line9Hash, "\tif (x > 300) {"]],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toContain("\tif (x > 300) {");
      const newLines = content.split("\n");
      expect(newLines[15]).toBe("\tif (x > 300) {"); // line 16 is index 15
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  // Probe D: Full read -> external edit inside f1 -> edit with AKU
  it("probe D: full read -> external edit inside f1 -> edit with AKU auto-rebases to line 9", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "small.cpp" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(readRes).split("\n");
      const line9Hash = extractHash(lines[8]!); // f2 guard (line 9)

      // External edit: modify line 5 of f1 (\treturn -x; -> \treturn 0;)
      const modified = SMALL_CPP.replace("\treturn -x;", "\treturn 0;");
      await writeFile(path, modified, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          path: "small.cpp",
          edits: [[line9Hash, line9Hash, "\tif (x > 400) {"]],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toContain("\tif (x > 400) {");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  // Probe H: aaa | a, bbb | b, ccc | a -> insert ddd | d before ccc -> edit ccc with ccc | mod
  it("probe H: duplicate canons with intervening insert -> edit ccc auto-rebases to line 4", async () => {
    const fixture = "a\nb\na\n";
    await withTempFile("dup.txt", fixture, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute("r1", { path: "dup.txt" }, undefined, undefined, ctx);
      const lines = getText(readRes).split("\n");
      const line3Hash = extractHash(lines[2]!); // ccc | a

      // External insert d before line 3 -> a\nb\nd\na\n
      await writeFile(path, "a\nb\nd\na\n", "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          path: "dup.txt",
          edits: [[line3Hash, line3Hash, "mod"]],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("a\nb\nd\nmod\n");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  // Probe I: Read full -> tool edit 1 inserts 5 lines at line 50 -> tool edit 2 replaces line 10
  it("probe I: multi-edit batch out-of-order auto-rebases via preceding working-buffer deltas", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await withTempFile("batch.txt", lines, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "batch.txt" },
        undefined,
        undefined,
        ctx,
      );
      const readLines = getText(readRes).split("\n");
      const line10Hash = extractHash(readLines[9]!); // line 10
      const line50Hash = extractHash(readLines[49]!); // line 50

      // Batch out-of-order: edit 1 modifies line 50 (+5 lines), edit 2 modifies line 10
      const editRes = await editTool.execute(
        "e1",
        {
          path: "batch.txt",
          edits: [
            [
              line50Hash,
              line50Hash,
              "line 50 inserted\nline 50.1\nline 50.2\nline 50.3\nline 50.4\nline 50.5",
            ],
            [line10Hash, line10Hash, "line 10 modified"],
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      const resLines = content.split("\n");
      expect(resLines[9]).toBe("line 10 modified");
      expect(resLines[49]).toBe("line 50 inserted");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  // Probe J: Read lines 10-20 -> external insert between line 12 and 13 -> edit lines 10-20
  it("probe J: external insert strictly inside target span fails closed with E_STALE_RANGE", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join("\n") + "\n";
    await withTempFile("tear.txt", lines, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "tear.txt", offset: 10, limit: 11 }, // lines 10 to 20
        undefined,
        undefined,
        ctx,
      );
      const readLines = getText(readRes).split("\n");
      const line10Hash = extractHash(readLines[0]!);
      const line20Hash = extractHash(readLines[10]!);

      // External insert between line 12 and line 13
      const fileLines = lines.split("\n");
      fileLines.splice(12, 0, "inserted row between 12 and 13");
      const tornContent = fileLines.join("\n");
      await writeFile(path, tornContent, "utf-8");

      const editPromise = editTool.execute(
        "e1",
        {
          path: "tear.txt",
          edits: [[line10Hash, line20Hash, "replaced span 10 to 20"]],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(editPromise).rejects.toThrow(/E_STALE_RANGE/);
      expect(await readFile(path, "utf-8")).toBe(tornContent);
    });
  });

  // Probe K: External swap of two unique functions -> edit either
  it("probe K: external swap of two unique functions fails closed with E_TARGET_LOST", async () => {
    const original = `function alpha() {
  return "alpha";
} // end alpha

function beta() {
  return "beta";
} // end beta
`;
    const swapped = `function beta() {
  return "beta";
} // end beta

function alpha() {
  return "alpha";
} // end alpha
`;
    await withTempFile("swap.js", original, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute("r1", { path: "swap.js" }, undefined, undefined, ctx);
      const readLines = getText(readRes).split("\n");
      const alphaStartHash = extractHash(readLines[0]!);
      const alphaEndHash = extractHash(readLines[2]!);

      // External swap
      await writeFile(path, swapped, "utf-8");

      const editPromise = editTool.execute(
        "e1",
        {
          path: "swap.js",
          edits: [
            [
              alphaStartHash,
              alphaEndHash,
              "function alpha() {\n  return 'alpha-modified';\n} // end alpha",
            ],
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(editPromise).rejects.toThrow(/E_TARGET_LOST/);
      expect(await readFile(path, "utf-8")).toBe(swapped);
    });
  });

  // Probe L: Large file (30,000 lines) with exterior insert -> edit line 25,000
  it("probe L: large file 30k lines with exterior insert auto-rebases via scaled budget", async () => {
    const totalLines = 30000;
    const fileContent =
      Array.from({ length: totalLines }, (_, i) => `item_${i + 1}`).join("\n") + "\n";
    await withTempFile("large.txt", fileContent, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "large.txt", offset: 25000, limit: 1 },
        undefined,
        undefined,
        ctx,
      );
      const line25000Hash = extractHash(getText(readRes).split("\n")[0]!);

      // Exterior insert 5 lines at line 0 (top)
      const drifted = "top1\ntop2\ntop3\ntop4\ntop5\n" + fileContent;
      await writeFile(path, drifted, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          path: "large.txt",
          edits: [[line25000Hash, line25000Hash, "item_25000_edited"]],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toContain("item_25000_edited");
      const linesAfter = content.split("\n");
      expect(linesAfter[25004]).toBe("item_25000_edited"); // 25000 + 5 - 1 = index 25004
      expect(getText(editRes)).toContain("Successfully edited");
    });
  }, 20000);

  // Probe M: External insert 7 lines at line 0 -> batch: edit 1 at line 10 (+5 lines), edit 2 at line 15
  it("probe M: external drift + batch chained edits auto-rebases on top of shifted baseline s'", async () => {
    const fileContent = Array.from({ length: 30 }, (_, i) => `base_${i + 1}`).join("\n") + "\n";
    await withTempFile("batch_drift.txt", fileContent, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "batch_drift.txt" },
        undefined,
        undefined,
        ctx,
      );
      const readLines = getText(readRes).split("\n");
      const line10Hash = extractHash(readLines[9]!); // base_10
      const line15Hash = extractHash(readLines[14]!); // base_15

      // Exterior insert 7 lines at top
      const header = Array.from({ length: 7 }, (_, i) => `header_${i + 1}`).join("\n") + "\n";
      await writeFile(path, header + fileContent, "utf-8");

      // Batch edit: edit 1 replaces line 10 with 6 lines (+5 lines delta); edit 2 replaces line 15
      const editRes = await editTool.execute(
        "e1",
        {
          path: "batch_drift.txt",
          edits: [
            [line10Hash, line10Hash, "base_10_ext1\next2\next3\next4\next5\next6"],
            [line15Hash, line15Hash, "base_15_modified"],
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toContain("base_10_ext1");
      expect(content).toContain("base_15_modified");
      const linesAfter = content.split("\n");
      // Original line 10 shifted by 7 -> line 17 (index 16)
      expect(linesAfter[16]).toBe("base_10_ext1");
      // Original line 15 shifted by 7 (+7) + preceding delta (+5) -> line 27 (index 26)
      expect(linesAfter[26]).toBe("base_15_modified");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  // Probe N: 3,000 identical lines bounded by unique header/footer -> exterior insert 5 lines at top -> edit line 1,500
  it("probe N: large duplicate boilerplate with exterior shift auto-rebases via rigid block shift", async () => {
    const duplicateRun = Array.from({ length: 3000 }, () => "  }").join("\n");
    const fileContent = `// unique-header\n${duplicateRun}\n// unique-footer\n`;
    await withTempFile("boilerplate.txt", fileContent, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "boilerplate.txt", offset: 1500, limit: 1 },
        undefined,
        undefined,
        ctx,
      );
      const line1500Hash = extractHash(getText(readRes).split("\n")[0]!);

      // Exterior insert 5 lines at top
      const header = "// 1\n// 2\n// 3\n// 4\n// 5\n";
      await writeFile(path, header + fileContent, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          path: "boilerplate.txt",
          edits: [[line1500Hash, line1500Hash, "  // edited line 1500"]],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toContain("  // edited line 1500");
      const linesAfter = content.split("\n");
      // Original line 1500 shifted by 5 -> line 1505 (index 1504)
      expect(linesAfter[1504]).toBe("  // edited line 1500");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  // Deliverable §3.1.2: Re-serve upsert breaks retry loop
  it("re-serve upsert: drift -> re-read updates lease to new line_id -> subsequent edit succeeds", async () => {
    const original = "alpha\nbravo\ncharlie\n";
    await withTempFile("reserve.txt", original, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      // 1. Initial read serves anchors for lines 1..3
      const r1 = await readTool.execute("r1", { path: "reserve.txt" }, undefined, undefined, ctx);
      const lines1 = getText(r1).split("\n");
      const _bravoHash1 = extractHash(lines1[1]!);

      // 2. Drift: insert two lines at top, shifting bravo from line 2 to line 4
      await writeFile(path, "head1\nhead2\nalpha\nbravo\ncharlie\n", "utf-8");

      // 3. Re-read: authoritative re-serve assigns fresh presentation/lease
      const r2 = await readTool.execute("r2", { path: "reserve.txt" }, undefined, undefined, ctx);
      const lines2 = getText(r2).split("\n");
      const bravoHash2 = extractHash(lines2[3]!); // line 4 in 1-based index is lines2[3]

      // 4. Subsequent edit targeting the re-served anchor succeeds cleanly
      const editRes = await editTool.execute(
        "e1",
        {
          path: "reserve.txt",
          edits: [[bravoHash2, bravoHash2, "bravo-modified"]],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toContain("bravo-modified");
      const updatedLines = content.split("\n");
      expect(updatedLines[3]).toBe("bravo-modified");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  // Deliverable §3.6.2: Post-write failure recovery
  it("post-write failure recovery: external file content remains authoritative when store is desynced", async () => {
    const original = "row 1\nrow 2\nrow 3\n";
    await withTempFile("recover.txt", original, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute("r1", { path: "recover.txt" }, undefined, undefined, ctx);
      const row2Hash = extractHash(getText(r1).split("\n")[1]!);

      // Apply first edit
      await editTool.execute(
        "e1",
        {
          path: "recover.txt",
          edits: [[row2Hash, row2Hash, "row 2 updated"]],
        },
        undefined,
        undefined,
        ctx,
      );

      // External process modifies disk independently (simulating uncommitted store or out-of-band write)
      await writeFile(path, "row 1\nrow 2 updated\nrow 3\nrow 4 exterior\n", "utf-8");

      // Re-read file to observe disk state and fresh anchors
      const r2 = await readTool.execute("r2", { path: "recover.txt" }, undefined, undefined, ctx);
      const lines2 = getText(r2).split("\n");
      const row2HashAfter = extractHash(lines2[1]!);

      // Second edit on top of recovered state succeeds
      const edit2Res = await editTool.execute(
        "e2",
        {
          path: "recover.txt",
          edits: [[row2HashAfter, row2HashAfter, "row 2 final"]],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("row 1\nrow 2 final\nrow 3\nrow 4 exterior\n");
      expect(getText(edit2Res)).toContain("Successfully edited");
    });
  });

  // Deliverable §7.2.9: Undo usability without intermediate read
  it("undo usability: editing immediately using anchors from undo_last_edit succeeds without read", async () => {
    const original = "first line\nsecond line\nthird line\n";
    await withTempFile("undo_flow.txt", original, async ({ cwd, path }) => {
      const { ctx, readTool, editTool, undoTool } = setupIntegrationTest(cwd);
      // 1. Initial read
      const r1 = await readTool.execute("r1", { path: "undo_flow.txt" }, undefined, undefined, ctx);
      const line2Hash = extractHash(getText(r1).split("\n")[1]!);

      // 2. Perform edit
      await editTool.execute(
        "e1",
        {
          path: "undo_flow.txt",
          edits: [[line2Hash, line2Hash, "second line edited"]],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toContain("second line edited");

      // 3. Undo edit
      const undoRes = await undoTool.execute(
        "u1",
        { path: "undo_flow.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe(original);

      // 4. Extract anchor from undo response details without calling readTool
      const servedRows = undoRes.details?.servedRows;
      expect(servedRows).toBeDefined();
      expect(servedRows.length).toBeGreaterThan(0);
      const restoredLine2Hash = servedRows[1]?.hash;
      expect(restoredLine2Hash).toBeDefined();

      // 5. Immediately edit using restored anchor without an intermediate read
      const edit2Res = await editTool.execute(
        "e2",
        {
          path: "undo_flow.txt",
          edits: [[restoredLine2Hash, restoredLine2Hash, "second line modified after undo"]],
        },
        undefined,
        undefined,
        ctx,
      );

      const finalContent = await readFile(path, "utf-8");
      expect(finalContent).toBe("first line\nsecond line modified after undo\nthird line\n");
      expect(getText(edit2Res)).toContain("Successfully edited");
    });
  });
});
