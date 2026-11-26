import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MAX_READ_WINDOWS } from "../../src/constants";
import { fmtReadPreview } from "../../src/read";
import { sessionFromContext } from "../../src/served-session/index";
import {
  extractHash,
  getText,
  setupIntegrationTest,
  useTestHome,
  withTempFile,
} from "../support/fixtures";

const home = useTestHome();

/** Twelve addressable lines, so two windows can sit far apart without touching. */
const TWELVE = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

function rowsOf(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^[A-Za-z0-9]{4}│/.test(line))
    .map((line) => line.split("│")[1]!);
}

function anchorsByLine(text: string): Map<string, string> {
  const rows = text.split("\n").filter((line) => /^[A-Za-z0-9]{4}│/.test(line));
  return new Map(rows.map((row) => [row.split("│")[1]!, extractHash(row)]));
}

describe("fmtReadPreview — windows", () => {
  it("renders each window under its own header and serves exactly its rows", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      {
        windows: [
          { offset: 1, limit: 2 },
          { offset: 10, limit: 2 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("[Lines 1-2 of 12 total]");
    expect(result.text).toContain("[Lines 10-11 of 12 total]");
    expect(rowsOf(result.text)).toEqual(["line 1", "line 2", "line 10", "line 11"]);
    expect(result.served.map((row) => row.position)).toEqual([0, 1, 9, 10]);
  });

  it("collapses overlapping windows to one served row per line", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      {
        windows: [
          { offset: 1, limit: 3 },
          { offset: 2, limit: 3 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("[Lines 1-3 of 12 total]");
    expect(result.text).toContain("[Lines 2-4 of 12 total]");
    const positions = result.served.map((row) => row.position);
    expect(positions).toEqual([0, 1, 2, 3]);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("keeps the file-scoped continuation hint out of window sections", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      { windows: [{ offset: 1, limit: 2 }] },
      undefined,
      home.testPath,
    );
    expect(result.text).not.toContain("to continue");
    expect(result.nextOffset).toBeUndefined();
  });

  it("clamps a window's limit at end of file", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      { windows: [{ offset: 11, limit: 50 }] },
      undefined,
      home.testPath,
    );
    expect(result.text).not.toContain("[Lines ");
    expect(result.shownRange).toEqual({ startLine: 11, endLine: 12 });
    expect(result.served.map((row) => row.position)).toEqual([10, 11]);
    expect(result.truncation).toBeUndefined();
  });

  it("reports a window past end of file without serving it", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      {
        windows: [
          { offset: 99, limit: 2 },
          { offset: 1, limit: 1 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("Offset 99 is beyond end of file (12 lines total)");
    expect(result.text).not.toContain("[Lines 99");
    expect(result.served.map((row) => row.position)).toEqual([0]);
  });

  it("spends one shared budget across every window", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      {
        windows: [
          { offset: 1, limit: 3 },
          { offset: 10, limit: 2 },
        ],
      },
      undefined,
      home.testPath,
      400,
      3,
    );
    expect(result.text).toContain("[Read budget exhausted; this window is not shown.");
    expect(result.served.map((row) => row.position)).toEqual([0, 1, 2]);
    expect(result.truncation?.truncated).toBe(true);
    expect(result.nextOffset).toBeUndefined();
  });

  it("reports a truncated window without offering a root pagination offset", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      { windows: [{ offset: 1, limit: 6 }] },
      undefined,
      home.testPath,
      400,
      2,
    );
    expect(result.truncation?.truncated).toBe(true);
    expect(result.text).not.toContain("to continue");
    expect(result.nextOffset).toBeUndefined();
  });

  it("names a lines-truncated section by the rows it showed, not the rows it asked for", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      {
        windows: [
          { offset: 1, limit: 2 },
          { offset: 5, limit: 2 },
        ],
      },
      undefined,
      home.testPath,
      400,
      3,
    );
    expect(result.text).toContain("[Lines 1-2 of 12 total]");
    expect(result.text).toContain("[Lines 5-5 of 12 total]");
    expect(result.text).not.toContain("[Lines 5-6");
    expect(result.served.map((row) => row.position)).toEqual([0, 1, 4]);
  });

  it("treats an empty windows array as no windows", async () => {
    const result = await fmtReadPreview(TWELVE, { windows: [] }, undefined, home.testPath);
    expect(result.served).toHaveLength(12);
  });

  it("keeps an oversized window from leaking a continuation hint", async () => {
    const content = `${"x".repeat(500)}\nshort two\nshort three\nshort four\n`;
    const windowed = await fmtReadPreview(
      content,
      { windows: [{ offset: 1, limit: 2 }] },
      undefined,
      home.testPath,
      200,
      100,
    );
    expect(windowed.text).toContain("exceeds the 200B limit");
    expect(windowed.text).toContain("│short two");
    expect(windowed.text).not.toContain("to continue");
    expect(windowed.nextOffset).toBeUndefined();

    const single = await fmtReadPreview(
      content,
      { offset: 1, limit: 2 },
      undefined,
      home.testPath,
      200,
      100,
    );
    expect(single.shownRange).toEqual({ startLine: 1, endLine: 2 });
    expect(single.nextOffset).toBe(3);
  });

  it("prefers windows over offset/limit when both are given", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      { offset: 5, limit: 5, windows: [{ offset: 1, limit: 1 }] },
      undefined,
      home.testPath,
    );
    expect(result.served.map((row) => row.position)).toEqual([0]);
  });

  it("rejects a window field that is not a positive integer", async () => {
    await expect(
      fmtReadPreview(TWELVE, { windows: [{ offset: 0, limit: 2 }] }, undefined, home.testPath),
    ).rejects.toThrow("positive integer");
    await expect(
      fmtReadPreview(TWELVE, { windows: [{ offset: 1 }] } as never, undefined, home.testPath),
    ).rejects.toThrow('"windows[0].limit"');
  });

  it("rejects more windows than the tool accepts", async () => {
    const tooMany = Array.from({ length: MAX_READ_WINDOWS + 1 }, (_, index) => ({
      offset: index + 1,
      limit: 1,
    }));
    await expect(
      fmtReadPreview(TWELVE, { windows: tooMany }, undefined, home.testPath),
    ).rejects.toThrow(`at most ${MAX_READ_WINDOWS} windows`);
  });
});

describe("read tool — windows", () => {
  it("serves anchors from every window so one edit can span them", async () => {
    await withTempFile("windows.ts", TWELVE, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute(
        "r1",
        {
          file: "windows.ts",
          windows: [
            { offset: 1, limit: 2 },
            { offset: 11, limit: 2 },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      const byLine = anchorsByLine(getText(readResult));
      const edited = await editTool.execute(
        "e1",
        {
          file: "windows.ts",
          edits: [
            { anchor_from: byLine.get("line 1")!, anchor_to: byLine.get("line 12")!, text: "X" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(edited)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("X\n");
    });
  });

  it("leases a line shared by two windows once", async () => {
    await withTempFile("overlap.ts", TWELVE, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute(
        "r1",
        {
          file: "overlap.ts",
          windows: [
            { offset: 1, limit: 3 },
            { offset: 2, limit: 3 },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(readResult)).toContain("[Lines 1-3 of 12 total]");
      const byLine = anchorsByLine(getText(readResult));
      const edited = await editTool.execute(
        "e1",
        {
          file: "overlap.ts",
          edits: [
            { anchor_from: byLine.get("line 2")!, anchor_to: byLine.get("line 3")!, text: "X" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(edited)).toContain("Successfully edited");
      const expected = ["line 1", "X", ...TWELVE.trimEnd().split("\n").slice(3)].join("\n") + "\n";
      expect(await readFile(path, "utf-8")).toBe(expected);
    });
  });

  it("treats windows: [] as a full read and a partial read as not", async () => {
    await withTempFile("empty-windows.ts", TWELVE, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const session = sessionFromContext(ctx, path);

      await session.markDriftReported(["abcc"]);
      await readTool.execute(
        "r1",
        { file: "empty-windows.ts", windows: [] },
        undefined,
        undefined,
        ctx,
      );
      expect(await session.driftReported()).toEqual(new Set());

      await session.markDriftReported(["abcc"]);
      await readTool.execute(
        "r2",
        { file: "empty-windows.ts", windows: [{ offset: 1, limit: 2 }] },
        undefined,
        undefined,
        ctx,
      );
      expect(await session.driftReported()).toEqual(new Set(["abcc"]));
    });
  });

  it("leaves a plain offset/limit read unchanged", async () => {
    await withTempFile("plain.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "plain.ts", windows: [{ offset: 2, limit: 2 }] },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).not.toContain("[Lines ");
      expect(rowsOf(text)).toEqual(["line 2", "line 3"]);
    });
  });
});

describe("fmtReadPreview — windows share one budget without shrinking the line cap", () => {
  const CAP = 400;
  const LINES = 1000;

  it("omits a window its first recoverable row cannot fit, and still renders a later small one", async () => {
    const content = ["x".repeat(200), "y".repeat(200), "line 3", "line 4"].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 2, limit: 1 },
          { offset: 3, limit: 2 },
        ],
      },
      undefined,
      home.testPath,
      CAP,
      LINES,
    );
    expect(result.text).toContain("[Lines 1-1 of 4 total]");
    expect(result.text).toContain(
      "[Window does not fit in the remaining 170B read budget; not shown. Re-read it on its own.]",
    );
    expect(result.text).not.toContain("[Line 2: ");
    expect(result.text).not.toContain("exceeds the");
    expect(result.text).toContain("[Lines 3-4 of 4 total]");
    expect(result.text).toContain("│line 3");
    expect(result.served.map((row) => row.position)).toEqual([0, 2, 3]);
    expect(result.truncation?.truncated).toBe(true);
    expect(result.truncation?.truncatedBy).toBe("bytes");
  });

  it("stops a window mid-way at the remaining budget and says so in its header only", async () => {
    const content = ["x".repeat(200), "line 2", "y".repeat(199), "line 4"].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 2, limit: 2 },
          { offset: 4, limit: 1 },
        ],
      },
      undefined,
      home.testPath,
      CAP,
      LINES,
    );
    expect(result.text).toContain("[Lines 2-2 of 4 total; stopped at 170B]");
    expect(result.text).toContain("│line 2");
    expect(result.text).not.toContain("[Line 3: ");
    expect(result.text).not.toContain("exceeds the");
    expect(result.text).toContain("[Lines 4-4 of 4 total]");
    expect(result.served.map((row) => row.position)).toEqual([0, 1, 3]);
    expect(result.truncation?.truncatedBy).toBe("bytes");
  });

  it("cites the intrinsic line cap, not the shrunken budget, for a later oversized line", async () => {
    const content = ["x".repeat(200), "y".repeat(500), "line 3"].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 2, limit: 1 },
        ],
      },
      undefined,
      home.testPath,
      CAP,
      LINES,
    );
    expect(result.text).toContain("[Line 2: 507B; not shown.]");
    expect(result.text).toContain("[Line 2 exceeds the 400B limit; the read tool cannot show it.]");
    expect(result.text).not.toContain("170B limit");
    expect(result.served.map((row) => row.position)).toEqual([0]);
  });

  it("omits a mixed window whose leading recoverable row misses the budget, without warning", async () => {
    const content = ["x".repeat(200), "y".repeat(199), "z".repeat(500)].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 2, limit: 2 },
        ],
      },
      undefined,
      home.testPath,
      CAP,
      LINES,
    );
    expect(result.text).toContain(
      "[Window does not fit in the remaining 170B read budget; not shown. Re-read it on its own.]",
    );
    expect(result.text).not.toContain("exceeds the");
    expect(result.text).not.toContain("[Line 2: ");
    expect(result.text).not.toContain("[Line 3: ");
    expect(result.served.map((row) => row.position)).toEqual([0]);
    expect(result.truncation?.truncated).toBe(true);
  });
});
