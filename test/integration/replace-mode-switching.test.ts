import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, setupTestHome } from "../support/fixtures";

let testPath: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const s = await setupTestHome();
  testPath = s.testPath;
  cleanup = s.cleanup;
});

afterAll(async () => {
  await cleanup();
});

describe("replace mode switching — flat mode tool behavior", () => {
  it("flat mode tool accepts top-level hash_range_inclusive and content_lines", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
    });
  });

  it("flat mode tool rejects bulk changes array format", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
    });
  });
});

describe("replace mode switching — flat mode end-to-end", () => {
  it("flat mode: stale anchor rejection after edit", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const betaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│bbb"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [betaRef, betaRef], content_lines: ["BBB"] }],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(
        editTool.execute(
          "e2",
          {
            path: "sample.ts",
            changes: [{ hash_range_inclusive: [betaRef, betaRef], content_lines: ["BBB-AGAIN"] }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/stale anchor/);
    });
  });
});
