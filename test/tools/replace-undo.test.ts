import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { loadHashStore } from "../../src/hash-store";
import {
  withTempFile,
  setupIntegrationTest,
  setupTestHome,
  getText,
} from "../support/fixtures";

let testPath: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const s = await setupTestHome();
  testPath = s.testPath;
  cleanup = s.cleanup;
});

afterAll(async () => {
  await cleanup();
});

describe("last_replace_undo", () => {
  it("returns error when there is no undo history", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const undo = getTool("last_replace_undo");

      const result = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(getText(result)).toMatch(/no undo history/i);
    });
  });

  it("restores file content after a single-line replace", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("last_replace_undo");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      // Perform a replace: change "bbb" to "BBB"
      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            {
              hash_range_inclusive: [hashes[1]!, hashes[1]!],
              content_lines: ["BBB"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      // Verify the file was changed
      const afterReplace = await readFile(
        new URL(`file://${cwd}/sample.ts`),
        "utf-8",
      );
      expect(afterReplace).toBe("aaa\nBBB\nccc\n");

      // Undo the replace
      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      expect(undoResult.isError).toBeFalsy();
      expect(getText(undoResult)).toMatch(/undone last replace/i);

      // Verify the file is restored
      const afterUndo = await readFile(
        new URL(`file://${cwd}/sample.ts`),
        "utf-8",
      );
      expect(afterUndo).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("reports correct line counts for an addition", async () => {
    await withTempFile("sample.ts", "aaa\nccc\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("last_replace_undo");
      const hashes = await lineHashes("aaa\nccc\n", testPath);

      // Replace single line with two lines (addition)
      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            {
              hash_range_inclusive: [hashes[1]!, hashes[1]!],
              content_lines: ["BBB", "B2"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(undoResult);
      // The replace changed 1 line (ccc) into 2 lines (BBB, B2):
      //   +2 lines added by replace → removed by undo
      //   -1 line removed by replace → restored by undo
      expect(text).toMatch(/removed 2 line/i);
      expect(text).toMatch(/restored 1 line/i);
    });
  });

  it("reports correct line counts for a deletion", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("last_replace_undo");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      // Delete the middle line
      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            {
              hash_range_inclusive: [hashes[1]!, hashes[1]!],
              content_lines: [],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(undoResult);
      // The replace removed 1 line, so undo should say "restored 1 line(s)"
      expect(text).toMatch(/restored 1 line/i);
      expect(text).toMatch(/removed 0 line/i);
    });
  });

  it("reports correct line counts for a mixed replace", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("last_replace_undo");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      // Replace 2 lines with 3 different lines
      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            {
              hash_range_inclusive: [hashes[1]!, hashes[2]!],
              content_lines: ["XXX", "YYY", "ZZZ"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(undoResult);
      // Replace: 2 lines → 3 lines = +1 added, 0 removed (net)
      // Actually: 2 old lines removed, 3 new lines added
      // So undo: removed 3 lines (the XXX/YYY/ZZZ), restored 2 lines (bbb/ccc)
      expect(text).toMatch(/removed 3 line/i);
      expect(text).toMatch(/restored 2 line/i);
    });
  });

  it("restores hash store snapshot after undo", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("last_replace_undo");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      // Perform a replace
      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            {
              hash_range_inclusive: [hashes[1]!, hashes[1]!],
              content_lines: ["BBB"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      // Undo
      await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      // Check hash store snapshot matches restored content
      const store = await loadHashStore();
      const absPath = new URL(`file://${cwd}/sample.ts`).pathname;
      // On Windows the URL might have a different format, but on Linux/Mac
      // the pathname is the absolute path. The hash store uses the resolved
      // absolute path from resolveTarget, which is the same as the URL pathname.
      const snapshot = store.snapshots[absPath] ?? store.snapshots[`/${cwd}/sample.ts`];
      expect(snapshot).toBeDefined();
      expect(snapshot!.content).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("second undo call returns error (undo clears after use)", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("last_replace_undo");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      // Perform a replace
      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [
            {
              hash_range_inclusive: [hashes[1]!, hashes[1]!],
              content_lines: ["BBB"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      // First undo succeeds
      const first = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(first.isError).toBeFalsy();

      // Second undo fails
      const second = await undo.execute(
        "u2",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(second.isError).toBe(true);
      expect(getText(second)).toMatch(/no undo history/i);
    });
  });

  it("undo works after flat-mode replace", async () => {
    await withTempFile("sample.ts", "line1\nline2\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("last_replace_undo");
      const hashes = await lineHashes("line1\nline2\n", testPath);

      // Perform a flat-mode replace (single change at top level)
      // The replace tool's execute normalizes flat format internally
      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_range_inclusive: [hashes[0]!, hashes[0]!],
          content_lines: ["LINE1"],
        },
        undefined,
        undefined,
        ctx,
      );

      // Verify file changed
      const afterReplace = await readFile(
        new URL(`file://${cwd}/sample.ts`),
        "utf-8",
      );
      expect(afterReplace).toBe("LINE1\nline2\n");

      // Undo
      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(undoResult.isError).toBeFalsy();

      const afterUndo = await readFile(
        new URL(`file://${cwd}/sample.ts`),
        "utf-8",
      );
      expect(afterUndo).toBe("line1\nline2\n");
    });
  });
});
