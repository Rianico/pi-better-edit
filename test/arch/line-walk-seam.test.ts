import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MAX_HASH_LINES } from "../../src/hashline/index.js";
import { decodeNormText } from "../../src/file-content/loader.js";
import { setupReadTest, useTestHome, withTempFile } from "../support/fixtures";

// WHY: the structural proof that a page is walked out of the text rather than sliced out of a
// WHY: materialized line array: the array primitives are replaced with throwers, so a page that
// WHY: renders could not have split the text at all. A page is the only witness that can see this —
// WHY: the rendered bytes are identical either way, which is the point of the equivalence tests.
vi.mock("../../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils.js")>();
  return {
    ...actual,
    splitLines: () => {
      throw new Error("splitLines sentinel: a paged read must not materialize lines");
    },
    visLines: () => {
      throw new Error("visLines sentinel: a paged read must not materialize lines");
    },
  };
});

useTestHome();

describe("the verbatim page never materializes the line array", () => {
  it("walks a single page", async () => {
    await withTempFile("plain.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute(
        "v1",
        { file: "plain.txt", mode: "verbatim", limit: 2 },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0]?.text).toBe(
        "alpha\nbeta\n\n[Showing lines 1-2 of 3. Use offset=3 to continue.]",
      );
    });
  });

  it("walks disjoint windows, an offset past the end, an empty file and a trailing sentinel", async () => {
    await withTempFile("plain.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const run = async (args: Record<string, unknown>): Promise<string> => {
        const result = await readTool.execute(
          "v1",
          { file: "plain.txt", mode: "verbatim", ...args },
          undefined,
          undefined,
          ctx,
        );
        return result.content[0]?.text ?? "";
      };
      await expect(
        run({
          windows: [
            { offset: 2, limit: 1 },
            { offset: 4, limit: 1 },
          ],
        }),
      ).resolves.toBe("=== Lines 2-2 of 4 ===\nbeta\n\n=== Lines 4-4 of 4 ===\ndelta");
      await expect(run({ offset: 9, limit: 1 })).resolves.toContain(
        "Offset 9 is beyond end of file (4 lines total)",
      );
      await expect(run({ offset: 4, limit: 4 })).resolves.toBe("delta");
    });
  });

  it("returns the empty-file marker without a line array to count", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute(
        "v1",
        { file: "empty.txt", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0]?.text).toBe("[File is empty.]");
    });
  });
});

describe("the served page never materializes the line array", () => {
  // WHY: the array primitives are throwers here, so these pages could not have split the text for
  // WHY: their lines or their anchors. One caller still legitimately splits a served read's content:
  // WHY: the snapshot store writes the lineage of every line into its own table (`materializeSnapshot`),
  // WHY: a separate persisted seam outside this walk — its commit fails here, best-effort, and the
  // WHY: page below is unaffected. That split is bounded by the same anchor-space cap as the read.
  it("walks a page, its anchors and disjoint windows, past the end included", async () => {
    await withTempFile("plain.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const run = async (args: Record<string, unknown>): Promise<string> => {
        const result = await readTool.execute(
          "s1",
          { file: "plain.txt", ...args },
          undefined,
          undefined,
          ctx,
        );
        return result.content[0]?.text ?? "";
      };
      await expect(run({ limit: 2 })).resolves.toMatch(
        /^\w{3}│alpha\n\w{3}│beta\n\n\[Showing lines 1-2 of 4\. Use offset=3 to continue\.\]$/,
      );
      await expect(
        run({
          windows: [
            { offset: 2, limit: 1 },
            { offset: 4, limit: 1 },
          ],
        }),
      ).resolves.toMatch(
        /^=== Lines 2-2 of 4 ===\n\w{3}│beta\n\n=== Lines 4-4 of 4 ===\n\w{3}│delta$/,
      );
      await expect(run({ offset: 9, limit: 1 })).resolves.toContain(
        "Offset 9 is beyond end of file (4 lines total)",
      );
    });
  });

  it("marks an empty file without a line array to count", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("s1", { file: "empty.txt" }, undefined, undefined, ctx);
      expect(result.content[0]?.text).toMatch(
        /^\w{3}│\n\[File is empty\. Use edit to insert content\.\]$/,
      );
    });
  });

  it("refuses a preloaded file over the anchor cap without materializing its lines", async () => {
    // WHY: a preloaded file skips the decode that counts newlines mid-stream, so this refusal is the
    // WHY: loader's own line count — the one place a second split could creep back in unnoticed.
    const text = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n");
    await withTempFile("huge.ts", text, async ({ cwd }) => {
      await expect(
        decodeNormText("huge.ts", cwd, {
          maxLines: MAX_HASH_LINES,
          preloadedFile: { kind: "text", text },
        }),
      ).rejects.toThrow("E_LARGE_FILE");
    });
  }, 300_000);
});

// WHY: the second half of the witness: the primitive is adopted by both seams only if it stays
// WHY: ignorant of them. Comments may name what the walk avoids; the CODE may not mention it.
describe("the walk is mode-agnostic", () => {
  const source = readFileSync(
    new URL("../../src/file-content/line-walker.ts", import.meta.url),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("names no render mode, anchor, hash, snapshot or store", () => {
    expect(code).not.toMatch(/verbatim|served|anchor|hash|render|snapshot|store|mode/i);
  });

  it("imports nothing, so any caller can reach it without a dependency on their own seam", () => {
    expect(code).not.toMatch(/\bimport\b|\brequire\b/);
  });
});
