import { describe, expect, it } from "vitest";
import { withTempFile, setupIntegrationTest } from "../support/fixtures";

describe("strict hashline tool loop", () => {
  it("supports read -> fresh edit -> stale rejection -> retry with fresh anchor", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const betaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          edits: [{ old_range: [betaRef, betaRef], new_lines: ["BETA"] }],
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
            edits: [{ old_range: [betaRef, betaRef], new_lines: ["BETA-AGAIN"] }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/2 stale anchor/);

      const secondRead = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const secondText = secondRead.content[0].text as string;
      const freshRef = secondText
        .split("\n")
	        .find((line: string) => line.includes("│BETA"))!
	        .split("│")[0]!;

      await editTool.execute(
        "e3",
        {
          path: "sample.ts",
          edits: [{ old_range: [freshRef, freshRef], new_lines: ["BETA-AGAIN"] }],
        },
        undefined,
        undefined,
        ctx,
      );
    });
  });
});

describe("CRLF line ending preservation", () => {
  it("preserves CRLF line endings after edit", async () => {
    await withTempFile("crlf.ts", "alpha\r\nbeta\r\ngamma\r\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      // Read and get anchor for beta
      const readResult = await readTool.execute("r1", { path: "crlf.ts" }, undefined, undefined, ctx);
      const betaRef = readResult.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      // Edit beta → BETA
      await editTool.execute(
        "e1",
        { path: "crlf.ts", edits: [{ old_range: [betaRef, betaRef], new_lines: ["BETA"] }] },
        undefined,
        undefined,
        ctx,
      );

      // Verify file on disk still uses CRLF
      const { readFile } = await import("fs/promises");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("alpha\r\nBETA\r\ngamma\r\n");
      expect(content).toContain("\r\n");
      expect(content).not.toMatch(/[^\r]\n/); // no bare LF
    });
  });

  it("preserves LF line endings after edit (no CRLF introduced)", async () => {
    await withTempFile("lf.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "lf.ts" }, undefined, undefined, ctx);
      const betaRef = readResult.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        { path: "lf.ts", edits: [{ old_range: [betaRef, betaRef], new_lines: ["BETA"] }] },
        undefined,
        undefined,
        ctx,
      );

      // Verify file on disk still uses LF (no CRLF introduced)
      const { readFile } = await import("fs/promises");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("alpha\nBETA\ngamma\n");
      expect(content).not.toContain("\r");
    });
  });
});
