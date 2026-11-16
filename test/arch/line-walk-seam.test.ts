/**
 * The page is the only witness that can see whether the text was split: the rendered bytes
 * are identical either way. So the array primitives record every call with the frames that
 * made it, then delegate — recording rather than throwing, because the best-effort handlers
 * downstream would swallow a throw and the witness would pass for the wrong reason.
 * The audit parses `src/file-content/*` and `src/read.ts` with `@babel/parser` and counts
 * two spellings of a line split: `X.split(<LF literal>)`, and a bare or member-form call to
 * `splitLines`/`visLines`. Comments, string contents and regex literals cannot hide a match
 * or invent one. Every other spelling reads as zero by design — a computed property, an
 * aliased callee, a wrapped argument, a non-LF separator such as `path.split("/")` — and the
 * per-file allowance is the deliberate friction that makes a new split state its reason.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";
import * as utils from "../../src/utils.js";
import { MAX_HASH_LINES } from "../../src/hashline/hash-identity.js";
import { decodeNormText } from "../../src/file-content/loader.js";
import { setupReadTest, useTestHome, withTempFile } from "../support/fixtures";

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
      await expect(run({ windows: [{ offset: 1, limit: 2 }] })).resolves.toBe(
        "[plain.txt (verbatim, lines 1-2 of 4 total)]\nalpha\nbeta",
      );
      await expect(
        run({
          windows: [
            { offset: 2, limit: 1 },
            { offset: 4, limit: 1 },
          ],
        }),
      ).resolves.toBe(
        "[plain.txt (verbatim, 4 lines total)]\n[Lines 2-2 of 4 total]\nbeta\n\n[Lines 4-4 of 4 total]\ndelta",
      );
      await expect(run({ windows: [{ offset: 9, limit: 1 }] })).resolves.toContain(
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
      expect(result.content[0]?.text).toBe(
        "[empty.txt (verbatim, 0 lines total)]\n[File is empty.]",
      );
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
      await expect(run({ windows: [{ offset: 1, limit: 2 }] })).resolves.toMatch(
        /^\[plain\.txt \(lines 1-2 of 4 total\)\]\n\w{4}│alpha\n\w{4}│beta$/,
      );
      await expect(
        run({
          windows: [
            { offset: 2, limit: 1 },
            { offset: 4, limit: 1 },
          ],
        }),
      ).resolves.toMatch(
        /^\[plain\.txt \(4 lines total\)\]\n\[Lines 2-2 of 4 total\]\n\w{4}│beta\n\n\[Lines 4-4 of 4 total\]\n\w{4}│delta$/,
      );
      await expect(run({ windows: [{ offset: 9, limit: 1 }] })).resolves.toContain(
        "Offset 9 is beyond end of file (4 lines total)",
      );
      expect(splitCalls.length).toBe(callsFromSnapshotStore().length);
    });
  });

  it("marks an empty file without a line array to count", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      splitCalls.length = 0;
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("s1", { file: "empty.txt" }, undefined, undefined, ctx);
      expect(result.content[0]?.text).toMatch(
        /^\[empty\.txt \(0 lines total\)\]\n\w{4}│\n\[File is empty\. Use edit to insert content\.\]$/,
      );
      expect(splitCalls.length).toBe(callsFromSnapshotStore().length);
    });
  });

  it("keeps the total header for a windowed read of an empty file", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute(
        "s1",
        { file: "empty.txt", windows: [{ offset: 1, limit: 5 }] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0]?.text).toMatch(/^\[empty\.txt \(0 lines total\)\]\n/);
    });
  });

  it("refuses a preloaded file over the anchor cap without materializing its lines", async () => {
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

describe("the walk is mode-agnostic", () => {
  it("names no render mode, anchor, hash, snapshot or store", () => {
    const names = namedValues("src/file-content/line-walker.ts");
    expect(
      names.filter((name) => /verbatim|served|anchor|hash|render|snapshot|store|mode/i.test(name)),
    ).toEqual([]);
  });

  it("imports nothing, so any caller can reach it without a dependency on their own seam", () => {
    expect(importsAndReExports("src/file-content/line-walker.ts")).toEqual([]);
  });
});

const ALLOWED_LINE_SPLITS: Record<string, number> = {
  "src/file-content/preview.ts": 2,
};

const AUDITED: string[] = [
  "src/read.ts",
  ...readdirSync(fileURLToPath(new URL("../../src/file-content", import.meta.url)))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => `src/file-content/${name}`),
];

/** An AST node, structurally: this file needs `type` and a handful of fields, nothing else. */
type AstNode = Record<string, unknown> & { type: string };

function* nodes(root: unknown): Generator<AstNode> {
  if (Array.isArray(root)) {
    for (const child of root) yield* nodes(child);
    return;
  }
  if (typeof root !== "object" || root === null) return;
  const node = root as Record<string, unknown>;
  if (typeof node.type === "string") yield node as AstNode;
  for (const [key, value] of Object.entries(node)) {
    if (key !== "loc" && key !== "start" && key !== "end" && key !== "comments")
      yield* nodes(value);
  }
}

function parseProgram(code: string): AstNode {
  return parse(code, { sourceType: "module", plugins: ["typescript"] })
    .program as unknown as AstNode;
}

function parseFile(file: string): AstNode {
  return parseProgram(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"));
}

function isNewlineLiteral(node: unknown): boolean {
  const argument = node as AstNode | undefined;
  if (!argument) return false;
  if (argument.type === "StringLiteral") return argument.value === "\n";
  if (argument.type === "RegExpLiteral") return argument.pattern === "\\n";
  if (argument.type === "TemplateLiteral") {
    const quasis = argument.quasis as Array<{ value?: { cooked?: string } }> | undefined;
    const expressions = argument.expressions as unknown[] | undefined;
    return expressions?.length === 0 && quasis?.length === 1 && quasis[0]?.value?.cooked === "\n";
  }
  return false;
}

function at(node: AstNode): string {
  const loc = node.loc as { start?: { line?: number } } | undefined;
  return `line ${loc?.start?.line ?? "?"}`;
}

/** Every call that turns text into lines, as the AST sees them: `X.split(<LF literal>)` and a bare or
 * member-form call to `splitLines`/`visLines`. */
function lineSplitsInSource(code: string): string[] {
  const found: string[] = [];
  for (const node of nodes(parseProgram(code))) {
    if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") continue;
    const callee = node.callee as AstNode | undefined;
    const args = (node.arguments as unknown[] | undefined) ?? [];
    if (callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") {
      const property = callee.property as AstNode | undefined;
      const name = property?.type === "Identifier" ? property.name : undefined;
      if (
        (name === "split" && isNewlineLiteral(args[0])) ||
        name === "splitLines" ||
        name === "visLines"
      ) {
        found.push(at(node));
      }
      continue;
    }
    if (
      callee?.type === "Identifier" &&
      (callee.name === "splitLines" || callee.name === "visLines")
    ) {
      found.push(at(node));
    }
  }
  return found;
}

function lineSplits(file: string): string[] {
  return lineSplitsInSource(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"));
}

/** Every name a file writes in code: identifiers, member properties, literal values. Comments are not
 * part of an AST, which is what keeps a WHY block from reading as an identifier. */
function namedValues(file: string): string[] {
  const found: string[] = [];
  for (const node of nodes(parseFile(file))) {
    if (node.type === "Identifier") found.push(String(node.name ?? ""));
    if (node.type === "StringLiteral") found.push(String(node.value ?? ""));
    if (node.type === "TemplateElement") {
      const value = node.value as { cooked?: string } | undefined;
      found.push(String(value?.cooked ?? ""));
    }
  }
  return found;
}

/** Every module a file reaches for at runtime: static imports, re-exports, `import(...)` and
 * `require(...)`. The last two are why this walks rather than matching the word `import`. */
function importsInSource(code: string): string[] {
  const found: string[] = [];
  for (const node of nodes(parseProgram(code))) {
    const source = node.source as { value?: string } | null | undefined;
    if (node.type === "ImportExpression" || node.type === "ExportAllDeclaration") {
      if (source?.value) found.push(source.value);
      continue;
    }
    if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration") {
      if (source?.value) found.push(source.value);
      continue;
    }
    if (node.type === "CallExpression") {
      const callee = node.callee as AstNode | undefined;
      const args = (node.arguments as unknown[] | undefined) ?? [];
      const first = args[0] as { type?: string; value?: string } | undefined;
      const reaches =
        callee?.type === "Import" || (callee?.type === "Identifier" && callee.name === "require");
      if (reaches && first?.type === "StringLiteral") found.push(String(first.value));
    }
  }
  return found;
}

function importsAndReExports(file: string): string[] {
  return importsInSource(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"));
}

describe("the read path holds no split of the file's text", () => {
  it("audits the directory the page is built in, and parses every file it audits", () => {
    expect(AUDITED).toContain("src/file-content/detection.ts");
    expect(AUDITED).toContain("src/file-content/preview.ts");
    expect(AUDITED.length).toBeGreaterThanOrEqual(7);
    for (const file of AUDITED) expect(parseFile(file).type).toBe("Program");
  });

  it.each(AUDITED)("%s splits no text into lines beyond its allowance", (file) => {
    expect(lineSplits(file)).toHaveLength(ALLOWED_LINE_SPLITS[file] ?? 0);
  });

  it("never splits inside the walk itself, whatever its callers do", () => {
    expect(
      namedValues("src/file-content/line-walker.ts").filter((name) => /split/i.test(name)),
    ).toEqual([]);
    expect(lineSplits("src/file-content/line-walker.ts")).toEqual([]);
  });
});

describe("the audit's reader", () => {
  it("sees a split through a wrapped chain, a template separator and a regex separator", () => {
    expect(
      lineSplitsInSource(`
        const a = text
          .split("\\n")
          .map((line) => line.trim());
        const b = text.split(\`\\n\`);
        const c = text.split(/\\n/);
        const path = name.split("/");
      `),
    ).toHaveLength(3);
  });

  it("sees a split on a line that carries a URL, and one inside a template interpolation", () => {
    expect(
      lineSplitsInSource(
        'const note = `see https://example.com/${text.split("\\n").length}`;\nconst q = /"/;\nconst u = "https://x";\nconst rows = text.split("\\n");',
      ),
    ).toHaveLength(2);
  });

  it("reads the residual class as zero: a spelling that is not a literal member access with an LF literal", () => {
    expect(lineSplitsInSource('const NL = "\\n";\nconst rows = text.split(NL);')).toHaveLength(0);
    expect(lineSplitsInSource('const rows = text["split"]("\\n");')).toHaveLength(0);
    expect(lineSplitsInSource('const rows = text.split.bind(text)("\\n");')).toHaveLength(0);
    expect(lineSplitsInSource('const rows = text.split("\\r\\n");')).toHaveLength(0);
  });

  it("sees an optional chain, because that is a member access like any other", () => {
    expect(
      lineSplitsInSource('const a = text?.split("\\n");\nconst b = text.split?.("\\n");'),
    ).toHaveLength(2);
  });

  it("sees a primitive call written as a member, which this repo has", () => {
    expect(
      lineSplitsInSource(
        "const rows = visLines(text);\nconst other = deps.visLines(text);\nconst third = deps.splitLines(text);",
      ),
    ).toHaveLength(3);
  });

  it("sees a module reached at runtime, not only a static import", () => {
    expect(
      importsInSource(
        'import a from "./a.js";\nexport { b } from "./b.js";\nconst c = await import("./c.js");\nconst d = require("./d.js");',
      ),
    ).toEqual(["./a.js", "./b.js", "./c.js", "./d.js"]);
  });
});
