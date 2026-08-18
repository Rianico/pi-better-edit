import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("details.metrics surface (Phase 2 C — host-only observability)", () => {
  it("changed-mode edit reports applied classification + edits_attempted", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", home.testPath);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "BETA"]] },
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
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\n", home.testPath);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "beta"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.metrics.classification).toBe("noop");
      expect(result.details.metrics.edits_noop).toBe(1);
    });
  });

  it("hash-anchored edit records a single edit in metrics", async () => {
    await withTempFile("sample.ts", "one\ntwo\nthree\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", home.testPath);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "TWO"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.metrics.edits_attempted).toBe(1);
    });
  });

  it("noop edit reports warnings count in metrics", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\n", home.testPath);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "beta"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.metrics.warnings).toBe(0);
    });
  });
});
