/**
 * Strict span mode, tool level (ticket #303): two paged reads leave lines 4-6 unserved, so an edit
 * whose span crosses that gap is a served interior row the session never served. `hint` (the
 * default) keeps accepting it, byte-identical to ADR-0024; `strict` refuses it before any write
 * with the rowless `[E_UNSERVED_RANGE]` and leaves the file unchanged.
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

const CONTENT = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

/** Serves lines 1-3 and 7-9 only, then returns the request spanning the unserved 4-6 gap. */
async function serveBoundaries(cwd: string): Promise<NormalizedEditRequest> {
  const { ctx, readTool } = setupIntegrationTest(cwd);
  await readTool.execute(
    "r1",
    { file: "sample.txt", windows: [{ offset: 1, limit: 3 }] },
    undefined,
    undefined,
    ctx,
  );
  await readTool.execute(
    "r2",
    { file: "sample.txt", windows: [{ offset: 7 }] },
    undefined,
    undefined,
    ctx,
  );
  const hashes = await lineHashes(CONTENT, join(cwd, "sample.txt"));
  return admit({
    file: "sample.txt",
    edits: [{ anchor_from: hashes[2]!, anchor_to: hashes[6]!, text: "X\nY\nZ\nW\nV" }],
  });
}

describe("edit under an unserved interior span", () => {
  it("refuses the span in strict mode with the rowless [E_UNSERVED_RANGE] and writes nothing", async () => {
    await withTempFile("sample.txt", CONTENT, async ({ cwd }) => {
      const request = await serveBoundaries(cwd);
      const before = await readFile(join(cwd, "sample.txt"), "utf-8");
      process.env[SPAN_MODE_ENV_VAR] = "strict";
      const result = await execute(request, cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationFailure(result), "strict mode must refuse the unserved interior").toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_UNSERVED_RANGE");
      expect(result.message).toContain("[MODEL] [E_UNSERVED_RANGE]");
      expect(result.message).toContain("line 4-6");
      expect(result.message).toContain("were never served in this session.");
      expect(result.message).not.toContain("Current range");
      await expect(readFile(join(cwd, "sample.txt"), "utf-8")).resolves.toBe(before);
    });
  });

  it("accepts the same span in the default hint mode", async () => {
    await withTempFile("sample.txt", CONTENT, async ({ cwd }) => {
      const request = await serveBoundaries(cwd);
      const result = await execute(request, cwd, { sessionKey: TEST_SESSION_ID });
      expect(
        isMutationSuccess(result),
        isMutationFailure(result) ? `${result.code} ${result.message}` : "hint mode must accept",
      ).toBe(true);
      await expect(readFile(join(cwd, "sample.txt"), "utf-8")).resolves.toBe(
        "l1\nl2\nX\nY\nZ\nW\nV\nl8\nl9\n",
      );
    });
  });
});
