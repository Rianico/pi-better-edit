import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as utils from "../../src/utils.js";
import { loadHashStore } from "../../src/hash-store.js";
import { MAX_HASH_LINES } from "../../src/hashline/index.js";
import { decodeNormText } from "../../src/file-content/loader.js";
import { snapshotIOFor } from "../../src/snapshot-store";
import { setupReadTest, useTestHome, withTempFile } from "../support/fixtures";

// WHY: a page is the only witness that can see whether the text was split: the rendered bytes are
// WHY: identical either way. So the array primitives record every call, with the frames that made it,
// WHY: and then delegate — recording instead of throwing, because a throw would be swallowed by the
// WHY: best-effort handlers downstream (the snapshot store's lineage write, for one) and the witness
// WHY: would pass for the wrong reason. The frames are what tell a legitimate caller from the page path.
interface SplitCall {
  name: string;
  frames: string[];
}

vi.mock("../../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils.js")>();
  const __splitCalls: SplitCall[] = [];
  const record = (name: string): void => {
    __splitCalls.push({ name, frames: (new Error("split").stack ?? "").split("\n").slice(1) });
  };
  return {
    ...actual,
    __splitCalls,
    splitLines: (text: string) => {
      record("splitLines");
      return actual.splitLines(text);
    },
    visLines: (text: string) => {
      record("visLines");
      return actual.visLines(text);
    },
  };
});

const splitCalls = (utils as unknown as { __splitCalls: SplitCall[] }).__splitCalls;

useTestHome();

function callsFromSnapshotStore(): SplitCall[] {
  return splitCalls.filter((call) =>
    call.frames.some((frame) => frame.includes("src/snapshot-store/")),
  );
}

describe("the witness's own mock", () => {
  // WHY: the control that keeps the rest honest: these mocks have to record AND still return the real
  // WHY: lines, or every assertion below would pass without observing anything at all.
  it("records the primitives it replaces and still delegates to them", () => {
    splitCalls.length = 0;
    expect(utils.splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(utils.visLines("")).toEqual([]);
    expect(splitCalls.map((call) => call.name)).toEqual(["splitLines", "visLines"]);
    expect(splitCalls[0]?.frames.join("\n")).toContain("line-walk-seam.test.ts");
  });
});

describe("the verbatim page never materializes the line array", () => {
  it("walks a single page, disjoint windows, a page past the end and an empty file", async () => {
    await withTempFile("plain.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd }) => {
      splitCalls.length = 0;
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
      await expect(run({ limit: 2 })).resolves.toBe(
        "alpha\nbeta\n\n[Showing lines 1-2 of 4. Use offset=3 to continue.]",
      );
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
      expect(splitCalls).toEqual([]);
    });
  });

  it("returns the empty-file marker without a line array to count", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      splitCalls.length = 0;
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute(
        "v1",
        { file: "empty.txt", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0]?.text).toBe("[File is empty.]");
      expect(splitCalls).toEqual([]);
    });
  });
});

describe("the served page never materializes the line array", () => {
  it("walks a page, its anchors and disjoint windows, past the end included", async () => {
    await withTempFile("plain.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd }) => {
      splitCalls.length = 0;
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
      // WHY: these two primitives have plenty of other callers in the program — lifecycle hooks, edit
      // WHY: responses, the mutation engine — and the claim here is a partition: in a served read they
      // WHY: are called by the snapshot store's lineage write and by nothing else on the read path.
      expect(splitCalls.length).toBe(callsFromSnapshotStore().length);
      // WHY: and the run was not vacuous: the read reached the store. Asserted through the store's own
      // WHY: API, not through a call it happens to make, so this cannot break when the store changes.
      const io = snapshotIOFor(await loadHashStore());
      const snapshot = await io.get(join(cwd, "plain.txt"), "alpha\nbeta\ngamma\ndelta\n", false);
      expect(snapshot).toBeDefined();
    });
  });

  it("marks an empty file without a line array to count", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      splitCalls.length = 0;
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("s1", { file: "empty.txt" }, undefined, undefined, ctx);
      expect(result.content[0]?.text).toMatch(
        /^\w{3}│\n\[File is empty\. Use edit to insert content\.\]$/,
      );
      expect(splitCalls.length).toBe(callsFromSnapshotStore().length);
    });
  });

  it("refuses a preloaded file over the anchor cap without materializing its lines", async () => {
    // WHY: a preloaded file skips the decode that counts newlines mid-stream, so this refusal is the
    // WHY: loader's own line count — the one place a second split could creep back in unnoticed.
    const text = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n");
    await withTempFile("huge.ts", text, async ({ cwd }) => {
      splitCalls.length = 0;
      await expect(
        decodeNormText("huge.ts", cwd, {
          maxLines: MAX_HASH_LINES,
          preloadedFile: { kind: "text", text },
        }),
      ).rejects.toThrow("E_LARGE_FILE");
      expect(splitCalls).toEqual([]);
    });
  }, 300_000);

  it("refuses a CR-only file over the cap before anything anchors it", async () => {
    // WHY: `toLF` turns a lone `\r` into a line break, so the cap's count is the normalized text's; this
    // WHY: file is only over the cap after normalization, and the refusal has to happen here — in the
    // WHY: loader, without a line array — not later inside the anchor space.
    await withTempFile("cr-only.ts", "x\r".repeat(MAX_HASH_LINES + 1), async ({ cwd }) => {
      splitCalls.length = 0;
      const { readTool, ctx } = setupReadTest(cwd);
      await expect(
        readTool.execute("s1", { file: "cr-only.ts" }, undefined, undefined, ctx),
      ).rejects.toThrow(`cr-only.ts has ${MAX_HASH_LINES + 1} lines`);
      expect(splitCalls).toEqual([]);
    });
  }, 300_000);

  it("refuses a CR-only preloaded file at the cap, before it can reach the anchor space", async () => {
    // WHY: the preloaded route skips the decode that counts newlines mid-stream, so it is the loader's
    // WHY: own count that has to see the normalized line space: an LF fixture cannot tell the two apart
    // WHY: because raw and normalized counts agree on it.
    const text = "x\r".repeat(MAX_HASH_LINES + 1);
    await withTempFile("cr.ts", text, async ({ cwd }) => {
      splitCalls.length = 0;
      await expect(
        decodeNormText("cr.ts", cwd, {
          maxLines: MAX_HASH_LINES,
          preloadedFile: { kind: "text", text },
        }),
      ).rejects.toThrow(`cr.ts has ${MAX_HASH_LINES + 1} lines`);
      expect(splitCalls).toEqual([]);
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

// WHY: recording the primitives catches a call through THEM, but a page could inline `split("\n")`
// WHY: again — and `walkLines` IS the page path, so an audit stopping at preview.ts would miss the
// WHY: mutation that matters most. These are the files a read pages through; the allowance is how many
// WHY: splits each may hold, and any split they do hold must be of RENDERED output (a property access),
// WHY: never of a bare identifier — a file's text lives in bare identifiers.
const READ_PATH: Array<[file: string, splits: number]> = [
  ["src/file-content/line-walker.ts", 0],
  ["src/file-content/preview.ts", 2],
  ["src/file-content/loader.ts", 0],
  ["src/file-content/index.ts", 0],
  ["src/read.ts", 0],
];

function readPathSource(file: string): string {
  return readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "");
}

describe("the read path holds no split of the file's text", () => {
  it.each(READ_PATH)("%s holds at most %s splits", (file, splits) => {
    expect([...readPathSource(file).matchAll(/\.split\(/g)]).toHaveLength(splits);
    // Naming them is fine (index.ts re-exports `visLines`); CALLING them is not.
    expect(readPathSource(file)).not.toMatch(/\b(splitLines|visLines)\(/);
  });

  it("never splits inside the walk itself, whatever its callers do", () => {
    expect(readPathSource("src/file-content/line-walker.ts")).not.toMatch(/split/);
  });

  it("splits only output a page renders, never a bare name holding the text", () => {
    const receivers = [
      ...readPathSource("src/file-content/preview.ts").matchAll(/([A-Za-z0-9_$.[\]()]+)\.split\(/g),
    ].map((match) => match[1]!);
    expect(receivers).toHaveLength(2);
    expect(receivers.every((receiver) => receiver.includes("."))).toBe(true);
  });
});
