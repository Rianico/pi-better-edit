import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import {
  withTempFile,
  setupIntegrationTest,
  useTestHome,
  getText,
  extractHash,
} from "../support/fixtures";

const home = useTestHome();

describe("served-state range verification for edit", () => {
  it("rejects with [E_STALE_RANGE] naming the first offending line and leaves the file unchanged", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const alphaRef = extractHash(text.split("\n").find((l) => l.includes("│alpha"))!);
      const gammaRef = extractHash(text.split("\n").find((l) => l.includes("│gamma"))!);

      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

      await expect(
        editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[alphaRef, gammaRef, "X"]] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_STALE_RANGE.*line 2/);

      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("serves the current range as fresh rows; retrying with them applies without read and does not loop", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const alphaRef = extractHash(text.split("\n").find((l) => l.includes("│alpha"))!);
      const gammaRef = extractHash(text.split("\n").find((l) => l.includes("│gamma"))!);

      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

      let rejected: Error | undefined;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[alphaRef, gammaRef, "X"]] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        rejected = error as Error;
      }
      expect(rejected).toBeDefined();
      expect(rejected!.message).toMatch(/E_STALE_RANGE/);

      const servedLines = rejected!.message.split("\n").filter((l) => /^[A-Za-z0-9]{3}│/.test(l));
      const currentHashes = await lineHashes("alpha\nBETA\ngamma\n", home.testPath);
      expect(servedLines).toEqual([
        `${currentHashes[0]}│alpha`,
        `${currentHashes[1]}│BETA`,
        `${currentHashes[2]}│gamma`,
      ]);

      const retryFrom = servedLines[0]!.split("│")[0]!;
      const retryTo = servedLines[2]!.split("│")[0]!;
      const retry = await editTool.execute(
        "e2",
        { path: "sample.ts", edits: [[retryFrom, retryTo, "X\nY"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(retry)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("X\nY\n");

      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");
      // Pipeline now records dense serves for the successful retry (X/Y),
      // so the old serve anchors (for alpha/BETA/gamma) are no longer
      // served. The stale retry must be rejected and requires a fresh read.
      await expect(
        editTool.execute(
          "e3",
          { path: "sample.ts", edits: [[retryFrom, retryTo, "Z"]] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_UNSERVED_RANGE|E_STALE_RANGE|E_TARGET_LOST/);
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
      // Fresh read re-serves and then edit succeeds
      const freshRead = await readTool.execute(
        "r3",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const freshText = getText(freshRead);
      const freshAlpha = extractHash(freshText.split("\n").find((l) => l.includes("│alpha"))!);
      const freshGamma = extractHash(freshText.split("\n").find((l) => l.includes("│gamma"))!);
      const final = await editTool.execute(
        "e4",
        { path: "sample.ts", edits: [[freshAlpha, freshGamma, "Z"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(final)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("Z\n");
    });
  });

  it("tolerates an out-of-range in-place content change below the range", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const alphaRef = extractHash(text.split("\n").find((l) => l.includes("│alpha"))!);
      const betaRef = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);

      await writeFile(path, "alpha\nbeta\ngamma\nDELTA\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [[alphaRef, betaRef, "A\nB"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("A\nB\ngamma\nDELTA\n");
    });
  });

  it("tolerates a deletion above the range (positional shift)", async () => {
    await withTempFile("sample.ts", "a1\na2\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const betaRef = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);
      const gammaRef = extractHash(text.split("\n").find((l) => l.includes("│gamma"))!);

      await writeFile(path, "a2\nbeta\ngamma\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [[betaRef, gammaRef, "B\nG"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("a2\nB\nG\n");
    });
  });

  it("verifies a change-then-revert interior (b → B → b on disk)", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const alphaRef = extractHash(text.split("\n").find((l) => l.includes("│alpha"))!);
      const gammaRef = extractHash(text.split("\n").find((l) => l.includes("│gamma"))!);

      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");
      await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [[alphaRef, gammaRef, "X\nY"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("X\nY\n");
    });
  });

  it("keeps single-line edits behaving exactly as before", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const betaRef = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [[betaRef, betaRef, "BETA"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(getText(result)).toContain("Added 1 line(s), removed 1 line(s).");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("records [E_STALE_RANGE] current-range rows as serves for edits over that territory", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const alphaRef = extractHash(text.split("\n").find((l) => l.includes("│alpha"))!);
      const betaRef = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);

      await writeFile(path, "alpha\nBETA\n", "utf-8");

      let rejected: Error | undefined;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[alphaRef, betaRef, "X"]] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        rejected = error as Error;
      }
      expect(rejected).toBeDefined();
      // The beta lease is retired (its line entity is gone), so the identity seam owns the refusal:
      // [E_STALE_RANGE] with the current range, never [E_STALE_ANCHOR] (spec §3.1.1 line 89 / §5.3).
      expect(rejected!.message).toMatch(/\[MODEL\] \[E_STALE_RANGE\]/);
      expect(rejected!.message).not.toMatch(/E_STALE_ANCHOR/);
      expect(rejected!.message).toContain("Current range:");

      const rangeRow = rejected!.message.split("\n").find((l) => l.includes("│BETA"))!;
      const currentHashes = await lineHashes("alpha\nBETA\n", home.testPath);
      expect(rangeRow).toContain(currentHashes[1]!);
      const betaRefFromRange = rangeRow.split("│")[0]!;

      const retry = await editTool.execute(
        "e2",
        { path: "sample.ts", edits: [[betaRefFromRange, betaRefFromRange, "BETA2"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(retry)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA2\n");
    });
  });

  it("fail-safes when the boundary hashes were never served (fresh session, no prior read)", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", home.testPath);

      // No serve ever leased these anchors, so the boundary lookup is empty: [E_STALE_ANCHOR] with
      // the fresh context serve (spec §3.1.1 step 1 line 89 / §5.3, ADR-0016).
      await expect(
        editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[hashes[0]!, hashes[2]!, "X"]] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/\[MODEL\] \[E_STALE_ANCHOR\]/);

      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });
});
