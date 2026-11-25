import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import {
  withTempFile,
  setupIntegrationTest,
  getText,
  extractHash,
  anchorRows,
} from "../support/fixtures";
import { loadBlockedHashes, sessionKeyFor } from "../../src/served-session/session.js";

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
  it("probe E: full read -> external delete f1 -> edit with deleted f1 anchor psM fails closed with E_TARGET_LOST", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "small.cpp" },
        undefined,
        undefined,
        ctx,
      );
      const lines = anchorRows(getText(readRes));
      const line2Hash = extractHash(lines[1]!);

      await writeFile(path, F2_ONLY, "utf-8");

      const editPromise = editTool.execute(
        "e1",
        {
          file: "small.cpp",
          edits: [{ anchor_from: line2Hash, anchor_to: line2Hash, text: "\tif (x > 100) {" }],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(editPromise).rejects.toThrow(/E_TARGET_LOST/);
      expect(await readFile(path, "utf-8")).toBe(F2_ONLY);
    });
  });

  it("probe A: partial read -> external delete f1 -> edit with deleted f1 anchor psM fails closed with E_TARGET_LOST", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "small.cpp", windows: [{ offset: 1, limit: 6 }] },
        undefined,
        undefined,
        ctx,
      );
      const lines = anchorRows(getText(readRes));
      const line2Hash = extractHash(lines[1]!);

      await writeFile(path, F2_ONLY, "utf-8");

      const editPromise = editTool.execute(
        "e1",
        {
          file: "small.cpp",
          edits: [{ anchor_from: line2Hash, anchor_to: line2Hash, text: "\tif (x > 100) {" }],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(editPromise).rejects.toThrow(/E_TARGET_LOST/);
      expect(await readFile(path, "utf-8")).toBe(F2_ONLY);
    });
  });

  it("probe B: full read -> external delete f1 -> edit surviving f2 line AKU auto-rebases to line 2", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "small.cpp" },
        undefined,
        undefined,
        ctx,
      );
      const lines = anchorRows(getText(readRes));
      const line9Hash = extractHash(lines[8]!);

      await writeFile(path, F2_ONLY, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          file: "small.cpp",
          edits: [{ anchor_from: line9Hash, anchor_to: line9Hash, text: "\tif (x > 200) {" }],
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

  it("probe C: full read -> external insert 7 lines at top -> edit with AKU auto-rebases to line 16", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "small.cpp" },
        undefined,
        undefined,
        ctx,
      );
      const lines = anchorRows(getText(readRes));
      const line9Hash = extractHash(lines[8]!);

      const header = "// 1\n// 2\n// 3\n// 4\n// 5\n// 6\n// 7\n";
      await writeFile(path, header + SMALL_CPP, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          file: "small.cpp",
          edits: [{ anchor_from: line9Hash, anchor_to: line9Hash, text: "\tif (x > 300) {" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toContain("\tif (x > 300) {");
      const newLines = content.split("\n");
      expect(newLines[15]).toBe("\tif (x > 300) {");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  it("probe D: full read -> external edit inside f1 -> edit with AKU auto-rebases to line 9", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "small.cpp" },
        undefined,
        undefined,
        ctx,
      );
      const lines = anchorRows(getText(readRes));
      const line9Hash = extractHash(lines[8]!);

      const modified = SMALL_CPP.replace("\treturn -x;", "\treturn 0;");
      await writeFile(path, modified, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          file: "small.cpp",
          edits: [{ anchor_from: line9Hash, anchor_to: line9Hash, text: "\tif (x > 400) {" }],
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

  it("probe H: duplicate canons with intervening insert -> edit ccc auto-rebases to line 4", async () => {
    const fixture = "a\nb\na\n";
    await withTempFile("dup.txt", fixture, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute("r1", { file: "dup.txt" }, undefined, undefined, ctx);
      const lines = anchorRows(getText(readRes));
      const line3Hash = extractHash(lines[2]!);

      await writeFile(path, "a\nb\nd\na\n", "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          file: "dup.txt",
          edits: [{ anchor_from: line3Hash, anchor_to: line3Hash, text: "mod" }],
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

  it("probe I: multi-edit batch out-of-order auto-rebases via preceding working-buffer deltas", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await withTempFile("batch.txt", lines, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "batch.txt" },
        undefined,
        undefined,
        ctx,
      );
      const readLines = anchorRows(getText(readRes));
      const line10Hash = extractHash(readLines[9]!);
      const line50Hash = extractHash(readLines[49]!);

      const editRes = await editTool.execute(
        "e1",
        {
          file: "batch.txt",
          edits: [
            {
              anchor_from: line50Hash,
              anchor_to: line50Hash,
              text: "line 50 inserted\nline 50.1\nline 50.2\nline 50.3\nline 50.4\nline 50.5",
            },
            { anchor_from: line10Hash, anchor_to: line10Hash, text: "line 10 modified" },
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

  it("probe J: external insert strictly inside target span fails closed with E_STALE_RANGE", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join("\n") + "\n";
    await withTempFile("tear.txt", lines, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "tear.txt", windows: [{ offset: 10, limit: 11 }] },
        undefined,
        undefined,
        ctx,
      );
      const readLines = anchorRows(getText(readRes));
      const line10Hash = extractHash(readLines[0]!);
      const line20Hash = extractHash(readLines[10]!);

      const fileLines = lines.split("\n");
      fileLines.splice(12, 0, "inserted row between 12 and 13");
      const tornContent = fileLines.join("\n");
      await writeFile(path, tornContent, "utf-8");

      const editPromise = editTool.execute(
        "e1",
        {
          file: "tear.txt",
          edits: [
            { anchor_from: line10Hash, anchor_to: line20Hash, text: "replaced span 10 to 20" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(editPromise).rejects.toThrow(/E_STALE_RANGE/);
      expect(await readFile(path, "utf-8")).toBe(tornContent);
    });
  });

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
      const readRes = await readTool.execute("r1", { file: "swap.js" }, undefined, undefined, ctx);
      const readLines = anchorRows(getText(readRes));
      const alphaStartHash = extractHash(readLines[0]!);
      const alphaEndHash = extractHash(readLines[2]!);

      await writeFile(path, swapped, "utf-8");

      const editPromise = editTool.execute(
        "e1",
        {
          file: "swap.js",
          edits: [
            {
              anchor_from: alphaStartHash,
              anchor_to: alphaEndHash,
              text: "function alpha() {\n  return 'alpha-modified';\n} // end alpha",
            },
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

  it("probe L: large file 30k lines with exterior insert auto-rebases via scaled budget", async () => {
    const totalLines = 30000;
    const fileContent =
      Array.from({ length: totalLines }, (_, i) => `item_${i + 1}`).join("\n") + "\n";
    await withTempFile("large.txt", fileContent, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "large.txt", windows: [{ offset: 25000, limit: 1 }] },
        undefined,
        undefined,
        ctx,
      );
      const line25000Hash = extractHash(anchorRows(getText(readRes))[0]!);

      const drifted = "top1\ntop2\ntop3\ntop4\ntop5\n" + fileContent;
      await writeFile(path, drifted, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          file: "large.txt",
          edits: [
            { anchor_from: line25000Hash, anchor_to: line25000Hash, text: "item_25000_edited" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toContain("item_25000_edited");
      const linesAfter = content.split("\n");
      expect(linesAfter[25004]).toBe("item_25000_edited");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  }, 20000);

  it("probe M: external drift + batch chained edits auto-rebases on top of shifted baseline s'", async () => {
    const fileContent = Array.from({ length: 30 }, (_, i) => `base_${i + 1}`).join("\n") + "\n";
    await withTempFile("batch_drift.txt", fileContent, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "batch_drift.txt" },
        undefined,
        undefined,
        ctx,
      );
      const readLines = anchorRows(getText(readRes));
      const line10Hash = extractHash(readLines[9]!);
      const line15Hash = extractHash(readLines[14]!);

      const header = Array.from({ length: 7 }, (_, i) => `header_${i + 1}`).join("\n") + "\n";
      await writeFile(path, header + fileContent, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          file: "batch_drift.txt",
          edits: [
            {
              anchor_from: line10Hash,
              anchor_to: line10Hash,
              text: "base_10_ext1\next2\next3\next4\next5\next6",
            },
            { anchor_from: line15Hash, anchor_to: line15Hash, text: "base_15_modified" },
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
      expect(linesAfter[16]).toBe("base_10_ext1");
      expect(linesAfter[26]).toBe("base_15_modified");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  it("probe N: large duplicate boilerplate with exterior shift auto-rebases via rigid block shift", async () => {
    const duplicateRun = Array.from({ length: 3000 }, () => "  }").join("\n");
    const fileContent = `// unique-header\n${duplicateRun}\n// unique-footer\n`;
    await withTempFile("boilerplate.txt", fileContent, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "boilerplate.txt", windows: [{ offset: 1500, limit: 1 }] },
        undefined,
        undefined,
        ctx,
      );
      const line1500Hash = extractHash(anchorRows(getText(readRes))[0]!);

      const header = "// 1\n// 2\n// 3\n// 4\n// 5\n";
      await writeFile(path, header + fileContent, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          file: "boilerplate.txt",
          edits: [
            { anchor_from: line1500Hash, anchor_to: line1500Hash, text: "  // edited line 1500" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toContain("  // edited line 1500");
      const linesAfter = content.split("\n");
      expect(linesAfter[1504]).toBe("  // edited line 1500");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  it("re-serve upsert: drift -> re-read updates lease to new line_id -> subsequent edit succeeds", async () => {
    const original = "alpha\nbravo\ncharlie\n";
    await withTempFile("reserve.txt", original, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute("r1", { file: "reserve.txt" }, undefined, undefined, ctx);
      const lines1 = anchorRows(getText(r1));
      expect(lines1).toHaveLength(3);
      await writeFile(path, "head1\nhead2\nalpha\nbravo\ncharlie\n", "utf-8");

      const r2 = await readTool.execute("r2", { file: "reserve.txt" }, undefined, undefined, ctx);
      const lines2 = anchorRows(getText(r2));
      const bravoHash2 = extractHash(lines2[3]!);

      const editRes = await editTool.execute(
        "e1",
        {
          file: "reserve.txt",
          edits: [{ anchor_from: bravoHash2, anchor_to: bravoHash2, text: "bravo-modified" }],
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

  it("post-write failure recovery: external file content remains authoritative when store is desynced", async () => {
    const original = "row 1\nrow 2\nrow 3\n";
    await withTempFile("recover.txt", original, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute("r1", { file: "recover.txt" }, undefined, undefined, ctx);
      const row2Hash = extractHash(anchorRows(getText(r1))[1]!);

      await editTool.execute(
        "e1",
        {
          file: "recover.txt",
          edits: [{ anchor_from: row2Hash, anchor_to: row2Hash, text: "row 2 updated" }],
        },
        undefined,
        undefined,
        ctx,
      );

      await writeFile(path, "row 1\nrow 2 updated\nrow 3\nrow 4 exterior\n", "utf-8");

      const r2 = await readTool.execute("r2", { file: "recover.txt" }, undefined, undefined, ctx);
      const lines2 = anchorRows(getText(r2));
      const row2HashAfter = extractHash(lines2[1]!);

      const edit2Res = await editTool.execute(
        "e2",
        {
          file: "recover.txt",
          edits: [{ anchor_from: row2HashAfter, anchor_to: row2HashAfter, text: "row 2 final" }],
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

  it("undo usability: editing immediately using anchors from undo_last_edit succeeds without read", async () => {
    const original = "first line\nsecond line\nthird line\n";
    await withTempFile("undo_flow.txt", original, async ({ cwd, path }) => {
      const { ctx, readTool, editTool, undoTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute("r1", { file: "undo_flow.txt" }, undefined, undefined, ctx);
      const line2Hash = extractHash(anchorRows(getText(r1))[1]!);

      await editTool.execute(
        "e1",
        {
          file: "undo_flow.txt",
          edits: [{ anchor_from: line2Hash, anchor_to: line2Hash, text: "second line edited" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toContain("second line edited");

      const undoRes = await undoTool.execute(
        "u1",
        { path: "undo_flow.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe(original);

      const servedRows = undoRes.details?.servedRows;
      expect(servedRows).toBeDefined();
      expect(servedRows.length).toBeGreaterThan(0);
      const restoredLine2Hash = servedRows[1]?.hash;
      expect(restoredLine2Hash).toBeDefined();

      const edit2Res = await editTool.execute(
        "e2",
        {
          file: "undo_flow.txt",
          edits: [
            {
              anchor_from: restoredLine2Hash,
              anchor_to: restoredLine2Hash,
              text: "second line modified after undo",
            },
          ],
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

/**
 * T3 (#345): identity must survive a homogeneous duplicate run WITHOUT an intervening read, a deleted twin
 * must be tombstoned by the drifted full read that discovered it, and a clean success must omit
 * `driftNotice` instead of emitting an empty string.
 */
describe("T3 — homogeneous lineage carry, tombstones, and driftNotice shape (#345)", () => {
  const RUN_SHRUNK = "head\n  }\n  }\ntail\n";
  const RUN_FOUR = "head\n  }\n  }\n  }\n  }\ntail\n";

  it("a homogeneous shrink edit succeeds on the surviving ordinal anchor without a read", async () => {
    await withTempFile("run-shrink.txt", RUN_FOUR, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "run-shrink.txt" },
        undefined,
        undefined,
        ctx,
      );
      const firstBrace = extractHash(anchorRows(getText(readRes))[1]!);

      await writeFile(path, RUN_SHRUNK, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          file: "run-shrink.txt",
          edits: [{ anchor_from: firstBrace, anchor_to: firstBrace, text: "  } // edited" }],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe("head\n  } // edited\n  }\ntail\n");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  it("a homogeneous shrink edit on the retired overflow copy fails closed with E_TARGET_LOST", async () => {
    await withTempFile("run-shrink-overflow.txt", RUN_FOUR, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "run-shrink-overflow.txt" },
        undefined,
        undefined,
        ctx,
      );
      const fourthBrace = extractHash(anchorRows(getText(readRes))[4]!);

      await writeFile(path, RUN_SHRUNK, "utf-8");

      const editPromise = editTool.execute(
        "e1",
        {
          file: "run-shrink-overflow.txt",
          edits: [{ anchor_from: fourthBrace, anchor_to: fourthBrace, text: "  } // edited" }],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(editPromise).rejects.toThrow(/E_TARGET_LOST/);
      expect(await readFile(path, "utf-8")).toBe(RUN_SHRUNK);
    });
  });

  it("a homogeneous growth edit succeeds on a surviving ordinal anchor without a read", async () => {
    await withTempFile("run-grow.txt", RUN_SHRUNK, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { file: "run-grow.txt" },
        undefined,
        undefined,
        ctx,
      );
      const secondBrace = extractHash(anchorRows(getText(readRes))[2]!);

      await writeFile(path, RUN_FOUR, "utf-8");

      const editRes = await editTool.execute(
        "e1",
        {
          file: "run-grow.txt",
          edits: [{ anchor_from: secondBrace, anchor_to: secondBrace, text: "  } // second" }],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe("head\n  }\n  } // second\n  }\n  }\ntail\n");
      expect(getText(editRes)).toContain("Successfully edited");
    });
  });

  it("a deleted twin is tombstoned by the drifted full read and never reused", async () => {
    await withTempFile("twins.txt", "x\na\ny\na\nz\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute("r1", { file: "twins.txt" }, undefined, undefined, ctx);
      const deleted = extractHash(anchorRows(getText(r1))[1]!);

      await writeFile(path, "x\ny\na\nz\n", "utf-8");

      const r2 = await readTool.execute("r2", { file: "twins.txt" }, undefined, undefined, ctx);
      const zAnchor = extractHash(anchorRows(getText(r2))[3]!);
      const sessionKey = sessionKeyFor(ctx);
      expect([...(await loadBlockedHashes(sessionKey, path))]).toContain(deleted);

      await editTool.execute(
        "e1",
        {
          file: "twins.txt",
          edits: [{ anchor_from: zAnchor, anchor_to: zAnchor, text: "a", at: "before" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const r3 = await readTool.execute("r3", { file: "twins.txt" }, undefined, undefined, ctx);
      const twinRows = anchorRows(getText(r3)).filter((row) => row.endsWith("│a"));
      expect(twinRows).toHaveLength(2);
      for (const row of twinRows) expect(extractHash(row)).not.toBe(deleted);
    });
  });

  it("a clean success omits details.driftNotice instead of emitting an empty string", async () => {
    await withTempFile("clean.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute("r1", { file: "clean.txt" }, undefined, undefined, ctx);
      const beta = extractHash(anchorRows(getText(r1))[1]!);

      const editRes = await editTool.execute(
        "e1",
        { file: "clean.txt", edits: [{ anchor_from: beta, anchor_to: beta, text: "BETA" }] },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
      expect(
        (editRes as { details?: { driftNotice?: unknown } }).details?.driftNotice,
      ).toBeUndefined();
    });
  });

  it("an exterior content change outside the edited range still yields a non-empty drift notice", async () => {
    await withTempFile("zone3.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute("r1", { file: "zone3.txt" }, undefined, undefined, ctx);
      const alpha = extractHash(anchorRows(getText(r1))[0]!);

      await writeFile(path, "alpha\nbeta\ngamma\nDELTA\n", "utf-8");

      const editRes = await editTool.execute(
        "e1",
        { file: "zone3.txt", edits: [{ anchor_from: alpha, anchor_to: alpha, text: "ALPHA" }] },
        undefined,
        undefined,
        ctx,
      );

      const notice = (editRes as { details?: { driftNotice?: unknown } }).details?.driftNotice;
      expect(typeof notice).toBe("string");
      expect((notice as string).length).toBeGreaterThan(0);
    });
  });

  it("a survivor twin edit succeeds without an intervening drifted read, and a second turn also succeeds", async () => {
    await withTempFile("survivor-twin.txt", "x\na\ny\na\nz\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { file: "survivor-twin.txt" },
        undefined,
        undefined,
        ctx,
      );
      const rows = anchorRows(getText(r1));
      const deleted = extractHash(rows[1]!);
      const survivor = extractHash(rows[3]!);

      await writeFile(path, "x\ny\na\nz\n", "utf-8");

      const e1 = await editTool.execute(
        "e1",
        {
          file: "survivor-twin.txt",
          edits: [{ anchor_from: survivor, anchor_to: survivor, text: "A" }],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(e1)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("x\ny\nA\nz\n");
      expect(deleted).not.toBe(survivor);

      const r2 = await readTool.execute(
        "r2",
        { file: "survivor-twin.txt" },
        undefined,
        undefined,
        ctx,
      );
      const aAnchor = extractHash(anchorRows(getText(r2))[2]!);
      await editTool.execute(
        "e2",
        {
          file: "survivor-twin.txt",
          edits: [{ anchor_from: aAnchor, anchor_to: aAnchor, text: "A2" }],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe("x\ny\nA2\nz\n");
    });
  });

  it("the deleted twin anchor rejects E_TARGET_LOST through load-time alignment and leaves bytes unchanged", async () => {
    await withTempFile("deleted-twin.txt", "x\na\ny\na\nz\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { file: "deleted-twin.txt" },
        undefined,
        undefined,
        ctx,
      );
      const deleted = extractHash(anchorRows(getText(r1))[1]!);

      await writeFile(path, "x\ny\na\nz\n", "utf-8");

      await expect(
        editTool.execute(
          "e1",
          {
            file: "deleted-twin.txt",
            edits: [{ anchor_from: deleted, anchor_to: deleted, text: "A" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_TARGET_LOST/);
      expect(await readFile(path, "utf-8")).toBe("x\ny\na\nz\n");
    });
  });

  it("a homogeneous shrink accepts a second edit across turns without a re-derivation failure", async () => {
    await withTempFile("run-shrink-turns.txt", RUN_FOUR, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { file: "run-shrink-turns.txt" },
        undefined,
        undefined,
        ctx,
      );
      const rows = anchorRows(getText(r1));
      const firstBrace = extractHash(rows[1]!);
      const secondBrace = extractHash(rows[2]!);

      await writeFile(path, RUN_SHRUNK, "utf-8");

      await editTool.execute(
        "e1",
        {
          file: "run-shrink-turns.txt",
          edits: [{ anchor_from: firstBrace, anchor_to: firstBrace, text: "  } // first" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("head\n  } // first\n  }\ntail\n");

      const r2 = await readTool.execute(
        "r2",
        { file: "run-shrink-turns.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(anchorRows(getText(r2))).toHaveLength(4);

      const e2 = await editTool.execute(
        "e2",
        {
          file: "run-shrink-turns.txt",
          edits: [{ anchor_from: secondBrace, anchor_to: secondBrace, text: "  } // second" }],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(e2)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("head\n  } // first\n  } // second\ntail\n");
    });
  });
});
