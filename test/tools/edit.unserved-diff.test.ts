/**
 * Unserved removals in the applied diff, hint mode (ticket #305). A removed row whose original line
 * this session never served renders with the empty 4-space gutter, so the diff never hands back an
 * anchor the session cannot honour; a deletion above the fold cap names how many of the rows its
 * marker hides were never served. A fully served removal keeps its anchors exactly as before.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { execute, isMutationFailure, isMutationSuccess } from "../../src/mutation-engine/index.js";
import { assertReq, normReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { ANCHOR_LEN, HASH_SEP, initHasher, lineHashes } from "../../src/hashline/hash-identity.js";
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

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

const GUTTER = " ".repeat(ANCHOR_LEN) + HASH_SEP;

const GAP_CONTENT = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";

const FOLD_LINES = Array.from({ length: 60 }, (_, i) => `line ${i + 1} unique`);
const FOLD_CONTENT = `${FOLD_LINES.join("\n")}\n`;

async function readWindows(
  cwd: string,
  file: string,
  windows: Array<{ offset: number; limit?: number }>,
): Promise<void> {
  const { ctx, readTool } = setupIntegrationTest(cwd);
  await readTool.execute("r1", { file, windows }, undefined, undefined, ctx);
}

async function editResult(request: NormalizedEditRequest, cwd: string): Promise<string> {
  const result = await execute(request, cwd, { sessionKey: TEST_SESSION_ID });
  expect(
    isMutationSuccess(result),
    isMutationFailure(result) ? `${result.code} ${result.message}` : "the edit must commit",
  ).toBe(true);
  return isMutationSuccess(result) ? result.diff : "";
}

const removedRows = (diff: string): string[] =>
  diff.split("\n").filter((line) => /^-(?: {4}|[A-Za-z0-9]{4})│/.test(line));
describe("unserved removals in the hint-mode diff", () => {
  it("blanks the gutter of every removed row the session never served", async () => {
    await withTempFile("sample.txt", GAP_CONTENT, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute(
        "r1",
        { file: "sample.txt", windows: [{ offset: 1, limit: 3 }, { offset: 7 }] },
        undefined,
        undefined,
        ctx,
      );
      const h = await lineHashes(GAP_CONTENT, join(cwd, "sample.txt"));
      const request = admit({
        file: "sample.txt",
        edits: [{ anchor_from: h[2]!, anchor_to: h[6]!, text: "X\nY\nZ\nW\nV" }],
      });

      const diff = await editResult(request, cwd);
      const rows = diff.split("\n");

      expect(removedRows(diff)).toEqual([
        `-${h[2]}│l3`,
        `-${GUTTER}l4`,
        `-${GUTTER}l5`,
        `-${GUTTER}l6`,
        `-${h[6]}│l7`,
      ]);
      const added = rows.filter((line) => line.startsWith("+"));
      expect(added).toHaveLength(5);
      expect(added.map((line) => line.slice(ANCHOR_LEN + 2))).toEqual(["X", "Y", "Z", "W", "V"]);
      for (const row of added) expect(row.slice(1, ANCHOR_LEN + 1)).toMatch(/^[A-Za-z0-9]{4}$/);
      for (const row of rows.filter((line) => line.includes(HASH_SEP))) {
        expect(row.indexOf(HASH_SEP)).toBe(ANCHOR_LEN + 1);
      }
    });
  });

  it("keeps the anchor of a removal the session did serve", async () => {
    await withTempFile("sample.txt", GAP_CONTENT, async ({ cwd }) => {
      await readWindows(cwd, "sample.txt", [{ offset: 1, limit: 3 }]);
      const h = await lineHashes(GAP_CONTENT, join(cwd, "sample.txt"));
      const request = admit({
        file: "sample.txt",
        edits: [{ anchor_from: h[1]!, anchor_to: h[1]!, text: "two" }],
      });

      const diff = await editResult(request, cwd);

      expect(removedRows(diff)).toEqual([`-${h[1]}│l2`]);
    });
  });

  it("omits the mirror under strict mode and carries it under hint", async () => {
    await withTempFile("sample.txt", GAP_CONTENT, async ({ cwd }) => {
      await readWindows(cwd, "sample.txt", [{ offset: 1 }]);
      const h = await lineHashes(GAP_CONTENT, join(cwd, "sample.txt"));

      process.env[SPAN_MODE_ENV_VAR] = "strict";
      const strict = await execute(
        admit({
          file: "sample.txt",
          edits: [{ anchor_from: h[1]!, anchor_to: h[1]!, text: "two" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(
        isMutationSuccess(strict),
        isMutationFailure(strict) ? `${strict.code} ${strict.message}` : "strict edit must commit",
      ).toBe(true);
      if (isMutationSuccess(strict)) expect(strict.raw.served).toBeUndefined();

      delete process.env[SPAN_MODE_ENV_VAR];
      const hinted = await execute(
        admit({
          file: "sample.txt",
          edits: [{ anchor_from: h[2]!, anchor_to: h[2]!, text: "three" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(
        isMutationSuccess(hinted),
        isMutationFailure(hinted) ? `${hinted.code} ${hinted.message}` : "hint edit must commit",
      ).toBe(true);
      if (isMutationSuccess(hinted)) expect(hinted.raw.served).toHaveLength(9);
    });
  });

  it("counts the unserved rows a folded deletion hides", async () => {
    await withTempFile("sample.txt", FOLD_CONTENT, async ({ cwd }) => {
      await readWindows(cwd, "sample.txt", [
        { offset: 1, limit: 3 },
        { offset: 20, limit: 6 },
        { offset: 50, limit: 11 },
      ]);
      const h = await lineHashes(FOLD_CONTENT, join(cwd, "sample.txt"));
      const request = admit({
        file: "sample.txt",
        edits: [{ anchor_from: h[2]!, anchor_to: h[49]!, text: "blind" }],
      });

      const diff = await editResult(request, cwd);
      const rows = diff.split("\n");

      expect(rows).toContain(" - ... [44 lines deleted (38 unserved)] ...");
      expect(removedRows(diff)).toEqual([
        `-${h[2]}│line 3 unique`,
        `-${GUTTER}line 4 unique`,
        `-${GUTTER}line 49 unique`,
        `-${h[49]}│line 50 unique`,
      ]);
      for (const row of rows.filter((line) => line.includes(HASH_SEP))) {
        expect(row.indexOf(HASH_SEP)).toBe(ANCHOR_LEN + 1);
      }
    });
  });
});
