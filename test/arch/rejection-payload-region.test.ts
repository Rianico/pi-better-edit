import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { initHasher, lineHashes, applyEdit } from "../../src/hashline";
import { ServedRejectionError, type ServedRow } from "../../src/hashline/served-verification";
import {
  withTempFile,
  setupIntegrationTest,
  useTestHome,
  getText,
  extractHash,
} from "../support/fixtures";

const home = useTestHome();

beforeAll(async () => {
  await initHasher();
});

function servedLineRe(): RegExp {
  return /^[A-Za-z0-9]{3}│/m;
}

/**
 * Seam oracle (ADR-0018 decision 4, spec D5): every rejection payload's rows
 * are derivable from the submitted anchors' live mapping, never from a lookup
 * in the file's current bytes.
 *
 * The caller names the live window from test knowledge of served coordinates
 * (hardcoded per scenario); this file never imports the content lookup, so a
 * window placed by such a lookup cannot satisfy the window check. `fileHashes`
 * are the current on-disk hashes; each row must reproduce them exactly.
 * Payload shape is disjoint by code: a target-lost payload carries zero rows and
 * no `Current range` heading of either form; an unverified payload carries rows
 * under the exact `Current range (fresh read):` heading with no retry hint;
 * every other payload carries rows under `Current range:` with a retry hint.
 */
function assertLivePayload(args: {
  error: unknown;
  fileHashes: string[];
  liveStart: number | null;
  liveEnd: number | null;
  expectedCode?: string;
}): void {
  const err = args.error as ServedRejectionError & { code?: string };
  if (args.expectedCode !== undefined) {
    expect(err.code).toBe(args.expectedCode);
  }
  if (err.code === "E_TARGET_LOST") {
    expect(args.liveStart).toBeNull();
    expect(err.servedRows).toEqual([]);
    expect(err.servedBlock).toBe("");
    expect(err.message).not.toContain("Current range:");
    expect(err.message).not.toContain("Current range (fresh read):");
    expect(err.message).not.toMatch(servedLineRe());
    return;
  }
  const rows = (err as unknown as { servedRows: ServedRow[] }).servedRows;
  expect(rows.length).toBeGreaterThan(0);
  if (err.code === "E_UNVERIFIED_RANGE") {
    expect(err.message).toContain("Current range (fresh read):");
    expect(err.message).not.toContain("Retry with these anchors");
    expect(err.message).not.toContain("No action is required");
  } else {
    expect(err.message).toContain("Current range:");
    expect(err.message).toContain("Retry with these anchors");
  }
  for (const row of rows) {
    expect(row.hash).toBe(args.fileHashes[row.position]);
  }
  if (args.liveStart !== null && args.liveEnd !== null) {
    for (const row of rows) {
      const line = row.position + 1;
      expect(line).toBeGreaterThanOrEqual(args.liveStart);
      expect(line).toBeLessThanOrEqual(args.liveEnd);
    }
  }
}

async function currentHashes(disk: string): Promise<string[]> {
  return lineHashes(disk, home.testPath);
}

describe("rejection payload live-mapping rule (ADR-0018 decision 4, spec D5)", () => {
  it("live lease applies at the served coordinates with no rejection", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text = getText(first);
      const betaRef = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);
      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [[betaRef, betaRef, "BETA"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("in-place retire keeps [E_STALE_RANGE] with the served window", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text = getText(first);
      const alphaRef = extractHash(text.split("\n").find((l) => l.includes("│alpha"))!);
      const gammaRef = extractHash(text.split("\n").find((l) => l.includes("│gamma"))!);
      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");
      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[alphaRef, gammaRef, "X"]] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error;
      }
      const msg = (caught as Error).message;
      expect(msg).toMatch(/\[E_STALE_RANGE\]/);
      const disk = await readFile(path, "utf-8");
      expect(disk).toBe("alpha\nBETA\ngamma\n");
      // Served coordinates 1-3 prove no shift; window is hardcoded, never searched.
      expect(msg).toContain("Current range:");
      expect(msg).toContain("Retry with these anchors");
      const servedLines = msg.split("\n").filter((l) => /^[A-Za-z0-9]{3}│/.test(l));
      const diskHashes = await currentHashes(disk);
      expect(servedLines).toEqual([
        `${diskHashes[0]}│alpha`,
        `${diskHashes[1]}│BETA`,
        `${diskHashes[2]}│gamma`,
      ]);
    });
  });

  it("re-added text elsewhere still rejects [E_TARGET_LOST] with no rows", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text = getText(first);
      const betaRef = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);
      await writeFile(path, "alpha\nBETA\ngamma\nbeta\n", "utf-8");
      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[betaRef, betaRef, "BETA_NEW"]] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error;
      }
      const msg = (caught as Error).message;
      expect(msg).toMatch(/\[E_TARGET_LOST\]/);
      const disk = await readFile(path, "utf-8");
      expect(disk).toBe("alpha\nBETA\ngamma\nbeta\n");
      // Unidentifiable: no window exists, so rows must be empty. Headline names
      // the served coordinate (2), never the re-added line (4).
      expect(msg).not.toContain("Current range:");
      expect(msg).not.toMatch(servedLineRe());
      expect(msg).toMatch(/line 2 in sample\.ts/);
      expect(msg).not.toMatch(/line 4/);
    });
  });

  it("deleted target rejects [E_TARGET_LOST] with no rows", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text = getText(first);
      const gammaRef = extractHash(text.split("\n").find((l) => l.includes("│gamma"))!);
      await writeFile(path, "alpha\nbeta\ndelta\n", "utf-8");
      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[gammaRef, gammaRef, "GAMMA_NEW"]] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error;
      }
      const msg = (caught as Error).message;
      expect(msg).toMatch(/\[E_TARGET_LOST\]/);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ndelta\n");
      expect(msg).not.toContain("Current range:");
      expect(msg).not.toMatch(servedLineRe());
      expect(msg).toMatch(/line 3 in sample\.ts/);
    });
  });

  it("interior gap rejects [E_STALE_RANGE] with the current window", async () => {
    const content = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"].join("\n") + "\n";
    await withTempFile("sample.ts", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = await readTool.execute(
        "r1",
        { path: "sample.ts", limit: 3 },
        undefined,
        undefined,
        ctx,
      );
      const l3Ref = extractHash(
        getText(first)
          .split("\n")
          .find((l) => l.includes("│l3"))!,
      );
      const second = await readTool.execute(
        "r2",
        { path: "sample.ts", offset: 7 },
        undefined,
        undefined,
        ctx,
      );
      const l7Ref = extractHash(
        getText(second)
          .split("\n")
          .find((l) => l.includes("│l7"))!,
      );
      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[l3Ref, l7Ref, "X"]] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error;
      }
      const msg = (caught as Error).message;
      expect(msg).toMatch(/E_STALE_RANGE/);
      expect(await readFile(path, "utf-8")).toBe(content);
      // Rebased window 3-7 from the two served bounds; interior 4-6 were never served.
      // The remedy is identical (retry with the served rows), so no separate code is kept.
      expect(msg).toContain("Current range:");
      expect(msg).toContain("Retry with these anchors");
      expect((caught as { details?: { cause: string } }).details?.cause).toBe("never-served");
      const servedLines = msg.split("\n").filter((l) => /^[A-Za-z0-9]{3}│/.test(l));
      expect(servedLines).toHaveLength(5);
      const diskHashes = await currentHashes(content);
      const diskLines = content.trimEnd().split("\n");
      expect(servedLines).toEqual([2, 3, 4, 5, 6].map((i) => `${diskHashes[i]}│${diskLines[i]}`));
    });
  });

  it("unleased boundary rejects [E_STALE_ANCHOR] with the current window", async () => {
    const content = "l1\nl2\nl3\nl4\nl5\n";
    await withTempFile("sample.ts", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.ts", limit: 2 }, undefined, undefined, ctx);
      const hashes = await lineHashes(content, home.testPath);
      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[hashes[3]!, hashes[4]!, "X"]] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error;
      }
      const msg = (caught as Error).message;
      expect(msg).toMatch(/\[MODEL\] \[E_STALE_ANCHOR\]/);
      expect(await readFile(path, "utf-8")).toBe(content);
      // Content-placeable unleased span serves its current window 4-5; rows still
      // reproduce the on-disk hashes exactly.
      expect(msg).toContain("Current range:");
      const servedLines = msg.split("\n").filter((l) => /^[A-Za-z0-9]{3}│/.test(l));
      const diskHashes = await currentHashes(content);
      expect(servedLines).toEqual([`${diskHashes[3]}│l4`, `${diskHashes[4]}│l5`]);
    });
  });

  it("duplicate anchor rejects [E_STALE_ANCHOR] with current rows", async () => {
    const file = "alpha\nbeta\ngamma\ndelta";
    const real = await lineHashes(file, home.testPath);
    const forged = [...real];
    forged[2] = real[0]!;
    const shared = real[0]!;
    let caught: unknown;
    try {
      applyEdit(
        file,
        { hash_bounds: [{ hash: shared }, { hash: shared }], content_lines: ["X"] },
        undefined,
        forged,
      );
    } catch (error) {
      caught = error;
    }
    const msg = (caught as Error).message;
    expect(msg).toMatch(/E_STALE_ANCHOR/);
    expect(msg).toMatch(/ambiguous/);
    const rows = (caught as { servedRows: ServedRow[] }).servedRows;
    // Both colliding lines are served; each row reproduces the forged bytes exactly.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.position)).toEqual([0, 2]);
    for (const row of rows) {
      expect(row.hash).toBe(forged[row.position]);
    }
  });

  it("batched call rejects atomically and leaves the file unchanged", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text = getText(first);
      const alphaRef = extractHash(text.split("\n").find((l) => l.includes("│alpha"))!);
      const betaRef = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);
      const gammaRef = extractHash(text.split("\n").find((l) => l.includes("│gamma"))!);
      // Overlapping spans abort before any mutation; the later span's window is served.
      const overlap = (await editTool
        .execute(
          "e1",
          {
            path: "sample.ts",
            edits: [
              { anchor_from: alphaRef, anchor_to: betaRef, replace_with: "X" },
              { anchor_from: betaRef, anchor_to: gammaRef, replace_with: "Y" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;
      expect(overlap.message).toMatch(/\[E_BATCH_ABORT\]/);
      expect(overlap.message).toContain("Current range:");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
      const diskHashes = await currentHashes("alpha\nbeta\ngamma\n");
      const servedLines = overlap.message.split("\n").filter((l) => /^[A-Za-z0-9]{3}│/.test(l));
      // Later span beta-gamma (lines 2-3) is served; rows reproduce on-disk bytes.
      expect(servedLines).toEqual([`${diskHashes[1]}│beta`, `${diskHashes[2]}│gamma`]);
      // A later item naming a retired identity aborts with its own code plus the trailer.
      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");
      const staleItem = (await editTool
        .execute(
          "e2",
          {
            path: "sample.ts",
            edits: [
              { anchor_from: alphaRef, anchor_to: alphaRef, replace_with: "ALPHA" },
              { anchor_from: betaRef, anchor_to: betaRef, replace_with: "beta" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;
      expect(staleItem.message).toMatch(/\[E_TARGET_LOST\]/);
      expect(staleItem.message).toContain(
        "The whole edit call was rejected and NOTHING was written",
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("negative control: a misplaced row fails the live-mapping check", async () => {
    const disk = "alpha\nBETA\ngamma\n";
    const hashes = await currentHashes(disk);
    const misplaced: ServedRow = { position: 0, hash: hashes[2]! };
    const planted = new ServedRejectionError({
      code: "E_STALE_RANGE",
      message: `[MODEL] [E_STALE_RANGE] line 2 differs.\nCurrent range:\n${misplaced.hash}│alpha\nRetry with these anchors (no read needed).`,
      servedRows: [misplaced],
      servedBlock: `${misplaced.hash}│alpha`,
      cause: "served-range staleness",
    });
    expect(() =>
      assertLivePayload({ error: planted, fileHashes: hashes, liveStart: 1, liveEnd: 3 }),
    ).toThrow(/expected .* to be /);
  });

  it("negative control: a target-lost payload carrying rows fails the check", async () => {
    const disk = "alpha\nbeta\ndelta\n";
    const hashes = await currentHashes(disk);
    const planted = new ServedRejectionError({
      code: "E_TARGET_LOST",
      message: `[MODEL] [E_TARGET_LOST] line 3 gone.\nCurrent range:\n${hashes[2]}│delta`,
      servedRows: [{ position: 2, hash: hashes[2]! }],
      servedBlock: `${hashes[2]}│delta`,
      cause: "retirement",
    });
    expect(() =>
      assertLivePayload({ error: planted, fileHashes: hashes, liveStart: null, liveEnd: null }),
    ).toThrow();
    expect(planted.servedRows.length).toBeGreaterThan(0);
    expect(planted.message).toContain("Current range:");
  });

  it("boundary survivor live+unshifted serves [E_UNVERIFIED_RANGE] as a fresh read", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text = getText(first);
      const alphaRef = extractHash(text.split("\n").find((l) => l.includes("│alpha"))!);
      const betaRef = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);
      // Delete the tail bound: head (line 1) stays live and unshifted, tail is gone.
      await writeFile(path, "alpha\ngamma\n", "utf-8");
      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[alphaRef, betaRef, "X"]] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error;
      }
      const msg = (caught as Error).message;
      expect(msg).toMatch(/\[E_UNVERIFIED_RANGE\]/);
      expect(await readFile(path, "utf-8")).toBe("alpha\ngamma\n");
      // Fresh read of the named window (served lines 1-2, clamped): rows, no retry hint.
      expect(msg).toContain("Current range (fresh read):");
      expect(msg).not.toContain("Retry with these anchors");
      expect(msg).not.toContain("No action is required");
      expect((caught as { details?: { cause: string } }).details?.cause).toBe("retirement");
      const disk = await readFile(path, "utf-8");
      const diskHashes = await currentHashes(disk);
      assertLivePayload({
        error: caught,
        fileHashes: diskHashes,
        liveStart: 1,
        liveEnd: 2,
        expectedCode: "E_UNVERIFIED_RANGE",
      });
      // The fresh-read rows are leased through the normal seam: deciding from them writes.
      const servedLines = msg.split("\n").filter((l) => /^[A-Za-z0-9]{3}│/.test(l));
      expect(servedLines).toHaveLength(2);
      const retryFrom = servedLines[0]!.split("│")[0]!;
      const retryTo = servedLines[1]!.split("│")[0]!;
      const retry = await editTool.execute(
        "e2",
        { path: "sample.ts", edits: [[retryFrom, retryTo, "X"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(retry)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("X\n");
    });
  });

  it("both bounds stale rejects [E_TARGET_LOST] with no rows", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text = getText(first);
      const alphaRef = extractHash(text.split("\n").find((l) => l.includes("│alpha"))!);
      const betaRef = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);
      // Both leased identities are gone: the named window identifies nothing.
      await writeFile(path, "ONE\nTWO\n", "utf-8");
      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[alphaRef, betaRef, "X"]] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error;
      }
      const msg = (caught as Error).message;
      expect(msg).toMatch(/\[E_TARGET_LOST\]/);
      expect(await readFile(path, "utf-8")).toBe("ONE\nTWO\n");
      expect(msg).not.toContain("Current range:");
      expect(msg).not.toContain("Current range (fresh read):");
      expect(msg).not.toMatch(servedLineRe());
      expect((caught as { details?: { cause: string } }).details?.cause).toBe("retirement");
      const diskHashes = await currentHashes(await readFile(path, "utf-8"));
      assertLivePayload({
        error: caught,
        fileHashes: diskHashes,
        liveStart: null,
        liveEnd: null,
        expectedCode: "E_TARGET_LOST",
      });
    });
  });

  it("survivor shifted rejects [E_TARGET_LOST] with no rows", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text = getText(first);
      const betaRef = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);
      const gammaRef = extractHash(text.split("\n").find((l) => l.includes("│gamma"))!);
      // Shift the survivor (beta 2 -> 3) and delete the other bound: no unshifted survivor.
      await writeFile(path, "ZERO\nalpha\nbeta\n", "utf-8");
      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[betaRef, gammaRef, "X"]] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error;
      }
      const msg = (caught as Error).message;
      expect(msg).toMatch(/\[E_TARGET_LOST\]/);
      expect(await readFile(path, "utf-8")).toBe("ZERO\nalpha\nbeta\n");
      expect(msg).not.toContain("Current range:");
      expect(msg).not.toContain("Current range (fresh read):");
      expect(msg).not.toMatch(servedLineRe());
      // The headline names the lease-derived served coordinate (3), never a content match.
      expect(msg).toMatch(/line 3 in sample\.ts/);
      expect((caught as { details?: { cause: string } }).details?.cause).toBe("retirement");
      const diskHashes = await currentHashes(await readFile(path, "utf-8"));
      assertLivePayload({
        error: caught,
        fileHashes: diskHashes,
        liveStart: null,
        liveEnd: null,
        expectedCode: "E_TARGET_LOST",
      });
    });
  });

  it("collapsed window rejects [E_TARGET_LOST] with no rows", async () => {
    const content = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    await withTempFile("sample.ts", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text = getText(first);
      const l9Ref = extractHash(text.split("\n").find((l) => l.includes("│l9"))!);
      const l10Ref = extractHash(text.split("\n").find((l) => l.includes("│l10"))!);
      // The named window (served lines 9-10) no longer overlaps the 4-line file.
      await writeFile(path, "l1\nl2\nl3\nl4\n", "utf-8");
      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", edits: [[l9Ref, l10Ref, "X"]] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error;
      }
      const msg = (caught as Error).message;
      expect(msg).toMatch(/\[E_TARGET_LOST\]/);
      expect(await readFile(path, "utf-8")).toBe("l1\nl2\nl3\nl4\n");
      expect(msg).not.toContain("Current range:");
      expect(msg).not.toContain("Current range (fresh read):");
      expect(msg).not.toMatch(servedLineRe());
      const diskHashes = await currentHashes(await readFile(path, "utf-8"));
      assertLivePayload({
        error: caught,
        fileHashes: diskHashes,
        liveStart: null,
        liveEnd: null,
        expectedCode: "E_TARGET_LOST",
      });
    });
  });

  it("negative control: a retry hint on an unverified payload fails the check", async () => {
    const disk = "alpha\ngamma\n";
    const hashes = await currentHashes(disk);
    const planted = new ServedRejectionError({
      code: "E_UNVERIFIED_RANGE",
      message:
        `[MODEL] [E_UNVERIFIED_RANGE] a bound of this range no longer resolves to the line identity it was served with.\n` +
        `Current range (fresh read):\n${hashes[0]}│alpha\n${hashes[1]}│gamma\nRetry with these anchors (no read needed).`,
      servedRows: [
        { position: 0, hash: hashes[0]! },
        { position: 1, hash: hashes[1]! },
      ],
      servedBlock: `${hashes[0]}│alpha\n${hashes[1]}│gamma`,
      cause: "retirement",
    });
    expect(() =>
      assertLivePayload({
        error: planted,
        fileHashes: hashes,
        liveStart: 1,
        liveEnd: 2,
        expectedCode: "E_UNVERIFIED_RANGE",
      }),
    ).toThrow();
  });

  it("negative control: a stale heading on an unverified payload fails the check", async () => {
    const disk = "alpha\ngamma\n";
    const hashes = await currentHashes(disk);
    const planted = new ServedRejectionError({
      code: "E_UNVERIFIED_RANGE",
      message:
        `[MODEL] [E_UNVERIFIED_RANGE] a bound of this range no longer resolves to the line identity it was served with.\n` +
        `Current range:\n${hashes[0]}│alpha\n${hashes[1]}│gamma`,
      servedRows: [
        { position: 0, hash: hashes[0]! },
        { position: 1, hash: hashes[1]! },
      ],
      servedBlock: `${hashes[0]}│alpha\n${hashes[1]}│gamma`,
      cause: "retirement",
    });
    expect(() =>
      assertLivePayload({
        error: planted,
        fileHashes: hashes,
        liveStart: 1,
        liveEnd: 2,
        expectedCode: "E_UNVERIFIED_RANGE",
      }),
    ).toThrow();
  });

  it("negative control: a shifted survivor still serving fails the check", async () => {
    // The survivor shifted, so the sound code is target-lost with no rows. A payload that
    // serves rows for the shifted window (the old disjunction's wrong-range write) must fail.
    const disk = "ZERO\nalpha\nbeta\n";
    const hashes = await currentHashes(disk);
    const planted = new ServedRejectionError({
      code: "E_UNVERIFIED_RANGE",
      message:
        `[MODEL] [E_UNVERIFIED_RANGE] a bound of this range no longer resolves to the line identity it was served with.\n` +
        `Current range (fresh read):\n${hashes[1]}│alpha\n${hashes[2]}│beta`,
      servedRows: [
        { position: 1, hash: hashes[1]! },
        { position: 2, hash: hashes[2]! },
      ],
      servedBlock: `${hashes[1]}│alpha\n${hashes[2]}│beta`,
      cause: "retirement",
    });
    expect(() =>
      assertLivePayload({
        error: planted,
        fileHashes: hashes,
        liveStart: null,
        liveEnd: null,
        expectedCode: "E_TARGET_LOST",
      }),
    ).toThrow();
  });
});
