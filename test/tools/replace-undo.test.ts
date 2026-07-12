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

describe("undo_last_replace", () => {
  it("returns error when there is no undo history", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const undo = getTool("undo_last_replace");

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
      const undo = getTool("undo_last_replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

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

      const afterReplace = await readFile(
        new URL(`file://${cwd}/sample.ts`),
        "utf-8",
      );
      expect(afterReplace).toBe("aaa\nBBB\nccc\n");

      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      expect(undoResult.isError).toBeFalsy();
      expect(getText(undoResult)).toMatch(/undone last replace/i);

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
      const undo = getTool("undo_last_replace");
      const hashes = await lineHashes("aaa\nccc\n", testPath);

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
      expect(text).toMatch(/removed 2 line/i);
      expect(text).toMatch(/restored 1 line/i);
    });
  });

  it("reports correct line counts for a deletion", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

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
      expect(text).toMatch(/restored 1 line/i);
      expect(text).toMatch(/removed 0 line/i);
    });
  });

  it("reports correct line counts for a mixed replace", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

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
      expect(text).toMatch(/removed 3 line/i);
      expect(text).toMatch(/restored 2 line/i);
    });
  });

  it("restores hash store snapshot after undo", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

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

      await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      const store = await loadHashStore();
      const absPath = new URL(`file://${cwd}/sample.ts`).pathname;
      const snapshot = store.snapshots[absPath] ?? store.snapshots[`/${cwd}/sample.ts`];
      expect(snapshot).toBeDefined();
      expect(snapshot!.content).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("second undo call returns error (undo clears after use)", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

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

      const first = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(first.isError).toBeFalsy();

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
      const undo = getTool("undo_last_replace");
      const hashes = await lineHashes("line1\nline2\n", testPath);

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

      const afterReplace = await readFile(
        new URL(`file://${cwd}/sample.ts`),
        "utf-8",
      );
      expect(afterReplace).toBe("LINE1\nline2\n");

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
