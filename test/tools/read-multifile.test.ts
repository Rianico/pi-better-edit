import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Compile } from "typebox/compile";
import {
  MAX_READ_FILES,
  MAX_READ_FILES_MESSAGE,
  MAX_READ_WINDOWS,
  MAX_READ_WINDOWS_MESSAGE,
  SERVED_MAX_LINES,
} from "../../src/constants";
import { mergeRanges } from "../../src/file-content/line-walker";
import { loadHashStore } from "../../src/hash-store";
import { resolveTarget } from "../../src/fs-write";
import { fmtReadPreview, readToolSchema, regRead } from "../../src/read";
import { getServed, loadLeases } from "../../src/served-session";
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

/** One temp directory holding two files: the multi-file read's own fixture shape. */
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

describe("read tool — multi-file", () => {
  it("reads every file of one call and serves each file's rows", async () => {
    await withTwoFiles(SIX, EIGHT, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { files: [{ file: "a.ts" }, { file: "b.ts" }] },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(rowsOf(text)).toEqual([...SIX.trimEnd().split("\n"), ...EIGHT.trimEnd().split("\n")]);
      // WHY: one call, one result — so no single-file root offset or snapshotId is owed.
      expect(result.details.nextOffset).toBeUndefined();
      expect(result.details.snapshotId).toBeUndefined();
    });
  });

  it("leases every file's anchors in the one transaction, so either file is editable", async () => {
    await withTwoFiles(SIX, EIGHT, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute(
        "r1",
        { files: [{ file: "a.ts" }, { file: "b.ts" }] },
        undefined,
        undefined,
        ctx,
      );
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

  it("lets a per-file mode override the top-level mode", async () => {
    await withTwoFiles(SIX, EIGHT, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { mode: "verbatim", files: [{ file: "a.ts" }, { file: "b.ts", mode: "served" }] },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      // The served file keeps HASH│ rows; the verbatim file renders plain text.
      const anchorRows = text.split("\n").filter((line) => /^[A-Za-z0-9]{4}│/.test(line));
      expect(anchorRows.map((row) => row.split("│")[1])).toEqual(EIGHT.trimEnd().split("\n"));
      expect(text).toContain(SIX.trimEnd().split("\n")[0]!);
      expect(text).not.toContain(`│${SIX.trimEnd().split("\n")[0]!}`);
    });
  });

  it("folds a legacy { file, offset, limit } call into one window of that file", async () => {
    await withTempFile("legacy.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const legacy = await readTool.execute(
        "r1",
        { file: "legacy.ts", offset: 2, limit: 2 },
        undefined,
        undefined,
        ctx,
      );
      const explicit = await readTool.execute(
        "r2",
        { files: [{ file: "legacy.ts", windows: [{ offset: 2, limit: 2 }] }] },
        undefined,
        undefined,
        ctx,
      );
      // WHY: both shapes are the SAME window, so both serve exactly lines 2-3 (the legacy shape keeps
      // WHY: the page chrome §4.4 will replace; the rows are what "folded" has to mean).
      expect(rowsOf(getText(legacy))).toEqual(["line 2", "line 3"]);
      expect(rowsOf(getText(explicit))).toEqual(["line 2", "line 3"]);
      expect(getText(explicit)).toContain("=== Lines 2-3 of 12 ===");
    });
  });

  it("folds a legacy limit-only call into a window from line 1", async () => {
    await withTempFile("limit.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "limit.ts", limit: 3 },
        undefined,
        undefined,
        ctx,
      );
      expect(rowsOf(getText(result))).toEqual(["line 1", "line 2", "line 3"]);
    });
  });

  it("folds a legacy `path` alias onto `file` (spec §4.2)", async () => {
    await withTempFile("aliased.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const byPath = await readTool.execute(
        "r1",
        { path: "aliased.ts" },
        undefined,
        undefined,
        ctx,
      );
      const paged = await readTool.execute(
        "r2",
        { path: "aliased.ts", offset: 2, limit: 2 },
        undefined,
        undefined,
        ctx,
      );
      // WHY: §4.2's fold snippet reads `legacy.file ?? legacy.path`; gating the fold on `file` alone
      // WHY: left the published alias refused outright — an advertised-but-dead surface.
      expect(rowsOf(getText(byPath))).toEqual(TWELVE.trimEnd().split("\n"));
      expect(rowsOf(getText(paged))).toEqual(["line 2", "line 3"]);
    });
  });

  it("treats windows: [] as omitted and reads that file from line 1", async () => {
    await withTempFile("empty-windows.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { files: [{ file: "empty-windows.ts", windows: [] }] },
        undefined,
        undefined,
        ctx,
      );
      expect(rowsOf(getText(result))).toHaveLength(12);
    });
  });

  it("rejects more than the window cap across all files of one call", async () => {
    await withTwoFiles(SIX, EIGHT, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const nine = Array.from({ length: 9 }, (_, index) => ({ offset: index + 1, limit: 1 }));
      const eight = Array.from({ length: 8 }, (_, index) => ({ offset: index + 1, limit: 1 }));
      expect(nine.length + eight.length).toBeGreaterThan(MAX_READ_WINDOWS);
      await expect(
        readTool.execute(
          "r1",
          {
            files: [
              { file: "a.ts", windows: nine },
              { file: "b.ts", windows: eight },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(`at most ${MAX_READ_WINDOWS} windows across all files`);
    });
  });

  it("names the window cap in one wording from the preview mirror too", async () => {
    await withTempFile("cap.ts", TWELVE, async ({ path }) => {
      const tooMany = Array.from({ length: MAX_READ_WINDOWS + 1 }, (_, index) => ({
        offset: index + 1,
        limit: 1,
      }));
      // WHY: the registered schema (`maxItems`) and admission both name this cap, and the preview's
      // WHY: runtime mirror is what a DIRECT `fmtReadPreview` caller hits — so the mirror must use the
      // WHY: same message, not a third spelling of the same limit.
      await expect(fmtReadPreview(TWELVE, { windows: tooMany }, undefined, path)).rejects.toThrow(
        MAX_READ_WINDOWS_MESSAGE,
      );
    });
  });

  it("rejects a call that names no file at all", async () => {
    await withTempFile("none.ts", SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await expect(readTool.execute("r1", {}, undefined, undefined, ctx)).rejects.toThrow(
        /at least one file/,
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
          files: [
            {
              file: "merge.ts",
              windows: [
                { offset: 1, limit: 3 },
                { offset: 2, limit: 3 },
                { offset: 4, limit: 2 },
              ],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("=== Lines 1-3 of 12 ===");
      expect(text).toContain("=== Lines 2-4 of 12 ===");
      expect(text).toContain("=== Lines 4-5 of 12 ===");
      // WHY: a shared or abutting line is retained once by the merged walk and still belongs to every
      // WHY: window that named it, so the rows of each section stay exactly what it asked for.
      expect(
        text.split("=== Lines 2-4 of 12 ===")[1]!.split("=== Lines 4-5 of 12 ===")[0]!.match(/│/g),
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
        { files: [{ file: "anchored.ts", windows: [{ around_anchor: anchor, radius: 2 }] }] },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("=== Lines 3-7 of 12 ===");
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
        { files: [{ file: "anchored.ts", windows: [{ around_anchor: anchor }] }] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("=== Lines 1-12 of 12 ===");
    });
  });

  it("warns for an unknown anchor and still renders the sibling windows", async () => {
    await withTempFile("unknown.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        {
          files: [
            {
              file: "unknown.ts",
              windows: [{ around_anchor: "a1b2" }, { offset: 1, limit: 2 }],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("[Window warning: Anchor 'a1b2' not found; window omitted]");
      expect(text).toContain("=== Lines 1-2 of 12 ===");
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
        {
          files: [
            { file: "b.ts", windows: [{ around_anchor: foreignAnchor }, { offset: 1, limit: 1 }] },
          ],
        },
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
      // WHY: the file is replaced wholesale, so the served line's identity has no coordinate in the
      // WHY: new content — the lease is retired and the window is omitted instead of guessing a line.
      await writeFile(join(cwd, "retired.ts"), "totally\ndifferent\ncontent\n", "utf-8");
      const result = await readTool.execute(
        "r2",
        {
          files: [
            {
              file: "retired.ts",
              windows: [{ around_anchor: anchor }, { offset: 2, limit: 1 }],
            },
          ],
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
        { files: [{ file: "only-anchor.ts", windows: [{ around_anchor: "zzzz" }] }] },
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

  it("admits the new files shape and the legacy single-file shapes", () => {
    expect(validator.Check({ files: [{ file: "a.ts" }] })).toBe(true);
    expect(
      validator.Check({
        files: [
          { file: "a.ts", windows: [{ offset: 1, limit: 5 }] },
          {
            file: "b.ts",
            windows: [{ around_anchor: "a1b2", radius: 3 }],
            mode: "verbatim",
          },
        ],
        mode: "served",
      }),
    ).toBe(true);
    expect(validator.Check({ file: "a.ts" })).toBe(true);
    expect(validator.Check({ file: "a.ts", offset: 2, limit: 5 })).toBe(true);
    expect(validator.Check({ file: "a.ts", windows: [{ offset: 2, limit: 5 }] })).toBe(true);
  });

  it("refuses shapes outside the contract", () => {
    expect(validator.Check({ files: [] })).toBe(false);
    expect(
      validator.Check({ files: [{ file: "a.ts", windows: [{ around_anchor: "abc" }] }] }),
    ).toBe(false);
    expect(
      validator.Check({
        files: [
          {
            file: "a.ts",
            windows: Array.from({ length: MAX_READ_WINDOWS + 1 }, (_, index) => ({
              offset: index + 1,
              limit: 1,
            })),
          },
        ],
      }),
    ).toBe(false);
  });

  it("caps the files array at MAX_READ_FILES", () => {
    const many = Array.from({ length: MAX_READ_FILES + 1 }, (_, index) => ({
      file: `f${index}.ts`,
    }));
    expect(validator.Check({ files: many.slice(0, MAX_READ_FILES) })).toBe(true);
    expect(validator.Check({ files: many })).toBe(false);
    // WHY: the `maxItems` limit is what the runtime builds its structural refusal wording from, so
    // WHY: pinning it to the constant admission reads keeps the two enforcement points from
    // WHY: drifting apart without a test noticing.
    expect(validator.Errors({ files: many })[0]).toMatchObject({
      keyword: "maxItems",
      params: { limit: MAX_READ_FILES },
    });
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

describe("read files — the fan-out cap", () => {
  it("admits exactly the cap and refuses one more through the registered tool", async () => {
    await withTempDir("read-files-", async (dir) => {
      const names = Array.from({ length: MAX_READ_FILES + 1 }, (_, index) => `f${index}.ts`);
      for (const name of names) await writeFile(join(dir, name), SIX, "utf-8");
      const { ctx, readTool } = setupIntegrationTest(dir);
      const target = (file: string) => ({ file });
      const atCap = await readTool.execute(
        "r1",
        { files: names.slice(0, MAX_READ_FILES).map(target) },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(atCap)).toContain(`[${names[0]}`);
      // WHY: MEASURED — the refusal a >cap call hits on this path is the registered schema's, raised
      // WHY: BEFORE `execute` runs, so the wording is the validator's structural message built from
      // WHY: `maxItems: MAX_READ_FILES` and never `MAX_READ_FILES_MESSAGE`. The divergence is by
      // WHY: construction (a validator generates its own message), so it is pinned here instead of
      // WHY: being papered over; the guard below is the backstop for a caller that skips the schema.
      const failure = await readTool
        .execute("r2", { files: names.map(target) }, undefined, undefined, ctx)
        .then(
          () => undefined,
          (error: Error) => error,
        );
      expect(failure?.message).toContain(`must not have more than ${MAX_READ_FILES} items`);
      expect(failure?.message).not.toContain(MAX_READ_FILES_MESSAGE);
    });
  });

  it("refuses one more through the unvalidated definition, naming the cap in the shared wording", async () => {
    await withTempDir("read-files-raw-", async (dir) => {
      const names = Array.from({ length: MAX_READ_FILES + 1 }, (_, index) => `f${index}.ts`);
      for (const name of names) await writeFile(join(dir, name), SIX, "utf-8");
      const ctx = { cwd: dir, sessionManager: testSessionManager };
      const tool = unvalidatedReadTool();
      // WHY: without the schema in front, admission is the only thing keeping the cap true — and it
      // WHY: names the limit in the one shared wording, which is what a mirror (if one were ever
      // WHY: added) would reuse.
      await expect(
        tool.execute("r1", { files: names.map((file) => ({ file })) }, undefined, undefined, ctx),
      ).rejects.toThrow(MAX_READ_FILES_MESSAGE);
      const atCap = await tool.execute(
        "r2",
        { files: names.slice(0, MAX_READ_FILES).map((file) => ({ file })) },
        undefined,
        undefined,
        ctx,
      );
      expect(atCap).toBeDefined();
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
  it("heads every served file with its path and its total line count", async () => {
    await withTwoFiles(SIX, EIGHT, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { files: [{ file: "a.ts" }, { file: "b.ts" }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text.startsWith("[a.ts (6 lines total)]\n")).toBe(true);
      expect(text).toContain("\n\n[b.ts (8 lines total)]\n");
      // WHY: the header is chrome — the rows stay strictly `HASH│content`, with no line numbers.
      expect(rowsOf(text)).toEqual([...SIX.trimEnd().split("\n"), ...EIGHT.trimEnd().split("\n")]);
      // WHY: every line carrying a `HASH│` separator must BE a served row with the 4-char anchor
      // WHY: prefix — a numbered (`12│line`) or unanchored row fails the prefix or stops being a row.
      const rowLines = text.split("\n").filter((line) => line.includes("│"));
      expect(rowLines).toHaveLength(
        SIX.trimEnd().split("\n").length + EIGHT.trimEnd().split("\n").length,
      );
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
            files: [
              {
                file: "a.ts",
                windows: [
                  { offset: 2, limit: 2 },
                  { offset: 6, limit: 2 },
                ],
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text.startsWith("[a.ts (12 lines total)]\n")).toBe(true);
      expect(text).toContain("=== Lines 2-3 of 12 ===\n");
      expect(text).toContain("=== Lines 6-7 of 12 ===\n");
      // WHY: four served rows (2 + 2), each strictly `HASH│content` — never a numbered row.
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
        { files: [{ file: "README.md", mode: "verbatim" }] },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      // WHY: exact bytes — a `HASH│` prefix or a row-level line number breaks this equality, so the
      // WHY: assertion discriminates where the shape checks it replaces could not.
      expect(text).toBe(`[README.md (verbatim, 45 lines, no anchors)]\n${readme.trimEnd()}`);
      // WHY: the lease half of the verbatim contract (§4.4): a served read would have left this
      // WHY: session one lease per row — the verbatim read leaves none.
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
          { file: "app.ts", offset: 1, limit: 50 },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain(
        "[app.ts lines 1-50 of 200. Use windows: [{ offset: 51, limit: 50 }] to continue.]",
      );
    });
  });

  it("refuses the file the call-wide served budget cannot afford, inline, and still renders its siblings", async () => {
    // WHY: b.ts fits the budget on its own (exactly SERVED_MAX_LINES lines) but not after a.ts drew
    // WHY: the first TWELVE lines of the ONE shared budget, so a per-file gate would render both
    // WHY: files and this test would still pass (spec 4.2, `SERVED_MAX_LINES`).
    await withTwoFiles(TWELVE, BUDGET_EXACT, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { files: [{ file: "a.ts" }, { file: "b.ts" }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      const remaining = SERVED_MAX_LINES - 12;
      expect(text).toContain("[a.ts (12 lines total)]\n");
      expect(text).toContain(
        `[MODEL] [E_LARGE_FILE] b.ts has more than ${remaining} lines, exceeding the ${remaining}-line edit limit.`,
      );
      expect(rowsOf(text)).toEqual(TWELVE.trimEnd().split("\n"));
    });
  });
  it("names each file in its own footer when its own page is cut", async () => {
    await withTwoFiles(TWENTY_FIVE_HUNDRED, TWENTY_FIVE_HUNDRED, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { files: [{ file: "a.ts" }, { file: "b.ts" }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain(
        "[a.ts lines 1-2000 of 2500. Use windows: [{ offset: 2001, limit: 2000 }] to continue.]",
      );
      expect(text).toContain(
        "[b.ts lines 1-2000 of 2500. Use windows: [{ offset: 2001, limit: 2000 }] to continue.]",
      );
    });
  });

  it("reports an unreadable file inline and still renders its siblings", async () => {
    await withTwoFiles(SIX, EIGHT, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { files: [{ file: "a.ts" }, { file: "missing.ts" }, { file: "b.ts" }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain("[MODEL] [E_NOT_FOUND] File not found: missing.ts.");
      expect(text).toContain("[a.ts (6 lines total)]\n");
      expect(text).toContain("[b.ts (8 lines total)]\n");
      expect(rowsOf(text)).toEqual([...SIX.trimEnd().split("\n"), ...EIGHT.trimEnd().split("\n")]);
    });
  });

  it("reports a non-text sibling inline without aborting the call", async () => {
    await withTempFile("a.ts", SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { files: [{ file: "a.ts" }, { file: "." }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain("[E_UNSUPPORTED_FILE]");
      expect(rowsOf(text)).toEqual(SIX.trimEnd().split("\n"));
    });
  });

  it("still fails the call when its only file cannot be read", async () => {
    await withTempFile("a.ts", SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await expect(
        readTool.execute("r1", { files: [{ file: "missing.ts" }] }, undefined, undefined, ctx),
      ).rejects.toThrow(/\[E_NOT_FOUND\]/);
    });
  });

  it("keeps the offset-past-end diagnostic byte-identical", async () => {
    await withTempFile("small.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { files: [{ file: "small.ts", windows: [{ offset: 99, limit: 5 }] }] },
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
        await readTool.execute("r1", { files: [{ file: "wide.ts" }] }, undefined, undefined, ctx),
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
        { mode: "verbatim", files: [{ file: "plain.txt", windows: [{ around_anchor: "a1b2" }] }] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toBe(
        "[plain.txt (verbatim, 12 lines, no anchors)]\n" +
          "[Window warning: Anchor 'a1b2' not found; window omitted]",
      );
      // WHY: a verbatim read is a reference read — it grants no lease and writes no served state.
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
        { mode: "verbatim", files: [{ file: "plain.txt", windows: [{ around_anchor: anchor }] }] },
        undefined,
        undefined,
        ctx,
      );
      // WHY: spec §4.3 resolves `around_anchor` against the target file's active lineage for the
      // WHY: session and carries NO mode qualifier, so this anchor genuinely resolves even though the
      // WHY: target renders verbatim. §4.4's verbatim contract constrains RENDERING (plain lines, no
      // WHY: anchors) and LEASES (none granted) only — never resolution. The default radius 10 clamps
      // WHY: the window to the whole file.
      expect(getText(verbatim)).toBe(
        "[plain.txt (verbatim, 12 lines, no anchors)]\n" +
          "=== Lines 1-12 of 12 ===\n" +
          TWELVE.trimEnd(),
      );
      // WHY: resolution renders no anchor and writes no served state — the leases are untouched.
      expect(loadLeases(store, TEST_SESSION_ID, absolute)).toEqual(before);
    });
  });

  it("renders a verbatim anchor window identically whether or not a sibling is served", async () => {
    await withTempFile("plain.txt", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute("s1", { file: "plain.txt" }, undefined, undefined, ctx);
      const anchor = anchorsByLine(getText(served)).get("line 3")!;
      const target = { file: "plain.txt", windows: [{ around_anchor: anchor, radius: 1 }] };
      // WHY: the sibling is a directory, so it fails before any render mode matters and its inline
      // WHY: E_UNSUPPORTED_FILE section is byte-identical in both calls — the one variable left between
      // WHY: them is whether a SERVED target opens the store the anchor resolves against.
      const withoutServedSibling = getText(
        await readTool.execute(
          "v1",
          { mode: "verbatim", files: [target, { file: ".", mode: "verbatim" }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      const withServedSibling = getText(
        await readTool.execute(
          "v2",
          { mode: "verbatim", files: [target, { file: ".", mode: "served" }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      // WHY: this session served the anchor, so §4.3 resolves the window for the verbatim target
      // WHY: exactly as it would for a served one — rendered as PLAIN lines (§4.4).
      expect(withServedSibling).toContain(
        "[plain.txt (verbatim, 12 lines, no anchors)]\n" +
          "=== Lines 2-4 of 12 ===\n" +
          "line 2\nline 3\nline 4",
      );
      // INVARIANT (spec §4.3): one target's output is a function of (target, session lineage) ONLY —
      // WHY: never of sibling composition. Compared as the WHOLE response, byte for byte.
      expect(withServedSibling).toBe(withoutServedSibling);
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
          { mode: "verbatim", files: [{ file: "b.ts", windows: [{ around_anchor: foreign }] }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      // WHY: opening the store for a verbatim target must not make a FOREIGN anchor resolve — §4.3
      // WHY: keeps the one wording for unknown, expired and foreign alike.
      expect(text).toBe(
        "[b.ts (verbatim, 12 lines, no anchors)]\n" +
          `[Window warning: Anchor '${foreign}' not found; window omitted]`,
      );
    });
  });

  it("warns when a lone file switches itself to verbatim and names an anchor window", async () => {
    await withTempFile("plain.txt", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        {
          files: [{ file: "plain.txt", mode: "verbatim", windows: [{ around_anchor: "a1b2" }] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toBe(
        "[plain.txt (verbatim, 12 lines, no anchors)]\n" +
          "[Window warning: Anchor 'a1b2' not found; window omitted]",
      );
    });
  });

  it("keeps a served sibling's anchor window resolving while a verbatim sibling warns", async () => {
    await withTwoFiles(TWELVE, SIX, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute("s1", { file: "a.ts" }, undefined, undefined, ctx);
      const anchor = anchorsByLine(getText(served)).get("line 4")!;

      const text = getText(
        await readTool.execute(
          "r1",
          {
            files: [
              { file: "a.ts", windows: [{ around_anchor: anchor, radius: 1 }] },
              { file: "b.ts", mode: "verbatim", windows: [{ around_anchor: "a1b2" }] },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain("[Window warning: Anchor 'a1b2' not found; window omitted]");
      expect(text).toContain("[b.ts (verbatim, 6 lines, no anchors)]");
      // WHY: the served sibling's genuine anchor still resolves to its window, while the verbatim
      // WHY: sibling's unresolvable one leaves the header and the warning alone (spec §4.3).
      expect(text).toContain("=== Lines 3-5 of 12 ===\n");
      expect(rowsOf(text)).toEqual(["line 3", "line 4", "line 5"]);
      expect(text).not.toContain("alpha 1");
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

  it("keeps every sibling's rows when the mirror phase fails for one file", async () => {
    await withTempFile("a.ts", SIX, async ({ cwd }) => {
      await writeFile(join(cwd, "b.ts"), EIGHT, "utf-8");
      await writeFile(join(cwd, "c.ts"), SIX, "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const sessions = await import("../../src/served-session");
      const realSessionFromContext = sessions.sessionFromContext;
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mirrorSpy = vi
        .spyOn(sessions, "sessionFromContext")
        .mockImplementation((sessionCtx, path) => {
          const handle = realSessionFromContext(sessionCtx, path);
          if (!path.endsWith("b.ts")) return handle;
          return {
            ...handle,
            recordEpoch: async () => {
              throw new Error("mirror phase boom");
            },
          };
        });
      try {
        const text = getText(
          await readTool.execute(
            "r1",
            { files: [{ file: "a.ts" }, { file: "b.ts" }, { file: "c.ts" }] },
            undefined,
            undefined,
            ctx,
          ),
        );
        expect(text).toContain("[a.ts (6 lines total)]\n");
        expect(text).toContain("[b.ts (8 lines total)]\n");
        expect(text).toContain("[c.ts (6 lines total)]\n");
        expect(rowsOf(text)).toEqual([
          ...SIX.trimEnd().split("\n"),
          ...EIGHT.trimEnd().split("\n"),
          ...SIX.trimEnd().split("\n"),
        ]);
        expect(errorSpy).toHaveBeenCalledWith(
          "Failed to mirror the served read into the session:",
          expect.stringContaining("b.ts"),
          expect.anything(),
        );
        // WHY: the loop continued past the failed file — the LAST file's mirror still landed.
        const store = await loadHashStore();
        expect(
          getServed(store, TEST_SESSION_ID, await resolveTarget(join(cwd, "c.ts"))).length,
        ).toBeGreaterThan(0);
      } finally {
        mirrorSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
});
