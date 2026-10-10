import { describe, expect, it } from "vitest";
import { SERVED_MAX_LINES } from "../../src/constants.js";
import { toLF } from "../../src/edit-diff.js";
import { fileHashesFor } from "../../src/hashline";
import { setupReadTest, withTempFile } from "../support/fixtures";

// Provenance. The verbatim goldens below are static literals (verbatim renders no anchors).
// The served goldens cannot be static literals: since file scoping, served anchors are seeded from
// the served file's absolute path, and these tests read through the tool from per-run temp dirs —
// a literal captured on one machine would be a lie on the next. So each served case pins its
// content rows and pagination chrome literally through a builder over the whole-content assignment
// for the SAME absolute path the tool served (`fileHashesFor(path, content)`), which the loader's
// own derivation agrees with anchor for anchor (see test/core/anchor-walk-identity.test.ts). A
// derivation change (width, seed, canon, stride) moves the builders' output and fails loudly here.
// WHY: the walk must hold the split-based reader's pages, hints and refusals byte for byte — in BOTH
// WHY: render modes, since the anchor array and the page now come out of one walk.
const NL = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") + "\n";
const CRLF = "a\r\nb\r\nc\r\n";
const LONE_CR = "one\rtwo\nthree";
const NO_TRAILING = Array.from({ length: 5 }, (_, i) => `n${i}`).join("\n");

// The per-file header every tool-level golden now opens with (spec §4.4). The line count is written
// out per case rather than recomputed, so a count regression fails here instead of agreeing with itself.
const servedHeader = (lines: number) => `[golden.txt (${lines} lines total)]\n`;
const verbatimHeader = (lines: number) => `[golden.txt (verbatim, ${lines} lines, no anchors)]\n`;

const VERBATIM_GOLDENS: Array<[string, string, Record<string, unknown>, string]> = [
  [
    "the first page",
    NL,
    { offset: 1, limit: 5 },
    `${verbatimHeader(40)}l0\nl1\nl2\nl3\nl4\n\n[golden.txt lines 1-5 of 40. Use windows: [{ offset: 6, limit: 5 }] to continue.]`,
  ],
  [
    "a middle page",
    NL,
    { offset: 17, limit: 5 },
    `${verbatimHeader(40)}l16\nl17\nl18\nl19\nl20\n\n[golden.txt lines 17-21 of 40. Use windows: [{ offset: 22, limit: 5 }] to continue.]`,
  ],
  ["the last page", NL, { offset: 38, limit: 10 }, `${verbatimHeader(40)}l37\nl38\nl39`],
  [
    "a page past the end",
    NL,
    { offset: 50, limit: 5 },
    `${verbatimHeader(40)}Offset 50 is beyond end of file (40 lines total). Use offset=1 to read from the start, or offset=40 to read the last line.`,
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
    `${verbatimHeader(40)}=== Lines 2-3 of 40 ===\nl1\nl2\n\n=== Lines 20-22 of 40 ===\nl19\nl20\nl21`,
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
    `${verbatimHeader(40)}=== Lines 3-5 of 40 ===\nl2\nl3\nl4\n\n=== Lines 4-6 of 40 ===\nl3\nl4\nl5`,
  ],
  [
    "a limit alone",
    NL,
    { limit: 7 },
    `${verbatimHeader(40)}l0\nl1\nl2\nl3\nl4\nl5\nl6\n\n[golden.txt lines 1-7 of 40. Use windows: [{ offset: 8, limit: 7 }] to continue.]`,
  ],
  [
    "no arguments (the whole file)",
    NL,
    {},
    `${verbatimHeader(40)}${Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n")}`,
  ],
  [
    "the page ending on the last line",
    NL,
    { offset: 39, limit: 9 },
    `${verbatimHeader(40)}l38\nl39`,
  ],
  ["CRLF text (normalized to LF)", CRLF, {}, `${verbatimHeader(3)}a\nb\nc`],
  ["a lone \\r is not a break", LONE_CR, {}, `${verbatimHeader(3)}one\ntwo\nthree`],
  ["no trailing newline", NO_TRAILING, {}, `${verbatimHeader(5)}n0\nn1\nn2\nn3\nn4`],
  ["an empty file", "", {}, `${verbatimHeader(0)}[File is empty.]`],
  ["a file that is one newline", "\n", {}, `${verbatimHeader(1)}[1 empty line]`],
];

type AnchorOracle = (anchors: string[]) => string;

const SERVED_CASES: Array<[string, string, Record<string, unknown>, AnchorOracle]> = [
  [
    "the first page",
    NL,
    { offset: 1, limit: 5 },
    (a) =>
      `${servedHeader(40)}${a[0]}│l0\n${a[1]}│l1\n${a[2]}│l2\n${a[3]}│l3\n${a[4]}│l4\n\n[golden.txt lines 1-5 of 40. Use windows: [{ offset: 6, limit: 5 }] to continue.]`,
  ],
  [
    "a middle page",
    NL,
    { offset: 17, limit: 5 },
    (a) =>
      `${servedHeader(40)}${a[16]}│l16\n${a[17]}│l17\n${a[18]}│l18\n${a[19]}│l19\n${a[20]}│l20\n\n[golden.txt lines 17-21 of 40. Use windows: [{ offset: 22, limit: 5 }] to continue.]`,
  ],
  [
    "the last page",
    NL,
    { offset: 38, limit: 10 },
    (a) => `${servedHeader(40)}${a[37]}│l37\n${a[38]}│l38\n${a[39]}│l39`,
  ],
  [
    "a page past the end",
    NL,
    { offset: 50, limit: 5 },
    () =>
      `${servedHeader(40)}Offset 50 is beyond end of file (40 lines total). Use offset=1 to read from the start, or offset=40 to read the last line.`,
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
    (a) =>
      `${servedHeader(40)}=== Lines 2-3 of 40 ===\n${a[1]}│l1\n${a[2]}│l2\n\n=== Lines 20-22 of 40 ===\n${a[19]}│l19\n${a[20]}│l20\n${a[21]}│l21`,
  ],
  [
    "a limit alone",
    NL,
    { limit: 7 },
    (a) =>
      `${servedHeader(40)}${a[0]}│l0\n${a[1]}│l1\n${a[2]}│l2\n${a[3]}│l3\n${a[4]}│l4\n${a[5]}│l5\n${a[6]}│l6\n\n[golden.txt lines 1-7 of 40. Use windows: [{ offset: 8, limit: 7 }] to continue.]`,
  ],
  [
    "no trailing newline",
    NO_TRAILING,
    {},
    (a) => `${servedHeader(5)}${a[0]}│n0\n${a[1]}│n1\n${a[2]}│n2\n${a[3]}│n3\n${a[4]}│n4`,
  ],
  [
    "an empty file",
    "",
    {},
    (a) => `${servedHeader(0)}${a[0]}│\n[File is empty. Use edit to insert content.]`,
  ],
  ["a file that is one newline", "\n", {}, (a) => `${servedHeader(1)}${a[0]}│`],
  [
    "CRLF text (normalized to LF)",
    CRLF,
    {},
    (a) => `${servedHeader(3)}${a[0]}│a\n${a[1]}│b\n${a[2]}│c`,
  ],
  [
    "a lone \\r is not a break",
    LONE_CR,
    {},
    (a) => `${servedHeader(3)}${a[0]}│one\n${a[1]}│two\n${a[2]}│three`,
  ],
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

async function readServed(
  file: string,
  content: string,
  args: Record<string, unknown>,
): Promise<{ text: string; anchors: string[] }> {
  let text = "";
  let anchors: string[] = [];
  await withTempFile(file, content, async ({ cwd, path }) => {
    const { readTool, ctx } = setupReadTest(cwd);
    const result = await readTool.execute("r1", { file, ...args }, undefined, undefined, ctx);
    text = result.content?.[0]?.text ?? "";
    // WHY: the oracle is derived for the same absolute path the tool served — the loader's own
    // WHY: derivation agrees with it anchor for anchor (probed in anchor-walk-identity), so the
    // WHY: builders below still fail loudly on any derivation change. Normalized first: the tool
    // WHY: hashes post-`toLF` text, and a lone `\r` only becomes a line break there.
    anchors = fileHashesFor(path, toLF(content));
  });
  return { text, anchors };
}
describe("a verbatim page is what the split-based reader returned", () => {
  it.each(VERBATIM_GOLDENS)("renders %s byte for byte", async (_name, content, args, golden) => {
    await expect(read("golden.txt", content, { mode: "verbatim", ...args })).resolves.toBe(golden);
  });
});

describe("a served page is what the split-based reader returned", () => {
  it.each(SERVED_CASES)("renders %s byte for byte", async (_name, content, args, expected) => {
    const { text, anchors } = await readServed("golden.txt", content, args);
    for (const anchor of anchors) expect(anchor).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(text).toBe(expected(anchors));
  });
});

describe("the served read's refusals", () => {
  it("still names the line count at the cap boundary (the loader's own check)", async () => {
    // WHY: a CR-only file slips past the streaming newline counter (no LF in the raw bytes), so
    // WHY: the loader's own normalized-text check fires with the exact count against the served
    // WHY: budget — the same seam the CR-only budget test in hashline-limit exercises.
    const content = "x\r".repeat(SERVED_MAX_LINES + 1);
    await withTempFile("huge.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const error = await readTool
        .execute("r1", { file: "huge.ts" }, undefined, undefined, ctx)
        .then(
          () => undefined,
          (thrown: unknown) => thrown as Error,
        );
      expect(error?.message).toBe(
        `[MODEL] [E_LARGE_FILE] huge.ts has ${SERVED_MAX_LINES + 1} lines, exceeding the ${SERVED_MAX_LINES}-line edit limit.`,
      );
    });
  });

  it("still refuses mid-decode above the cap (the early throw, no line count)", async () => {
    // WHY: the streaming counter trips on raw newlines long before the loader's own check could
    // WHY: name a total, so the refusal says "more than" against the served budget and carries no
    // WHY: lineCount — the same wording the over-budget test in hashline-limit pins.
    const content = Array.from({ length: SERVED_MAX_LINES + 100 }, () => "x").join("\n") + "\n";
    await withTempFile("huge.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const error = await readTool
        .execute("r1", { file: "huge.ts" }, undefined, undefined, ctx)
        .then(
          () => undefined,
          (thrown: unknown) => thrown as Error,
        );
      expect(error?.message).toBe(
        `[MODEL] [E_LARGE_FILE] huge.ts has more than ${SERVED_MAX_LINES} lines, exceeding the ${SERVED_MAX_LINES}-line edit limit.`,
      );
    });
  });
});
