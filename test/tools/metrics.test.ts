import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("details.metrics surface (Phase 2 C — host-only observability)", () => {
  it("changed-mode edit reports applied classification + edits_attempted", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BETA"] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.metrics.classification).toBe("applied");
      expect(result.details.metrics.edits_attempted).toBe(1);
    });
  });

  it("noop edit reports classification noop and edits_noop count", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["beta"] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.metrics.classification).toBe("noop");
      expect(result.details.metrics.edits_noop).toBe(1);
    });
  });

  it("hash-anchored replace records a single edit in metrics", async () => {
    await withTempFile("sample.ts", "one\ntwo\nthree\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["TWO"] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.metrics.edits_attempted).toBe(1);
    });
  });

  it("noop edit reports warnings count in metrics", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["beta"] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.metrics.warnings).toBe(0);
    });
  });
});
