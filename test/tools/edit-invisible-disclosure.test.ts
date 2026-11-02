import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { genDiff } from "../../src/edit-diff.js";
import { lineHashes } from "../../src/hashline/hash-identity.js";
import { withTempFile, setupIntegrationTest, useTestHome, getText } from "../support/fixtures";

useTestHome();

// WHY: the sub-row contract pins bytes, not shapes - every non-ASCII byte below
// WHY: is written as a unicode escape so the file stays ASCII-only and a pasted
// WHY: glyph can never silently satisfy an assertion.
const SEP = "\u2502";
const CARET = "\u25B2";
const GUTTER = `     ${SEP}`;
const CONTENT_ROW = /^[-+ ][A-Za-z0-9]{4}/;
// WHY: the pinned shape is start, one non-space, four word chars, separator -
// WHY: written with an explicit class because the linter owns string escapes;
// WHY: so the class is equivalent here, and the separator half holds by construction:
// WHY: subRowsOf selects exactly the GUTTER-prefixed lines.
const ROW_SHAPE = /^\S[A-Za-z0-9_]{4}/;
const DISCLOSURE_RE = /the replaced line had|the written line adds/;

function rowsOf(text: string): string[] {
  return text.split("\n");
}

function subRowsOf(text: string): string[] {
  return rowsOf(text).filter((line) => line.startsWith(GUTTER));
}

function bodyOf(row: string): string | undefined {
  return row.split(SEP)[1];
}

describe("edit invisible-code-point sub-rows", () => {
  it("VT substitution keeps diff rows byte-identical with the sub-row between them", async () => {
    await withTempFile("sample.ts", "a\u000Bb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\u000Bb\nccc\n", path);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "a b" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("Successfully edited");
      const lines = rowsOf(text);
      const minusIdx = lines.findIndex((row) => row.startsWith("-") && row.includes("a\u000Bb"));
      expect(minusIdx).toBeGreaterThanOrEqual(0);
      expect(bodyOf(lines[minusIdx]!)).toBe("a\u000Bb");
      // The removed sub-row sits between the minus row and the plus row.
      expect(lines[minusIdx + 1]).toBe(
        `${GUTTER} ${CARET} [col 2: U+000B LINE TABULATION removed]`,
      );
      const plus = lines[minusIdx + 2]!;
      expect(plus.startsWith("+")).toBe(true);
      expect(bodyOf(plus)).toBe("a b");
      // The plus row is clean, so no second sub-row follows it.
      expect(lines[minusIdx + 3]?.startsWith(GUTTER) ?? false).toBe(false);
      // Caret offset for column 2 is exactly one space past the gutter.
      const caretPos = lines[minusIdx + 1]!.indexOf(CARET);
      expect(caretPos - GUTTER.length).toBe(1);
      expect(await readFile(path, "utf-8")).toBe("a b\nccc\n");
      expect(text).not.toMatch(DISCLOSURE_RE);
    });
  });

  it("caret arithmetic pins columns 1, 2 and 10 with exact padding", () => {
    const atCol1 = genDiff("b\n", "\u00A0b\n", 0, ["HHHH"], ["GGGG"]);
    expect(atCol1.diff).toBe(
      `-GGGG${SEP}b\n+HHHH${SEP}\u00A0b\n${GUTTER}${CARET} [col 1: U+00A0 NO-BREAK SPACE added]`,
    );
    const atCol2 = genDiff("a\n", "a\u00A0b\n", 0, ["HHHH"], ["GGGG"]);
    expect(atCol2.diff).toBe(
      `-GGGG${SEP}a\n+HHHH${SEP}a\u00A0b\n${GUTTER} ${CARET} [col 2: U+00A0 NO-BREAK SPACE added]`,
    );
    const atCol10 = genDiff("abcdefghi\n", "abcdefghi\u00A0j\n", 0, ["HHHH"], ["GGGG"]);
    expect(atCol10.diff).toBe(
      `-GGGG${SEP}abcdefghi\n+HHHH${SEP}abcdefghi\u00A0j\n${GUTTER}         ${CARET} [col 10: U+00A0 NO-BREAK SPACE added]`,
    );
  });

  it("astral-plane character counts as one column", () => {
    const res = genDiff("abc\n", "\u{1F600}ab\u00A0c\n", 0, ["HHHH"], ["GGGG"]);
    expect(res.diff).toBe(
      `-GGGG${SEP}abc\n+HHHH${SEP}\u{1F600}ab\u00A0c\n${GUTTER}   ${CARET} [col 4: U+00A0 NO-BREAK SPACE added]`,
    );
  });

  it("multi-codepoint row renders one ordered sub-row", () => {
    const res = genDiff("a\u000Bb\u00A0c\n", "abc\n", 0, ["HHHH"], ["GGGG"]);
    expect(res.diff).toBe(
      `-GGGG${SEP}a\u000Bb\u00A0c\n${GUTTER} ${CARET} [col 2: U+000B LINE TABULATION; col 4: U+00A0 NO-BREAK SPACE removed]\n+HHHH${SEP}abc`,
    );
    expect(subRowsOf(res.diff)).toHaveLength(1);
  });

  it("long padding drops the caret but keeps the column and name", () => {
    const padded = `${"x".repeat(189)}\u00A0`;
    const res = genDiff("z\n", `${padded}\n`, 0, ["HHHH"], ["GGGG"]);
    const subs = subRowsOf(res.diff);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toBe(`${GUTTER} [col 190: U+00A0 NO-BREAK SPACE added]`);
    expect(subs[0]).not.toContain(CARET);
  });

  it("block rewrite annotates both sides with no pairing", async () => {
    await withTempFile("sample.ts", "a\u00A0\nb\u200B\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\u00A0\nb\u200B\nccc\n", path0(cwd));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[1]!, text: "c\u2000\nd\u0080" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      const lines = rowsOf(text);
      const subs = subRowsOf(text);
      const removed = subs.filter((line) => line.endsWith("removed]"));
      const added = subs.filter((line) => line.endsWith("added]"));
      expect(removed).toHaveLength(2);
      expect(added).toHaveLength(2);
      // Each side names only its own code points: no 1:1 pairing across the block.
      expect(removed.join("\n")).toContain("U+00A0 NO-BREAK SPACE");
      expect(removed.join("\n")).toContain("U+200B ZERO WIDTH SPACE");
      expect(removed.join("\n")).not.toContain("U+2000");
      expect(removed.join("\n")).not.toContain("U+0080");
      expect(added.join("\n")).toContain("U+2000 EN QUAD");
      expect(added.join("\n")).toContain("U+0080 PADDING CHARACTER");
      expect(added.join("\n")).not.toContain("U+00A0");
      expect(added.join("\n")).not.toContain("U+200B");
      // Every sub-row immediately follows its own annotated row.
      for (const sub of subs) {
        const prev = lines[lines.indexOf(sub) - 1] ?? "";
        if (sub.endsWith("removed]")) expect(prev.startsWith("-")).toBe(true);
        else expect(prev.startsWith("+")).toBe(true);
      }
      expect(text).not.toMatch(DISCLOSURE_RE);
    });
  });

  it("insertion annotates the added side only", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", path0(cwd));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [
            { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "q\u00A0r", at: "after" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      const subs = subRowsOf(text);
      expect(subs).toHaveLength(1);
      expect(subs[0]).toBe(`${GUTTER} ${CARET} [col 2: U+00A0 NO-BREAK SPACE added]`);
      expect(text).not.toContain("removed]");
      expect(text).not.toMatch(DISCLOSURE_RE);
    });
  });

  it("noop stays unchanged with no rows and no sub-rows", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path0(cwd));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("No changes made");
      expect(result.details?.diff ?? "missing").toBe("");
      expect(text).not.toContain(CARET);
      expect(subRowsOf(text)).toHaveLength(0);
      expect(text).not.toMatch(DISCLOSURE_RE);
    });
  });

  it("context rows with invisible code points get no sub-row", async () => {
    await withTempFile("sample.ts", "x\u00A0y\naaa\nbbb\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("x\u00A0y\naaa\nbbb\n", path0(cwd));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "AAA" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      const lines = rowsOf(text);
      const ctxIdx = lines.findIndex((row) => row.startsWith(" ") && row.includes("x\u00A0y"));
      expect(ctxIdx).toBeGreaterThanOrEqual(0);
      expect(bodyOf(lines[ctxIdx]!)).toBe("x\u00A0y");
      expect(lines[ctxIdx + 1]?.startsWith(GUTTER) ?? false).toBe(false);
      expect(subRowsOf(text)).toHaveLength(0);
    });
  });

  it("paste safety: content rows match disk bytes and sub-rows avoid the content-row shape", async () => {
    await withTempFile("sample.ts", "a\u000Bb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\u000Bb\nccc\n", path);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "a b" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      const onDisk = (await readFile(path, "utf-8")).split("\n");
      for (const row of rowsOf(text).filter((line) => CONTENT_ROW.test(line))) {
        expect(["a\u000Bb", ...onDisk]).toContain(bodyOf(row));
      }
      for (const sub of subRowsOf(text)) {
        expect(ROW_SHAPE.test(sub)).toBe(false);
      }
      expect(text).not.toMatch(DISCLOSURE_RE);
    });
  });

  it("warnings channel carries no disclosure pairing", async () => {
    await withTempFile("sample.ts", "a\u00A0b\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\u00A0b\n", path);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "a b" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain(CARET);
      expect(text).not.toMatch(DISCLOSURE_RE);
      const warnings = result.details?.warnings;
      if (warnings !== undefined) {
        expect(warnings.join("\n")).not.toMatch(DISCLOSURE_RE);
      }
    });
  });

  it("undo diff renders sub-rows through genDiff", async () => {
    await withTempFile("sample.ts", "a\u00A0b\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool, undoTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\u00A0b\nccc\n", path);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "a b" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const undone = await undoTool.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      const text = getText(undone);
      expect(text).toContain("Undone last edit");
      // The restored row carries the code point back, so the undo diff annotates it.
      const undoDiff = undone.details?.diff ?? "";
      expect(undoDiff).toContain(`${GUTTER} ${CARET} [col 2: U+00A0 NO-BREAK SPACE added]`);
      expect(text).not.toMatch(DISCLOSURE_RE);
      expect(await readFile(path, "utf-8")).toBe("a\u00A0b\nccc\n");
    });
  });

  it("batch applies sub-rows per changed row in file order", async () => {
    await withTempFile("sample.ts", "a\u00A0\nb\nc\u00A0\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\u00A0\nb\nc\u00A0\n", path0(cwd));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [
            { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "a" },
            { anchor_from: hashes[2]!, anchor_to: hashes[2]!, text: "c" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("Successfully edited");
      const subs = subRowsOf(text).filter((line) => line.endsWith("removed]"));
      expect(subs).toHaveLength(2);
      for (const sub of subs) {
        expect(sub).toBe(`${GUTTER} ${CARET} [col 2: U+00A0 NO-BREAK SPACE removed]`);
      }
      expect(text.indexOf(subs[0]!)).toBeLessThan(text.lastIndexOf(subs[1]!));
      expect(text).not.toMatch(DISCLOSURE_RE);
    });
  });
});

function path0(cwd: string): string {
  return `${cwd}/sample.ts`;
}
