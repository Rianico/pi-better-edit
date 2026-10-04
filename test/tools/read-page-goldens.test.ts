import { describe, expect, it } from "vitest";
import { MAX_HASH_LINES } from "../../src/hashline";
import { setupReadTest, withTempFile } from "../support/fixtures";

// Provenance, verified by an independent review rather than by this file: these literals were captured
// from the implementation before this branch (6bca8d9), and a clean `git archive main` checkout
// reproduces them — the anchor arrays for NL, CRLF, LONE_CR, NO_TRAILING and the empty file are
// byte-identical to main's served output, constants included (`MEo,Mxn,nZ8,OMe,u9d`,
// `658,tgj,nHm,pLz,1nL`, `AuN`). To re-verify: extract main (`git archive main | tar -x -C <dir>`, and
// symlink this tree's `node_modules`), run this file there, and diff the rendered pages.
//
// WHY: the walk must hold the split-based reader's pages, hints and refusals byte for byte — in BOTH
// WHY: render modes, since the anchor array and the page now come out of one walk.
const NL = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") + "\n";
const CRLF = "a\r\nb\r\nc\r\n";
const LONE_CR = "one\rtwo\nthree";
const NO_TRAILING = Array.from({ length: 5 }, (_, i) => `n${i}`).join("\n");

const VERBATIM_GOLDENS: Array<[string, string, Record<string, unknown>, string]> = [
  [
    "the first page",
    NL,
    { offset: 1, limit: 5 },
    `l0\nl1\nl2\nl3\nl4\n\n[Showing lines 1-5 of 40. Use offset=6 to continue.]`,
  ],
  [
    "a middle page",
    NL,
    { offset: 17, limit: 5 },
    `l16\nl17\nl18\nl19\nl20\n\n[Showing lines 17-21 of 40. Use offset=22 to continue.]`,
  ],
  ["the last page", NL, { offset: 38, limit: 10 }, `l37\nl38\nl39`],
  [
    "a page past the end",
    NL,
    { offset: 50, limit: 5 },
    `Offset 50 is beyond end of file (40 lines total). Use offset=1 to read from the start, or offset=40 to read the last line.`,
  ],
  [
    "disjoint windows",
    NL,
    {
      windows: [
        { offset: 2, limit: 2 },
        { offset: 20, limit: 3 },
      ],
    },
    `=== Lines 2-3 of 40 ===\nl1\nl2\n\n=== Lines 20-22 of 40 ===\nl19\nl20\nl21`,
  ],
  [
    "overlapping windows",
    NL,
    {
      windows: [
        { offset: 3, limit: 3 },
        { offset: 4, limit: 3 },
      ],
    },
    `=== Lines 3-5 of 40 ===\nl2\nl3\nl4\n\n=== Lines 4-6 of 40 ===\nl3\nl4\nl5`,
  ],
  [
    "a limit alone",
    NL,
    { limit: 7 },
    `l0\nl1\nl2\nl3\nl4\nl5\nl6\n\n[Showing lines 1-7 of 40. Use offset=8 to continue.]`,
  ],
  [
    "no arguments (the whole file)",
    NL,
    {},
    Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n"),
  ],
  ["the page ending on the last line", NL, { offset: 39, limit: 9 }, `l38\nl39`],
  ["CRLF text (normalized to LF)", CRLF, {}, `a\nb\nc`],
  ["a lone \\r is not a break", LONE_CR, {}, `one\ntwo\nthree`],
  ["no trailing newline", NO_TRAILING, {}, `n0\nn1\nn2\nn3\nn4`],
  ["an empty file", "", {}, `[File is empty.]`],
  ["a file that is one newline", "\n", {}, `[1 empty line]`],
];

const SERVED_GOLDENS: Array<[string, string, Record<string, unknown>, string]> = [
  [
    "the first page",
    NL,
    { offset: 1, limit: 5 },
    `MEo│l0\nMxn│l1\nnZ8│l2\nOMe│l3\nu9d│l4\n\n[Showing lines 1-5 of 40. Use offset=6 to continue.]`,
  ],
  [
    "a middle page",
    NL,
    { offset: 17, limit: 5 },
    `79X│l16\nuce│l17\n2NQ│l18\nhjS│l19\nkaJ│l20\n\n[Showing lines 17-21 of 40. Use offset=22 to continue.]`,
  ],
  ["the last page", NL, { offset: 38, limit: 10 }, `dZG│l37\nVLL│l38\nAee│l39`],
  [
    "a page past the end",
    NL,
    { offset: 50, limit: 5 },
    `Offset 50 is beyond end of file (40 lines total). Use offset=1 to read from the start, or offset=40 to read the last line.`,
  ],
  [
    "disjoint windows",
    NL,
    {
      windows: [
        { offset: 2, limit: 2 },
        { offset: 20, limit: 3 },
      ],
    },
    `=== Lines 2-3 of 40 ===\nMxn│l1\nnZ8│l2\n\n=== Lines 20-22 of 40 ===\nhjS│l19\nkaJ│l20\n170│l21`,
  ],
  [
    "a limit alone",
    NL,
    { limit: 7 },
    `MEo│l0\nMxn│l1\nnZ8│l2\nOMe│l3\nu9d│l4\ndRS│l5\na8d│l6\n\n[Showing lines 1-7 of 40. Use offset=8 to continue.]`,
  ],
  ["no trailing newline", NO_TRAILING, {}, `658│n0\ntgj│n1\nnHm│n2\npLz│n3\n1nL│n4`],
  ["an empty file", "", {}, `AuN│\n[File is empty. Use edit to insert content.]`],
  ["a file that is one newline", "\n", {}, `AuN│`],
];

async function read(file: string, content: string, args: Record<string, unknown>): Promise<string> {
  let text = "";
  await withTempFile(file, content, async ({ cwd }) => {
    const { readTool, ctx } = setupReadTest(cwd);
    const result = await readTool.execute("r1", { file, ...args }, undefined, undefined, ctx);
    text = result.content?.[0]?.text ?? "";
  });
  return text;
}

describe("a verbatim page is what the split-based reader returned", () => {
  it.each(VERBATIM_GOLDENS)("renders %s byte for byte", async (_name, content, args, golden) => {
    await expect(read("golden.txt", content, { mode: "verbatim", ...args })).resolves.toBe(golden);
  });
});

describe("a served page is what the split-based reader returned", () => {
  it.each(SERVED_GOLDENS)("renders %s byte for byte", async (_name, content, args, golden) => {
    await expect(read("golden.txt", content, args)).resolves.toBe(golden);
  });
});

describe("the served read's refusals", () => {
  it("still names the line count at the cap boundary (the loader's own check)", async () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n");
    await withTempFile("huge.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const error = await readTool
        .execute("r1", { file: "huge.ts" }, undefined, undefined, ctx)
        .then(
          () => undefined,
          (thrown: unknown) => thrown as Error,
        );
      expect(error?.message).toBe(
        "[MODEL] [E_LARGE_FILE] huge.ts has 238329 lines, exceeding the 238328-line edit limit. " +
          "Hashline editing targets source-sized files; for very large files use write or a non-line-based approach.",
      );
    });
  }, 300_000);

  it("still refuses mid-decode above the cap (the early throw, no line count)", async () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n") + "\n";
    await withTempFile("huge.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const error = await readTool
        .execute("r1", { file: "huge.ts" }, undefined, undefined, ctx)
        .then(
          () => undefined,
          (thrown: unknown) => thrown as Error,
        );
      expect(error?.message).toBe(
        "[MODEL] [E_LARGE_FILE] huge.ts has more than 238328 lines, exceeding the 238328-line edit limit. " +
          "Hashline editing targets source-sized files; for very large files use write or a non-line-based approach.",
      );
    });
  }, 300_000);
});
