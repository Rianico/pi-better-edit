import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as utils from "../../src/utils.js";
import { MAX_HASH_LINES } from "../../src/hashline/index.js";
import { decodeNormText } from "../../src/file-content/loader.js";
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
      // WHY: It is not a claim that a split happened: when nothing line-materializes, 0 = 0 is the right
      // WHY: answer, and the store stopping its own split is not this witness's business. What makes the
      // WHY: negative half falsifiable is the revert control — building the page from `visLines` reddens
      // WHY: these assertions (recorded in the commit that introduced them) — and what keeps the recorder
      // WHY: itself honest is the control at the top of this file.
      expect(splitCalls.length).toBe(callsFromSnapshotStore().length);
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

// WHAT THIS AUDIT COVERS, and what it does not.
//
// It reads the source of the files the page itself is built in — `src/file-content/*` (derived from the
// directory, so a file added there is audited without anyone remembering to register it) plus
// `src/read.ts` — and counts the two ways this codebase turns text into a line array: a `split` on a
// newline literal, and a call to `splitLines`/`visLines` (naming them is fine: `index.ts` re-exports
// `visLines`; CALLING one is not). A split on anything else — a path, a comma — is not a line split and
// is not counted, so a guard here does not cry wolf on unrelated work.
//
// It does NOT cover shared machinery the page passes through — `utils.ts` (where the primitives are
// defined), `hashline/*` (the edit path's whole-content hashing), `snapshot-store/*` (the lineage write
// that legitimately keeps a line array, bounded by the anchor-space ceiling). Those are covered only for
// the PRIMITIVES, at runtime, by the recording witness above: any call to `splitLines`/`visLines` during
// a real read is recorded with the frames that made it, whichever file that is. An inline
// `text.split("\n")` moved into shared machinery would be missed by both — that is the residual this
// audit accepts rather than growing into an import-graph rule that reddens on the edit path.
//
// The allowance is the deliberate friction: a new line split in an audited file must be added here with
// its reason, which is the moment to ask whether the page should be materializing lines at all.
const ALLOWED_LINE_SPLITS: Record<string, number> = {
  // Both split output this file has already RENDERED: a preview string and a withheld marker's body.
  "src/file-content/preview.ts": 2,
};

const AUDITED: string[] = [
  "src/read.ts",
  ...readdirSync(fileURLToPath(new URL("../../src/file-content", import.meta.url)))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => `src/file-content/${name}`),
];

/**
 * Source with comments removed and everything else left as written.
 *
 * WHY: not a regex — `//` inside a URL or a regex literal would swallow the rest of the line, which is
 * WHY: exactly how a real `text.split("\n")` inside a template literal slipped past this audit. The
 * WHY: scan knows strings and templates, so a comment is only a comment where one can start. String
 * WHY: CONTENTS stay: a split written inside one counts as a split, erring toward red, never toward
 * WHY: missing one. A template's `${...}` is code either way.
 */
function stripComments(source: string): string {
  const QUOTES = new Set(['"', "'", "`"]);
  let out = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (QUOTES.has(char)) {
      out += char;
      for (index++; index < source.length; index++) {
        const inner = source[index]!;
        out += inner;
        if (inner === "\\") {
          out += source[++index] ?? "";
        } else if (inner === char) {
          break;
        }
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/"))
        index++;
      index++;
      continue;
    }
    out += char;
  }
  return out;
}

function readPathSource(file: string): string {
  return stripComments(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"));
}

/** `split("\n")`, `split('\n')`, `split(/\n/)`, `splitLines(...)`, `visLines(...)`. */
function lineSplits(code: string): string[] {
  return [
    ...code.matchAll(/[^\s;]+\.split\(\s*(?:"\\n"|'\\n'|\/\s*\\n)/g),
    ...code.matchAll(/\b(?:splitLines|visLines)\(/g),
  ].map((match) => match[0].replace(/\s+/g, ""));
}

describe("the read path holds no split of the file's text", () => {
  it("audits the directory the page is built in, and does not audit nothing", () => {
    expect(AUDITED).toContain("src/file-content/detection.ts");
    expect(AUDITED).toContain("src/file-content/preview.ts");
    expect(AUDITED.length).toBeGreaterThanOrEqual(6);
  });

  it.each(AUDITED)("%s splits no text into lines beyond its allowance", (file) => {
    expect(lineSplits(readPathSource(file))).toHaveLength(ALLOWED_LINE_SPLITS[file] ?? 0);
  });

  it("never splits inside the walk itself, whatever its callers do", () => {
    expect(readPathSource("src/file-content/line-walker.ts")).not.toMatch(/split/i);
  });
});
