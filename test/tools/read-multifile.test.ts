import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Compile } from "typebox/compile";
import { MAX_READ_WINDOWS, MAX_READ_WINDOWS_MESSAGE, SERVED_MAX_LINES } from "../../src/constants";
import { mergeRanges } from "../../src/file-content/line-walker";
import { loadHashStore } from "../../src/hash-store";
import { resolveTarget } from "../../src/fs-write";
import { fmtReadPreview, readToolSchema, regRead } from "../../src/read";
import { loadLeases } from "../../src/served-session";
import {
  extractHash,
  getText,
  setupIntegrationTest,
  TEST_SESSION_ID,
  testSessionManager,
  withTempDir,
  withTempFile,
} from "../support/fixtures";

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

/** One temp directory holding two files: shared fixture for the foreign-anchor lineage tests. */
async function withTwoFiles(
  a: string,
  b: string,
  run: (args: { cwd: string }) => Promise<void>,
): Promise<void> {
  await withTempFile("a.ts", a, async ({ cwd }) => {
    await writeFile(join(cwd, "b.ts"), b, "utf-8");
    await run({ cwd });
  });
}

const SIX = Array.from({ length: 6 }, (_, index) => `alpha ${index + 1}`).join("\n") + "\n";
const EIGHT = Array.from({ length: 8 }, (_, index) => `beta ${index + 1}`).join("\n") + "\n";

describe("read tool — single file", () => {
  it("reads the file of one call and serves its rows", async () => {
    await withTempFile("a.ts", SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute("r1", { file: "a.ts" }, undefined, undefined, ctx);
      const text = getText(result);
      expect(rowsOf(text)).toEqual(SIX.trimEnd().split("\n"));
    });
  });

  it("leases the file's anchors in the one transaction, so the file is editable", async () => {
    await withTempFile("b.ts", EIGHT, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { file: "b.ts" }, undefined, undefined, ctx);
      const byLine = anchorsByLine(getText(readResult));
      const edited = await editTool.execute(
        "e1",
        {
          file: "b.ts",
          edits: [
            { anchor_from: byLine.get("beta 3")!, anchor_to: byLine.get("beta 4")!, text: "X" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(edited)).toContain("Successfully edited");
      const expected =
        [
          ...EIGHT.trimEnd().split("\n").slice(0, 2),
          "X",
          "beta 5",
          "beta 6",
          "beta 7",
          "beta 8",
        ].join("\n") + "\n";
      await expect(readFile(join(cwd, "b.ts"), "utf-8")).resolves.toBe(expected);
    });
  });

  it("applies the top-level mode to the file (no per-file override exists)", async () => {
    await withTempFile("a.ts", SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "a.ts", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      // Ref: docs/.archive_adrs/0041-read-payload-flat-file-target-with-windows-and-top-level-mode.md
      expect(text).toContain(SIX.trimEnd().split("\n")[0]!);
      expect(text).not.toContain(`│${SIX.trimEnd().split("\n")[0]!}`);
      const anchorRows = text.split("\n").filter((line) => /^[A-Za-z0-9]{4}│/.test(line));
      expect(anchorRows).toHaveLength(0);
    });
  });

  it("rejects the retired `{ files: [...] }` outer shape with windows (ADR-0041 D1)", async () => {
    await withTempFile("legacy.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await expect(
        readTool.execute(
          "r1",
          { files: [{ file: "legacy.ts", windows: [{ offset: 2, limit: 2 }] }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/Schema validation failed/);
    });
  });

  it("rejects the retired bare `{ files: [...] }` outer shape (ADR-0041 D1)", async () => {
    await withTempFile("legacy.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await expect(
        readTool.execute("r1", { files: [{ file: "legacy.ts" }] }, undefined, undefined, ctx),
      ).rejects.toThrow(/Schema validation failed/);
    });
  });

  it("rejects the retired limit-only `files` shape (ADR-0041 D1)", async () => {
    await withTempFile("limit.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await expect(
        readTool.execute(
          "r1",
          { files: [{ file: "limit.ts", windows: [{ offset: 1, limit: 3 }] }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/Schema validation failed/);
    });
  });

  it("accepts the recorded `path`/`offset`/`limit` payload as one window", async () => {
    await withTempFile("aliased.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const whole = await readTool.execute("r1", { path: "aliased.ts" }, undefined, undefined, ctx);
      expect(rowsOf(getText(whole))).toHaveLength(12);

      const paged = await readTool.execute(
        "r2",
        { path: "aliased.ts", offset: 2, limit: 2 },
        undefined,
        undefined,
        ctx,
      );
      expect(rowsOf(getText(paged))).toEqual(["line 2", "line 3"]);
    });
  });

  it("treats windows: [] as omitted and reads that file from line 1", async () => {
    await withTempFile("empty-windows.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "empty-windows.ts", windows: [] },
        undefined,
        undefined,
        ctx,
      );
      expect(rowsOf(getText(result))).toHaveLength(12);
    });
  });

  it("rejects more than the window cap in one call", async () => {
    await withTempFile("a.ts", SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const seventeen = Array.from({ length: MAX_READ_WINDOWS + 1 }, (_, index) => ({
        offset: index + 1,
        limit: 1,
      }));
      await expect(
        readTool.execute("r1", { file: "a.ts", windows: seventeen }, undefined, undefined, ctx),
      ).rejects.toThrow(MAX_READ_WINDOWS_MESSAGE);
    });
  });

  it("names the window cap in one wording from the preview mirror too", async () => {
    await withTempFile("cap.ts", TWELVE, async ({ path }) => {
      const tooMany = Array.from({ length: MAX_READ_WINDOWS + 1 }, (_, index) => ({
        offset: index + 1,
        limit: 1,
      }));
      await expect(fmtReadPreview(TWELVE, { windows: tooMany }, undefined, path)).rejects.toThrow(
        MAX_READ_WINDOWS_MESSAGE,
      );
    });
  });

  it("rejects a call that names no file at all", async () => {
    await withTempFile("none.ts", SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await expect(readTool.execute("r1", {}, undefined, undefined, ctx)).rejects.toThrow(
        /Schema validation failed/,
      );
    });
  });
});

describe("read windows — interval algebra", () => {
  it("merges overlapping and contiguous ranges, keeps disjoint ones, drops empty ones", () => {
    expect(
      mergeRanges([
        { start: 0, end: 3 },
        { start: 2, end: 5 },
      ]),
    ).toEqual([{ start: 0, end: 5 }]);
    expect(
      mergeRanges([
        { start: 4, end: 6 },
        { start: 0, end: 2 },
        { start: 2, end: 4 },
      ]),
    ).toEqual([{ start: 0, end: 6 }]);
    expect(
      mergeRanges([
        { start: 10, end: 12 },
        { start: 0, end: 3 },
      ]),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 10, end: 12 },
    ]);
    expect(
      mergeRanges([
        { start: 3, end: 3 },
        { start: 1, end: 2 },
      ]),
    ).toEqual([{ start: 1, end: 2 }]);
    expect(mergeRanges([])).toEqual([]);
  });

  it("walks overlapping and contiguous windows once and still renders each window's section", async () => {
    await withTempFile("merge.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        {
          file: "merge.ts",
          windows: [
            { offset: 1, limit: 3 },
            { offset: 2, limit: 3 },
            { offset: 4, limit: 2 },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("[Lines 1-3 of 12 total]");
      expect(text).toContain("[Lines 2-4 of 12 total]");
      expect(text).toContain("[Lines 4-5 of 12 total]");
      expect(
        text.split("[Lines 2-4 of 12 total]")[1]!.split("[Lines 4-5 of 12 total]")[0]!.match(/│/g),
      ).toHaveLength(3);
      expect(rowsOf(text)).toEqual([
        "line 1",
        "line 2",
        "line 3",
        "line 2",
        "line 3",
        "line 4",
        "line 4",
        "line 5",
      ]);
    });
  });
});

describe("read windows — around_anchor", () => {
  it("expands an anchor to its line ± radius, clamped to the file", async () => {
    await withTempFile("anchored.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute(
        "r1",
        { file: "anchored.ts" },
        undefined,
        undefined,
        ctx,
      );
      const anchor = anchorsByLine(getText(served)).get("line 5")!;
      const result = await readTool.execute(
        "r2",
        { file: "anchored.ts", windows: [{ around_anchor: anchor, radius: 2 }] },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("[anchored.ts (lines 3-7 of 12 total)]");
      expect(rowsOf(text)).toEqual(["line 3", "line 4", "line 5", "line 6", "line 7"]);
    });
  });

  it("defaults radius to 10 and clamps the window to the file's bounds", async () => {
    await withTempFile("anchored.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute(
        "r1",
        { file: "anchored.ts" },
        undefined,
        undefined,
        ctx,
      );
      const anchor = anchorsByLine(getText(served)).get("line 2")!;
      const result = await readTool.execute(
        "r2",
        { file: "anchored.ts", windows: [{ around_anchor: anchor }] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("[anchored.ts (12 lines total)]");
    });
  });

  it("warns for an unknown anchor and still renders the other windows", async () => {
    await withTempFile("unknown.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "unknown.ts", windows: [{ around_anchor: "a1b2" }, { offset: 1, limit: 2 }] },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("[Window warning: Anchor 'a1b2' not found; window omitted]");
      expect(text).toContain("[unknown.ts (lines 1-2 of 12 total)]");
      expect(rowsOf(text)).toEqual(["line 1", "line 2"]);
    });
  });

  it("warns for an anchor this session served for another file, and still reads its own windows", async () => {
    await withTwoFiles(SIX, EIGHT, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute("r1", { file: "a.ts" }, undefined, undefined, ctx);
      const foreignAnchor = anchorsByLine(getText(served)).get("alpha 2")!;
      const result = await readTool.execute(
        "r2",
        { file: "b.ts", windows: [{ around_anchor: foreignAnchor }, { offset: 1, limit: 1 }] },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain(
        `[Window warning: Anchor '${foreignAnchor}' not found; window omitted]`,
      );
      expect(rowsOf(text)).toEqual(["beta 1"]);
    });
  });

  it("warns for an anchor whose line the file no longer has", async () => {
    await withTempFile("retired.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute(
        "r1",
        { file: "retired.ts" },
        undefined,
        undefined,
        ctx,
      );
      const anchor = anchorsByLine(getText(served)).get("line 9")!;
      await writeFile(join(cwd, "retired.ts"), "totally\ndifferent\ncontent\n", "utf-8");
      const result = await readTool.execute(
        "r2",
        {
          file: "retired.ts",
          windows: [{ around_anchor: anchor }, { offset: 2, limit: 1 }],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain(`[Window warning: Anchor '${anchor}' not found; window omitted]`);
      expect(rowsOf(text)).toEqual(["different"]);
    });
  });

  it("renders only the warning when every window of a file is an unresolvable anchor", async () => {
    await withTempFile("only-anchor.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "only-anchor.ts", windows: [{ around_anchor: "zzzz" }] },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toBe(
        "[only-anchor.ts (12 lines total)]\n[Window warning: Anchor 'zzzz' not found; window omitted]",
      );
    });
  });
});

describe("read payload contract", () => {
  const validator = Compile(readToolSchema);

  it("admits the flat canonical shape and refuses the retired outer shape", () => {
    expect(validator.Check({ file: "a.ts" })).toBe(true);
    expect(
      validator.Check({
        file: "a.ts",
        windows: [{ offset: 1, limit: 5 }],
        mode: "served",
      }),
    ).toBe(true);
    expect(validator.Check({ files: [{ file: "a.ts" }] })).toBe(false);
    expect(
      validator.Check({
        files: [{ file: "a.ts", windows: [{ offset: 2, limit: 5 }] }],
        mode: "served",
      }),
    ).toBe(false);
  });

  it("refuses shapes outside the contract", () => {
    expect(validator.Check({} as never)).toBe(false);
    expect(validator.Check({ file: "a.ts", windows: [{ around_anchor: "abc" }] })).toBe(false);
    expect(validator.Check({ file: "a.ts", mode: "raw" })).toBe(false);
  });

  it("rejects the retired `{ files: [...] }` outer shape at the schema (ADR-0041 D1)", () => {
    expect(validator.Check({ file: "a.ts" })).toBe(true);
    expect(validator.Check({ files: [{ file: "a.ts" }] })).toBe(false);
    expect(validator.Check({ files: [{ file: "a.ts" }, { file: "b.ts" }] })).toBe(false);
  });
});

/** The read definition as a caller holds it when it does NOT validate `parameters` first. */
interface UnvalidatedReadTool {
  execute: (
    toolCallId: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<unknown>;
}

/**
 * Captures the read definition WITHOUT the harness's schema pre-check. `makeFakePiRegistry` wraps
 * `execute` in `Compile(tool.parameters).Check` — the same order the pi runtime uses — so the
 * admission guard inside `execute` cannot be reached through `setupIntegrationTest`; this is the
 * shape a caller holds when it invokes the tool without validating `parameters` first.
 */
function unvalidatedReadTool(): UnvalidatedReadTool {
  let captured: UnvalidatedReadTool | undefined;
  regRead({
    registerTool: (tool: unknown) => {
      captured = tool as UnvalidatedReadTool;
    },
  } as never);
  if (captured === undefined) throw new Error("regRead did not register the read tool");
  return captured;
}

describe("read retired shape — the removed fan-out", () => {
  it("refuses the retired files shape through the registered tool (ADR-0041 D1)", async () => {
    await withTempDir("read-files-", async (dir) => {
      for (const name of ["a.ts", "b.ts"]) await writeFile(join(dir, name), SIX, "utf-8");
      const { ctx, readTool } = setupIntegrationTest(dir);
      const failure = await readTool
        .execute("r2", { files: [{ file: "a.ts" }, { file: "b.ts" }] }, undefined, undefined, ctx)
        .then(
          () => undefined,
          (error: Error) => error,
        );
      expect(failure?.message).toContain("Schema validation failed");
    });
  });

  it("refuses the retired files shape through the unvalidated definition, naming the field", async () => {
    await withTempDir("read-files-raw-", async (dir) => {
      for (const name of ["a.ts", "b.ts"]) await writeFile(join(dir, name), SIX, "utf-8");
      const ctx = { cwd: dir, sessionManager: testSessionManager };
      const tool = unvalidatedReadTool();
      await expect(
        tool.execute("r1", { files: [{ file: "a.ts" }] }, undefined, undefined, ctx),
      ).rejects.toThrow('Read request field "file" must be a non-empty path.');
      const flat = await tool.execute("r2", { file: "a.ts" }, undefined, undefined, ctx);
      expect(flat).toBeDefined();
    });
  });
});

/** Two hundred addressable lines: a page the read must cut and hand a continuation back for. */
const TWO_HUNDRED = Array.from({ length: 200 }, (_, index) => `row ${index + 1}`).join("\n") + "\n";

/** Above the shared auto-read budget (`AUTO_READ_MAX`), so a plain read of it is truncated. */
const TWENTY_FIVE_HUNDRED =
  Array.from({ length: 2500 }, (_, index) => `row ${index + 1}`).join("\n") + "\n";

/** Exactly the served budget in lines: it fits a call alone, so only a SHARED budget refuses it. */
const BUDGET_EXACT =
  Array.from({ length: SERVED_MAX_LINES }, (_, index) => `row ${index + 1}`).join("\n") + "\n";
describe("read render UX — headers, sub-banners and continuation footers (spec §4.4)", () => {
  it("heads the served file with its path and its total line count", async () => {
    await withTempFile("a.ts", SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute("r1", { file: "a.ts" }, undefined, undefined, ctx),
      );
      expect(text.startsWith("[a.ts (6 lines total)]\n")).toBe(true);
      expect(rowsOf(text)).toEqual(SIX.trimEnd().split("\n"));
      const rowLines = text.split("\n").filter((line) => line.includes("│"));
      expect(rowLines).toHaveLength(SIX.trimEnd().split("\n").length);
      expect(rowLines.every((line) => /^[A-Za-z0-9]{4}│/.test(line))).toBe(true);
    });
  });

  it("puts the file header above its window sub-banners, rows unnumbered", async () => {
    await withTempFile("a.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          {
            file: "a.ts",
            windows: [
              { offset: 2, limit: 2 },
              { offset: 6, limit: 2 },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text.startsWith("[a.ts (12 lines total)]\n")).toBe(true);
      expect(text).toContain("[Lines 2-3 of 12 total]\n");
      expect(text).toContain("[Lines 6-7 of 12 total]\n");
      const rowLines = text.split("\n").filter((line) => line.includes("│"));
      expect(rowLines).toHaveLength(4);
      expect(rowLines.every((line) => /^[A-Za-z0-9]{4}│/.test(line))).toBe(true);
    });
  });

  it("heads a verbatim file as verbatim with no anchors and grants it no lease", async () => {
    const readme = Array.from({ length: 45 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    await withTempFile("README.md", readme, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "README.md", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toBe(`[README.md (verbatim, 45 lines total)]\n${readme.trimEnd()}`);
      // Ref: docs/spec/search-and-read-evolution.md
      const store = await loadHashStore();
      expect(loadLeases(store, TEST_SESSION_ID, await resolveTarget(path))).toEqual([]);
    });
  });

  it("names the file a page footer continues, in the copy-pasteable 4.4 form", async () => {
    await withTempFile("app.ts", TWO_HUNDRED, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { file: "app.ts", windows: [{ offset: 1, limit: 50 }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain("[app.ts (lines 1-50 of 200 total)]");
      expect(text).not.toContain("Use windows");
    });
  });

  it("renders a canonical single-offset-window read as one 4.4 page", async () => {
    await withTempFile("app.ts", TWO_HUNDRED, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { file: "app.ts", windows: [{ offset: 1, limit: 50 }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain("[app.ts (lines 1-50 of 200 total)]");
      expect(text).not.toContain("Use windows");
      expect(text).not.toContain("[Lines ");
    });
  });

  it("reads a file exactly the served budget with no inline refusal", async () => {
    await withTempFile("exact.ts", BUDGET_EXACT, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute("r1", { file: "exact.ts" }, undefined, undefined, ctx),
      );
      expect(text).toContain("[exact.ts (lines 1-2000 of 200000 total)]\n");
      expect(text).not.toContain("[MODEL] [E_LARGE_FILE]");
    });
  });
  it("names the file in its footer when its page is cut", async () => {
    await withTempFile("a.ts", TWENTY_FIVE_HUNDRED, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute("r1", { file: "a.ts" }, undefined, undefined, ctx),
      );
      expect(text).toContain("[a.ts (lines 1-2000 of 2500 total)]");
      expect(text).not.toContain("Use windows");
    });
  });

  it("names the missing file in the call refusal", async () => {
    await withTempFile("a.ts", SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await expect(
        readTool.execute("r1", { file: "missing.ts" }, undefined, undefined, ctx),
      ).rejects.toThrow(/File not found: missing\.ts/);
    });
  });

  it("refuses a non-text file with E_UNSUPPORTED_FILE", async () => {
    await withTempFile("a.ts", SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await expect(
        readTool.execute("r1", { file: "." }, undefined, undefined, ctx),
      ).rejects.toThrow(/\[E_UNSUPPORTED_FILE\]/);
    });
  });

  it("still fails the call when its only file cannot be read", async () => {
    await withTempFile("a.ts", SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await expect(
        readTool.execute("r1", { file: "missing.ts" }, undefined, undefined, ctx),
      ).rejects.toThrow(/\[E_NOT_FOUND\]/);
    });
  });

  it("keeps the offset-past-end diagnostic byte-identical", async () => {
    await withTempFile("small.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { file: "small.ts", windows: [{ offset: 99, limit: 5 }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain(
        "Offset 99 is beyond end of file (12 lines total). Use offset=1 to read from the start, or offset=12 to read the last line.",
      );
    });
  });

  it("keeps the oversized-line diagnostic byte-identical", async () => {
    const wide = ["a", "W".repeat(210_000), "b"].join("\n") + "\n";
    await withTempFile("wide.ts", wide, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute("r1", { file: "wide.ts" }, undefined, undefined, ctx),
      );
      expect(text).toContain(
        "[Line 2 is 205.1KB, exceeds 50.0KB; content not shown. Use bash: sed -n '2p' <path> | head -c 51200]",
      );
      expect(text).toContain(
        "[Line 2 exceeds 50.0KB; content not shown because hashline anchors require full lines. Inspect with bash: sed -n '2p' <path> | head -c 51200]",
      );
    });
  });
});

/**
 * Tranche-3 remediation. Each test fails against the pre-remediation tree, and for a different
 * reason: FIX 1 rejects with `Cannot read properties of undefined (reading 'db')`, FIX 2 renders the
 * file the call-wide budget cannot afford, FIX 3 rejects the whole call after every row was rendered.
 */
describe("read tool — remediation (verbatim anchor windows, shared budget, mirror)", () => {
  it("warns when a verbatim-only call names an anchor window instead of crashing", async () => {
    await withTempFile("plain.txt", TWELVE, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "plain.txt", windows: [{ around_anchor: "a1b2" }], mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toBe(
        "[plain.txt (verbatim, 12 lines total)]\n" +
          "[Window warning: Anchor 'a1b2' not found; window omitted]",
      );
      const store = await loadHashStore();
      expect(loadLeases(store, TEST_SESSION_ID, await resolveTarget(path))).toEqual([]);
    });
  });

  it("resolves a genuinely served anchor for a verbatim-only call and grants no new lease", async () => {
    await withTempFile("plain.txt", TWELVE, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute("s1", { file: "plain.txt" }, undefined, undefined, ctx);
      const anchor = anchorsByLine(getText(served)).get("line 3")!;
      const absolute = await resolveTarget(path);
      const store = await loadHashStore();
      const before = loadLeases(store, TEST_SESSION_ID, absolute);
      expect(before.length).toBeGreaterThan(0);

      const verbatim = await readTool.execute(
        "v1",
        { file: "plain.txt", windows: [{ around_anchor: anchor }], mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      // Ref: docs/spec/search-and-read-evolution.md
      expect(getText(verbatim)).toBe(`[plain.txt (verbatim, 12 lines total)]\n${TWELVE.trimEnd()}`);
      expect(loadLeases(store, TEST_SESSION_ID, absolute)).toEqual(before);
    });
  });

  it("renders a verbatim anchor window against the file's own served lineage", async () => {
    await withTempFile("plain.txt", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute("s1", { file: "plain.txt" }, undefined, undefined, ctx);
      const anchor = anchorsByLine(getText(served)).get("line 3")!;
      const text = getText(
        await readTool.execute(
          "v1",
          { file: "plain.txt", mode: "verbatim", windows: [{ around_anchor: anchor, radius: 1 }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain(
        "[plain.txt (verbatim, lines 2-4 of 12 total)]\nline 2\nline 3\nline 4",
      );
    });
  });

  it("still warns when a verbatim target names an anchor this session served for another file", async () => {
    await withTwoFiles(SIX, TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute("s1", { file: "a.ts" }, undefined, undefined, ctx);
      const foreign = anchorsByLine(getText(served)).get("alpha 2")!;
      const text = getText(
        await readTool.execute(
          "v1",
          { file: "b.ts", windows: [{ around_anchor: foreign }], mode: "verbatim" },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toBe(
        "[b.ts (verbatim, 12 lines total)]\n" +
          `[Window warning: Anchor '${foreign}' not found; window omitted]`,
      );
    });
  });

  it("warns when a lone file switches itself to verbatim and names an anchor window", async () => {
    await withTempFile("plain.txt", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "plain.txt", mode: "verbatim", windows: [{ around_anchor: "a1b2" }] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toBe(
        "[plain.txt (verbatim, 12 lines total)]\n" +
          "[Window warning: Anchor 'a1b2' not found; window omitted]",
      );
    });
  });

  it("resolves the served anchor window while an unknown anchor warns alone", async () => {
    await withTempFile("a.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute("s1", { file: "a.ts" }, undefined, undefined, ctx);
      const anchor = anchorsByLine(getText(served)).get("line 4")!;

      const text = getText(
        await readTool.execute(
          "r1",
          {
            file: "a.ts",
            windows: [{ around_anchor: anchor, radius: 1 }, { around_anchor: "a1b2" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain("[a.ts (lines 3-5 of 12 total)]\n");
      expect(text).toContain("[Window warning: Anchor 'a1b2' not found; window omitted]");
      expect(rowsOf(text)).toEqual(["line 3", "line 4", "line 5"]);
    });
  });

  it("fails a lone file over the budget with the pre-existing E_LARGE_FILE wording", async () => {
    const overBudget =
      Array.from({ length: SERVED_MAX_LINES + 1 }, (_, index) => `row ${index + 1}`).join("\n") +
      "\n";
    await withTempFile("huge.ts", overBudget, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await expect(
        readTool.execute("r1", { file: "huge.ts" }, undefined, undefined, ctx),
      ).rejects.toThrow(
        `[E_LARGE_FILE] huge.ts has more than ${SERVED_MAX_LINES} lines, exceeding the ${SERVED_MAX_LINES}-line edit limit.`,
      );
    });
  });

  it("fails the call when the mirror phase throws for the lone file", async () => {
    await withTempFile("a.ts", SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const sessions = await import("../../src/served-session");
      const realSessionFromContext = sessions.sessionFromContext;
      const mirrorSpy = vi
        .spyOn(sessions, "sessionFromContext")
        .mockImplementation((sessionCtx, path) => {
          const handle = realSessionFromContext(sessionCtx, path);
          return {
            ...handle,
            recordEpoch: async () => {
              throw new Error("mirror phase boom");
            },
          };
        });
      try {
        await expect(
          readTool.execute("r1", { file: "a.ts" }, undefined, undefined, ctx),
        ).rejects.toThrow("mirror phase boom");
      } finally {
        mirrorSpy.mockRestore();
      }
    });
  });
});
