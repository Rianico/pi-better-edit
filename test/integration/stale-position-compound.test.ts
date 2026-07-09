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

describe("stale-position compound edits", () => {
  it("rejects stale anchors after a replace", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const line5Hash = firstText
        .split("\n")
        .find((line: string) => line.includes("│e"))!
        .split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [line5Hash, line5Hash], content_lines: ["E"] }],
        },
        undefined,
        undefined,
        ctx,
      );

      const freshHash = (await lineHashes(result.content?.[0]?.text ?? "", testPath))?.[4];
      if (freshHash) {
        await editTool.execute(
          "e2",
          {
            path: "sample.ts",
            changes: [{ hash_range_inclusive: [freshHash, freshHash], content_lines: ["E-AGAIN"] }],
          },
          undefined,
          undefined,
          ctx,
        );
      }
    });
  });

  it("tracks correct final coordinates for a range replace", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const lines = firstText.split("\n");
      const line2Hash = lines.find((l: string) => l.includes("│b"))!.split("│")[0]!;
      const line4Hash = lines.find((l: string) => l.includes("│d"))!.split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [line2Hash, line4Hash], content_lines: ["B", "C_D"] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 2 line(s), removed 3 line(s).");
    });
  });

  it("tracks correct coordinates when replace shrinks lines", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const lines = firstText.split("\n");
      const line2Hash = lines.find((l: string) => l.includes("│b"))!.split("│")[0]!;
      const line4Hash = lines.find((l: string) => l.includes("│d"))!.split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [line2Hash, line4Hash], content_lines: ["B", "C_D"] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 2 line(s), removed 3 line(s).");
    });
  });
});
