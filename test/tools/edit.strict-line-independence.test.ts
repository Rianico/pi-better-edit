/**
 * Line independence under `strict` span mode (ticket #304): a committing edit re-serves the whole
 * result, so anchors taken from one read keep resolving on later edits.
 *
 * Case 1 pins a chained flow (read 1-50, edit line 2, then edit lines 20-25 with no read in
 * between) as green. Case 2 pins the refusal a never-served interior span still earns before any
 * write. Case 3 pins the default `hint` acceptance of that same span, byte-exact.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, isMutationFailure, isMutationSuccess } from "../../src/mutation-engine/index.js";
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

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1} unique`);
const CONTENT = `${lines.join("\n")}\n`;

/** Fixture lines `from`..`to` inclusive, 1-based — independent of any edit result. */
function range(from: number, to: number): string[] {
  return lines.slice(from - 1, to);
}

const CHAINED_EXPECTED = [
  ...range(1, 2),
  "inserted",
  ...range(3, 19),
  "replacement",
  ...range(26, 60),
  "",
].join("\n");

const HINT_EXPECTED = [...range(1, 2), "blind", ...range(51, 60), ""].join("\n");

/** Serves lines 1-3 and 50-60 only, leaving the interior 4-49 never served in this session. */
async function readBoundaries(cwd: string): Promise<void> {
  const { ctx, readTool } = setupIntegrationTest(cwd);
  await readTool.execute(
    "r1",
    {
      file: "sample.txt",
      windows: [
        { offset: 1, limit: 3 },
        { offset: 50, limit: 11 },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
}

function blindSpanRequest(hashes: string[]): NormalizedEditRequest {
  return admit({
    file: "sample.txt",
    edits: [{ anchor_from: hashes[2]!, anchor_to: hashes[49]!, text: "blind" }],
  });
}

describe("line independence under strict span mode", () => {
  it("keeps a chained edit free of the earlier read boundary", async () => {
    await withTempFile("chained.txt", CONTENT, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      process.env[SPAN_MODE_ENV_VAR] = "strict";
      try {
        await readTool.execute(
          "r1",
          { file: "chained.txt", windows: [{ offset: 1, limit: 50 }] },
          undefined,
          undefined,
          ctx,
        );
        const h = await lineHashes(CONTENT, join(cwd, "chained.txt"));
        const first = await execute(
          admit({
            file: "chained.txt",
            edits: [{ anchor_from: h[1]!, anchor_to: h[1]!, text: "line 2 unique\ninserted" }],
          }),
          cwd,
          { sessionKey: TEST_SESSION_ID },
        );
        expect(
          isMutationSuccess(first),
          isMutationFailure(first) ? `${first.code} ${first.message}` : "first edit must commit",
        ).toBe(true);

        const second = await execute(
          admit({
            file: "chained.txt",
            edits: [{ anchor_from: h[19]!, anchor_to: h[24]!, text: "replacement" }],
          }),
          cwd,
          { sessionKey: TEST_SESSION_ID },
        );
        expect(
          isMutationSuccess(second),
          isMutationFailure(second)
            ? `${second.code} ${second.message}`
            : "second edit must commit",
        ).toBe(true);

        await expect(readFile(join(cwd, "chained.txt"), "utf-8")).resolves.toBe(CHAINED_EXPECTED);
      } finally {
        delete process.env[SPAN_MODE_ENV_VAR];
      }
    });
  });

  it("refuses a never-served interior span before any write", async () => {
    await withTempFile("sample.txt", CONTENT, async ({ cwd }) => {
      await readBoundaries(cwd);
      const h = await lineHashes(CONTENT, join(cwd, "sample.txt"));
      const before = await readFile(join(cwd, "sample.txt"));
      process.env[SPAN_MODE_ENV_VAR] = "strict";
      try {
        const result = await execute(blindSpanRequest(h), cwd, { sessionKey: TEST_SESSION_ID });
        expect(isMutationFailure(result), "strict must refuse the unserved interior").toBe(true);
        if (!isMutationFailure(result)) return;
        expect(result.code).toBe("E_UNSERVED_RANGE");
        expect(result.message).toContain("[MODEL] [E_UNSERVED_RANGE]");
        expect(result.message).toContain(
          "sample.txt: 46 of the 48 file lines it replaces were never served.\nUnserved file lines: 4-49",
        );
        expect(result.message).not.toContain("Current range");
        expect(result.servedRows ?? []).toEqual([]);
        expect(result.servedBlock ?? "").toBe("");
        const after = await readFile(join(cwd, "sample.txt"));
        expect(after.equals(before), "the refused edit must leave every byte unchanged").toBe(true);
      } finally {
        delete process.env[SPAN_MODE_ENV_VAR];
      }
    });
  });

  it("accepts the same span in the default hint mode", async () => {
    await withTempFile("sample.txt", CONTENT, async ({ cwd }) => {
      await readBoundaries(cwd);
      const h = await lineHashes(CONTENT, join(cwd, "sample.txt"));
      delete process.env[SPAN_MODE_ENV_VAR];
      const result = await execute(blindSpanRequest(h), cwd, { sessionKey: TEST_SESSION_ID });
      expect(
        isMutationSuccess(result),
        isMutationFailure(result) ? `${result.code} ${result.message}` : "hint must accept",
      ).toBe(true);
      await expect(readFile(join(cwd, "sample.txt"), "utf-8")).resolves.toBe(HINT_EXPECTED);
    });
  });
});
