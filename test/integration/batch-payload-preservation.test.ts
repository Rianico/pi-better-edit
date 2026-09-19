import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import type { ServedRow } from "../../src/domain-errors.js";

/**
 * Payload-preservation oracle (spec section 6, item 2: PAYLOAD
 * PRESERVATION). A batch abort must preserve the failing item's
 * `servedBlock`/`servedRows` verbatim: the envelope carries the exact
 * reject-and-serve rows the item's own rejection rendered, so the retry
 * owes no re-read. Driven from the rejection envelope, against a
 * single-item control running the same failing edit.
 *
 * Falsifiability: `assertPayloadPreserved` fails a planted envelope
 * whose block was dropped or whose rows never render in the block
 * (see the negative controls below).
 */

type RejectionEnvelope = Error & {
  code?: string;
  servedRows?: ServedRow[];
  servedBlock?: string;
  details?: { cause?: string };
};

function assertPayloadPreserved(envelope: RejectionEnvelope, expectedCode: string): void {
  expect(envelope.code).toBe(expectedCode);
  const rows = envelope.servedRows ?? [];
  const block = envelope.servedBlock ?? "";
  expect(rows.length).toBeGreaterThan(0);
  expect(block.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(block).toContain(row.hash);
  }
  expect(envelope.message).toContain("Current range:");
}

function plantedEnvelope(args: {
  code: string;
  message: string;
  servedRows: ServedRow[];
  servedBlock: string;
}): RejectionEnvelope {
  const error = new Error(args.message) as RejectionEnvelope;
  error.code = args.code;
  error.servedRows = args.servedRows;
  error.servedBlock = args.servedBlock;
  return error;
}

async function servedAnchors(
  ctx: unknown,
  readTool: any,
  name: string,
): Promise<{ alpha: string; beta: string; delta: string }> {
  const result = await readTool.execute("r1", { path: name }, undefined, undefined, ctx);
  const lines = getText(result).split("\n");
  const pick = (content: string): string =>
    extractHash(lines.find((line) => line.includes(`│${content}`))!);
  return { alpha: pick("alpha"), beta: pick("beta"), delta: pick("delta") };
}

describe("batch abort preserves the failing item payload (spec 6.2)", () => {
  it("a batch abort keeps the failing item servedBlock and servedRows verbatim", async () => {
    const original = "alpha\nbeta\ngamma\ndelta\n";
    const drifted = "alpha\nbeta\nGAMMA\ndelta\n";
    await withTempFile("single.txt", original, async ({ cwd, path }) => {
      const batchName = "batch.txt";
      await writeFile(join(cwd, batchName), original, "utf-8");
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const single = await servedAnchors(ctx, readTool, "single.txt");
      const batch = await servedAnchors(ctx, readTool, batchName);

      // Interior drift under live bounds: the bound anchors stay live
      // while the served interior no longer matches.
      await writeFile(path, drifted, "utf-8");
      await writeFile(join(cwd, batchName), drifted, "utf-8");

      const lone = (await editTool
        .execute(
          "e1",
          {
            path: "single.txt",
            edits: [{ anchor_from: single.beta, anchor_to: single.delta, replace_with: "X" }],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as RejectionEnvelope;
      expect(lone.code).toBe("E_STALE_RANGE");
      assertPayloadPreserved(lone, "E_STALE_RANGE");

      const envelope = (await editTool
        .execute(
          "e2",
          {
            path: batchName,
            edits: [
              { anchor_from: batch.alpha, anchor_to: batch.alpha, replace_with: "ALPHA" },
              { anchor_from: batch.beta, anchor_to: batch.delta, replace_with: "X" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as RejectionEnvelope;

      // The item keeps its own code: overlap relabelling would send the
      // model hunting for coordinate overlap instead of the stale interior.
      expect(envelope.code).toBe("E_STALE_RANGE");
      expect(envelope.message).toContain(`edit[1] (${batchName})`);
      expect(envelope.message).toContain(
        "The whole edit call was rejected and NOTHING was written",
      );
      assertPayloadPreserved(envelope, "E_STALE_RANGE");
      expect(envelope.servedBlock).toBe(lone.servedBlock);
      expect(envelope.servedRows).toEqual(lone.servedRows);
      expect(await readFile(join(cwd, batchName), "utf-8")).toBe(drifted);
    });
  });

  it("negative control: a dropped servedBlock fails the preservation check", () => {
    const planted = plantedEnvelope({
      code: "E_STALE_RANGE",
      message: "[MODEL] [E_STALE_RANGE] lines 2-4 differ.\nCurrent range:",
      servedRows: [{ position: 1, hash: "abc" }],
      servedBlock: "",
    });
    expect(() => assertPayloadPreserved(planted, "E_STALE_RANGE")).toThrow();
    expect(planted.servedBlock).toBe("");
  });

  it("negative control: rows absent from the block fail the preservation check", () => {
    const planted = plantedEnvelope({
      code: "E_STALE_RANGE",
      message: "[MODEL] [E_STALE_RANGE] lines 2-4 differ.\nCurrent range:\nabc│beta",
      servedRows: [{ position: 1, hash: "zzz" }],
      servedBlock: "abc│beta",
    });
    expect(() => assertPayloadPreserved(planted, "E_STALE_RANGE")).toThrow();
  });
});
