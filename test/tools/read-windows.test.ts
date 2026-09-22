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
    .filter((line) => /^[A-Za-z0-9]{3}│/.test(line))
    .map((line) => line.split("│")[1]!);
}

function anchorsByLine(text: string): Map<string, string> {
  const rows = text.split("\n").filter((line) => /^[A-Za-z0-9]{3}│/.test(line));
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
    expect(result.text).toContain("=== Lines 1-2 of 12 ===");
    expect(result.text).toContain("=== Lines 10-11 of 12 ===");
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
    expect(result.text).toContain("=== Lines 1-3 of 12 ===");
    expect(result.text).toContain("=== Lines 2-4 of 12 ===");
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
    expect(result.text).toContain("=== Lines 11-12 of 12 ===");
    expect(result.served.map((row) => row.position)).toEqual([10, 11]);
    // WHY: a window that fit the shared budget is not a truncated result, so no metadata is owed.
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
    // WHY: a window past EOF has no line range to name, so its section carries the message alone.
    expect(result.text).not.toContain("=== Lines 99");
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
    // WHY: the budget really did cut a requested window away, so the tool owes truncated: true.
    expect(result.truncation?.truncated).toBe(true);
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
    expect(windowed.text).toContain("exceeds 200B");
    expect(windowed.text).toContain("│short two");
    // WHY: the window named lines 1-2; "use offset=3 to continue" would offer a page it never asked for.
    expect(windowed.text).not.toContain("to continue");
    expect(windowed.nextOffset).toBeUndefined();

    // The same range read alone IS a page, so the hint is still owed there.
    const single = await fmtReadPreview(
      content,
      { offset: 1, limit: 2 },
      undefined,
      home.testPath,
      200,
      100,
    );
    expect(single.text).toContain("to continue");
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
          path: "windows.ts",
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
      // Both anchors come from different windows: the leases granted by one read must cover them.
      const edited = await editTool.execute(
        "e1",
        { path: "windows.ts", edits: [[byLine.get("line 1")!, byLine.get("line 12")!, "X"]] },
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
          path: "overlap.ts",
          windows: [
            { offset: 1, limit: 3 },
            { offset: 2, limit: 3 },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(readResult)).toContain("=== Lines 1-3 of 12 ===");
      const byLine = anchorsByLine(getText(readResult));
      // Lines 2-3 appear in both windows; their anchors must resolve against the lease granted once.
      const edited = await editTool.execute(
        "e1",
        { path: "overlap.ts", edits: [[byLine.get("line 2")!, byLine.get("line 3")!, "X"]] },
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

      await session.markDriftReported(["abc"]);
      await readTool.execute(
        "r1",
        { path: "empty-windows.ts", windows: [] },
        undefined,
        undefined,
        ctx,
      );
      // An empty array falls back to a full read, so it owes the full-read contract: drift cleared.
      expect(await session.driftReported()).toEqual(new Set());

      await session.markDriftReported(["abc"]);
      await readTool.execute(
        "r2",
        { path: "empty-windows.ts", offset: 1, limit: 2 },
        undefined,
        undefined,
        ctx,
      );
      expect(await session.driftReported()).toEqual(new Set(["abc"]));
    });
  });

  it("leaves a plain offset/limit read unchanged", async () => {
    await withTempFile("plain.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { path: "plain.ts", offset: 2, limit: 2 },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).not.toContain("=== Lines");
      expect(rowsOf(text)).toEqual(["line 2", "line 3"]);
    });
  });
});
