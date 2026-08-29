import { describe, expect, it, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { execute, preview, isMutationSuccess, isMutationFailure } from "../../src/mutation-engine/index.js";
import { withTempFile, setupIntegrationTest } from "../support/fixtures.js";
import { lineHashes } from "../../src/hashline/index.js";
import { initHasher } from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

beforeAll(async () => {
  await initHasher();
});

describe("MutationEngine — deep seam", () => {
  it("execute returns ok:true with diff and metrics for single edit", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\nb\nc\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const from = hashes[0]!;
      const to = hashes[1]!;
      const result = await execute(
        { path: "sample.txt", edits: [{ remove_from: from, remove_to: to, replacement_text: "x\ny" }] },
        cwd,
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
      const hashes = await lineHashes("a\nb\nc\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const from = hashes[0]!;
      const result = await preview(
        { path: "sample.txt", edits: [{ remove_from: from, remove_to: from, replacement_text: "replaced" }] },
        cwd,
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (isMutationSuccess(result)) {
        expect(result.result).toBe("replaced\nb\nc\n");
        const persisted = await readFile(`${cwd}/sample.txt`, "utf-8");
        expect(persisted).toBe("a\nb\nc\n");
      }
    });
  });

  it("execute returns ok:false with code for anchor mismatch", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        { path: "sample.txt", edits: [{ remove_from: "AAA", remove_to: "BBB", replacement_text: "x" }] },
        cwd,
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
      const hashes = await lineHashes("a\nb\nc\nd\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const h0 = hashes[0]!;
      const h2 = hashes[2]!;
      const h3 = hashes[3]!;
      const result = await execute(
        {
          path: "sample.txt",
          edits: [
            { remove_from: h0, remove_to: h0, replacement_text: "A" },
            { remove_from: h2, remove_to: h3, replacement_text: "C" },
          ],
        },
        cwd,
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (isMutationSuccess(result)) {
        expect(result.raw.appliedCount).toBe(2);
        expect(result.result).toBe("A\nb\nC\n");
      }
    });
  });
});
