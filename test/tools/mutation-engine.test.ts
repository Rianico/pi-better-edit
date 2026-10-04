import { describe, expect, it, beforeAll } from "vitest";
import { join } from "path";
import { readFile } from "node:fs/promises";
import {
  execute,
  preview,
  isMutationSuccess,
  isMutationFailure,
} from "../../src/mutation-engine/index.js";
import { withTempFile, setupIntegrationTest, TEST_SESSION_ID } from "../support/fixtures.js";
import { normReq, assertReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { genDiff } from "../../src/edit-diff.js";
import { DIFF_PREVIEW_CONTEXT } from "../../src/constants.js";
import { lineHashes } from "../../src/hashline/index.js";
import { initHasher } from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

// WHY: the engine seam's input is the admission-normalized request (ticket-01 union) — these
// WHY: fixtures hand the wire payload through the same admission boundary the tool uses.
function req(input: unknown): NormalizedEditRequest {
  const normalized = normReq(input);
  assertReq(normalized);
  return normalized;
}

useTestHome();

beforeAll(async () => {
  await initHasher();
});

describe("MutationEngine — deep seam", () => {
  it("execute returns ok:true with diff and metrics for single edit", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const from = hashes[0]!;
      const to = hashes[1]!;
      const result = await execute(
        req({
          file: "sample.txt",
          edits: [{ anchor_from: from, anchor_to: to, text: "x\ny" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (isMutationSuccess(result)) {
        expect(result.result).toBe("x\ny\nc\n");
        expect(result.diff).toContain("x");
        expect(result.metrics.classification).toBe("applied");
        expect(result.raw.appliedCount).toBe(1);
      }
    });
  });

  it("preview does not persist and shares the same internal path as execute", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const from = hashes[0]!;
      const result = await preview(
        req({
          file: "sample.txt",
          edits: [{ anchor_from: from, anchor_to: from, text: "replaced" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (isMutationSuccess(result)) {
        expect(result.result).toBe("replaced\nb\nc\n");
        const persisted = await readFile(`${cwd}/sample.txt`, "utf-8");
        expect(persisted).toBe("a\nb\nc\n");
      }
    });
  });

  it("preview result.diff is the genDiff projection itself (#174 single projection)", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const from = hashes[0]!;
      const result = await preview(
        req({
          file: "sample.txt",
          edits: [{ anchor_from: from, anchor_to: from, text: "replaced" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      const file = result.raw;
      // WHY: pin the single-projection claim: the preview result's diff text equals what
      // WHY: `genDiff` produces for the same inputs at the preview pane's context — no
      // WHY: synthesized empty diff is left behind the projection.
      const projected = genDiff(
        file.originalNormalized,
        file.result,
        DIFF_PREVIEW_CONTEXT,
        file.resultHashes,
        file.originalHashes,
      ).diff;
      expect(result.diff).toBe(projected);
      expect(result.diff).toContain("replaced");
      expect(result.toolResult.details.diff).toBe(projected);
      expect(result.toolResult.content[0]!.text).toBe(projected);
    });
  });

  it("execute returns ok:false with code for anchor mismatch", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        req({
          file: "sample.txt",
          edits: [{ anchor_from: "AAA", anchor_to: "BBB", text: "x" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationFailure(result)).toBe(true);
      if (isMutationFailure(result)) {
        expect(result.code).toMatch(/E_/);
        expect(result.message).toContain("AAA");
      }
    });
  });

  it("batch edits share one engine path and report batch metrics", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\nb\nc\nd\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const h0 = hashes[0]!;
      const h2 = hashes[2]!;
      const h3 = hashes[3]!;
      const result = await execute(
        req({
          file: "sample.txt",
          edits: [
            { anchor_from: h0, anchor_to: h0, text: "A" },
            { anchor_from: h2, anchor_to: h3, text: "C" },
          ],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (isMutationSuccess(result)) {
        expect(result.raw.appliedCount).toBe(2);
        expect(result.result).toBe("A\nb\nC\n");
      }
    });
  });
});
