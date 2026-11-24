/**
/**
 * The unserved-interior warning, tool level (ticket #306). Hint mode applied an edit whose span
 * removed at least one interior line this session never served: the applied-tier
 * `[W_UNSERVED_INTERIOR]` names the replaced file-line count, the unserved count, and the
 * compressed absolute-line list once per committed file (ticket #319). A fully served edit never
 * emits it, and strict mode refuses the same span instead of warning.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { execute, isMutationFailure, isMutationSuccess } from "../../src/mutation-engine/index.js";
import type { MutationSuccess } from "../../src/mutation-engine/types.js";
import { assertReq, normReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { initHasher, lineHashes } from "../../src/hashline/hash-identity.js";
import { SPAN_MODE_ENV_VAR } from "../../src/span-mode-config.js";
import {
  setupIntegrationTest,
  withTempFile,
  TEST_SESSION_ID,
  useTestHome,
} from "../support/fixtures.js";

useTestHome();

beforeAll(async () => {
  await initHasher();
});

afterEach(() => {
  delete process.env[SPAN_MODE_ENV_VAR];
});

const TOKEN = "[W_UNSERVED_INTERIOR]";

const GAP_CONTENT = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";
const SHORT_CONTENT = "m1\nm2\nm3\nm4\nm5\n";
const FOLD_LINES = Array.from({ length: 60 }, (_, i) => `line ${i + 1} unique`);
const FOLD_CONTENT = `${FOLD_LINES.join("\n")}\n`;

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

async function serve(
  cwd: string,
  file: string,
  windows: Array<{ offset: number; limit?: number }>,
): Promise<void> {
  const { ctx, readTool } = setupIntegrationTest(cwd);
  await readTool.execute("r1", { file, windows }, undefined, undefined, ctx);
}

async function applied(request: NormalizedEditRequest, cwd: string): Promise<MutationSuccess> {
  const result = await execute(request, cwd, { sessionKey: TEST_SESSION_ID });
  expect(
    isMutationSuccess(result),
    isMutationFailure(result) ? `${result.code} ${result.message}` : "the edit must commit",
  ).toBe(true);
  if (!isMutationSuccess(result)) throw new Error("unreachable: asserted applied above");
  return result;
}

const modelText = (result: MutationSuccess): string => result.toolResult.content[0]!.text;
const warningsOf = (result: MutationSuccess): string[] => result.toolResult.details.warnings ?? [];
const warningLines = (result: MutationSuccess): string[] =>
  warningsOf(result).filter((warning) => warning.includes(TOKEN));

describe("unserved interior replaced under hint mode", () => {
  it("names the count and range of the unserved gap exactly once", async () => {
    await withTempFile("sample.txt", GAP_CONTENT, async ({ cwd }) => {
      await serve(cwd, "sample.txt", [{ offset: 1, limit: 3 }, { offset: 7 }]);
      const h = await lineHashes(GAP_CONTENT, join(cwd, "sample.txt"));
      const result = await applied(
        admit({
          file: "sample.txt",
          edits: [{ anchor_from: h[2]!, anchor_to: h[6]!, text: "X\nY\nZ\nW\nV" }],
        }),
        cwd,
      );

      const expected =
        "[MODEL] [W_UNSERVED_INTERIOR] Span replaced 5 file lines, 3 of which were never served; " +
        "the edit applied.\nUnserved file lines: 4-6\n" +
        "Edits should only modify lines previously read and served (enforced under strict mode); " +
        "verify this uninspected replacement was intended.";

      expect(warningLines(result)).toEqual([expected]);
      expect(modelText(result).split(TOKEN)).toHaveLength(2);
      expect(modelText(result)).toContain(expected);
    });
  });

  it("names a single unserved interior line as one line, never a collapsed range", async () => {
    await withTempFile("sample.txt", SHORT_CONTENT, async ({ cwd }) => {
      await serve(cwd, "sample.txt", [{ offset: 1, limit: 2 }, { offset: 4 }]);
      const h = await lineHashes(SHORT_CONTENT, join(cwd, "sample.txt"));
      const result = await applied(
        admit({
          file: "sample.txt",
          edits: [{ anchor_from: h[1]!, anchor_to: h[3]!, text: "M" }],
        }),
        cwd,
      );

      expect(warningLines(result)).toEqual([
        "[MODEL] [W_UNSERVED_INTERIOR] Span replaced 3 file lines, 1 of which was never served; " +
          "the edit applied.\nUnserved file line: 3\n" +
          "Edits should only modify lines previously read and served (enforced under strict mode); " +
          "verify this uninspected replacement was intended.",
      ]);
    });
  });

  it("lists non-contiguous unserved runs instead of a min..max envelope", async () => {
    await withTempFile("sample.txt", GAP_CONTENT, async ({ cwd }) => {
      await serve(cwd, "sample.txt", [
        { offset: 1, limit: 2 },
        { offset: 5, limit: 1 },
        { offset: 9 },
      ]);
      const h = await lineHashes(GAP_CONTENT, join(cwd, "sample.txt"));
      const result = await applied(
        admit({
          file: "sample.txt",
          edits: [{ anchor_from: h[1]!, anchor_to: h[8]!, text: "R" }],
        }),
        cwd,
      );

      expect(warningLines(result)).toEqual([
        "[MODEL] [W_UNSERVED_INTERIOR] Span replaced 8 file lines, 5 of which were never served; " +
          "the edit applied.\nUnserved file lines: 3-4, 6-8\n" +
          "Edits should only modify lines previously read and served (enforced under strict mode); " +
          "verify this uninspected replacement was intended.",
      ]);
    });
  });

  it("stays silent when every replaced line was served", async () => {
    await withTempFile("sample.txt", SHORT_CONTENT, async ({ cwd }) => {
      await serve(cwd, "sample.txt", [{ offset: 1, limit: 3 }]);
      const h = await lineHashes(SHORT_CONTENT, join(cwd, "sample.txt"));
      const result = await applied(
        admit({
          file: "sample.txt",
          edits: [{ anchor_from: h[1]!, anchor_to: h[1]!, text: "two" }],
        }),
        cwd,
      );

      expect(modelText(result)).not.toContain(TOKEN);
      expect(warningsOf(result).some((warning) => warning.includes(TOKEN))).toBe(false);
    });
  });

  it("counts unserved interiors independently of the folded diff cap", async () => {
    await withTempFile("sample.txt", FOLD_CONTENT, async ({ cwd }) => {
      await serve(cwd, "sample.txt", [
        { offset: 1, limit: 3 },
        { offset: 20, limit: 6 },
        { offset: 50, limit: 11 },
      ]);
      const h = await lineHashes(FOLD_CONTENT, join(cwd, "sample.txt"));
      const result = await applied(
        admit({
          file: "sample.txt",
          edits: [{ anchor_from: h[2]!, anchor_to: h[49]!, text: "blind" }],
        }),
        cwd,
      );

      expect(warningLines(result)).toEqual([
        "[MODEL] [W_UNSERVED_INTERIOR] Span replaced 48 file lines, 40 of which were never served; " +
          "the edit applied.\nUnserved file lines: 4-19, 26-49\n" +
          "Edits should only modify lines previously read and served (enforced under strict mode); " +
          "verify this uninspected replacement was intended.",
      ]);
      expect(result.diff.split("\n")).toContain(" - ... [44 lines deleted (38 unserved)] ...");
    });
  });

  it("emits for an explicitly selected hint mode and stays silent when strict refuses", async () => {
    await withTempFile("sample.txt", SHORT_CONTENT, async ({ cwd }) => {
      await serve(cwd, "sample.txt", [{ offset: 1, limit: 2 }, { offset: 4 }]);
      const h = await lineHashes(SHORT_CONTENT, join(cwd, "sample.txt"));
      process.env[SPAN_MODE_ENV_VAR] = "hint";
      const hinted = await applied(
        admit({
          file: "sample.txt",
          edits: [{ anchor_from: h[1]!, anchor_to: h[3]!, text: "M" }],
        }),
        cwd,
      );
      expect(warningLines(hinted)).toHaveLength(1);
      expect(modelText(hinted)).toContain("Unserved file line: 3");
    });

    await withTempFile("sample.txt", SHORT_CONTENT, async ({ cwd }) => {
      await serve(cwd, "sample.txt", [{ offset: 1, limit: 2 }, { offset: 4 }]);
      const h = await lineHashes(SHORT_CONTENT, join(cwd, "sample.txt"));
      process.env[SPAN_MODE_ENV_VAR] = "strict";
      const refused = await execute(
        admit({
          file: "sample.txt",
          edits: [{ anchor_from: h[1]!, anchor_to: h[3]!, text: "M" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );

      expect(isMutationFailure(refused), "strict mode must refuse the unserved interior").toBe(
        true,
      );
      if (!isMutationFailure(refused)) return;
      expect(refused.code).toBe("E_UNSERVED_RANGE");
      expect(refused.message).not.toContain(TOKEN);
    });
  });
});
