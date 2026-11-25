import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

/** The unified batch-rejection verdict line every multi-item rejection carries (spec #329 §4). */
const BATCH_VERDICT =
  /^\[MODEL\] Batch rejected: \d+ of \d+ edits? failed; nothing was written\.$/m;

/** The `HASH│content` rows the read served, in file order — the anchors the model would copy. */
async function servedHashes(ctx: unknown, readTool: any, path: string): Promise<string[]> {
  const result = await readTool.execute("r1", { file: path }, undefined, undefined, ctx);
  return getText(result)
    .split("\n")
    .filter((line) => /^[A-Za-z0-9]{4}│/.test(line))
    .map(extractHash);
}

/** The content column of a served block — the 4-char anchor stripped, so a sentinel can never
 *  match a randomly generated hash (#122). */
const contentColumn = (block: string): string =>
  block
    .split("\n")
    .filter((line) => /^[A-Za-z0-9]{4}│/.test(line))
    .map((line) => line.split("│")[1])
    .join("\n");

describe("multi-item edit error propagation", () => {
  it("a malformed anchor in a later item surfaces [E_MALFORMED_ANCHOR], never [E_BATCH_ABORT]", async () => {
    const content = "alpha\nbeta\ngamma\n";
    await withTempFile("bad-anchor.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "bad-anchor.txt");

      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "bad-anchor.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "ALPHA" },
              { anchor_from: `${hashes[1]}│beta`, anchor_to: hashes[1]!, text: "BETA" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;

      expect(rejection.message).toContain("[E_MALFORMED_ANCHOR]");
      expect(rejection.message).not.toContain("[E_BATCH_ABORT]");
      expect(rejection.message).toContain("edit[1] (bad-anchor.txt)");
      expect(rejection.message).toMatch(BATCH_VERDICT);
      expect(await readFile(path, "utf-8")).toBe(content);
    });
  });

  it("an item that fails inside the sequential apply surfaces its own code under the batch verdict", async () => {
    const content = "alpha\nbeta\ngamma\n";
    await withTempFile("apply-loop.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "apply-loop.txt");

      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "apply-loop.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "ALPHA" },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: `${hashes[1]}│beta` },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;

      expect(rejection.message).toContain("[E_SUSPICIOUS_TEXT]");
      expect(rejection.message).not.toContain("[E_BATCH_ABORT]");
      expect(rejection.message).toContain("- edit[1] (apply-loop.txt) [E_SUSPICIOUS_TEXT]:");
      expect(rejection.message).toMatch(BATCH_VERDICT);
      expect(await readFile(path, "utf-8")).toBe(content);
    });
  });

  it("an item rejected while the batch applies surfaces its own code under the batch verdict", async () => {
    const original = "alpha\nbeta\ngamma\n";
    const drifted = "alpha\nBETA\ngamma\n";
    await withTempFile("apply-failure.txt", original, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "apply-failure.txt");

      await writeFile(path, drifted, "utf-8");

      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "apply-failure.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "ALPHA" },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "beta" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;

      expect(rejection.message).toContain("[E_TARGET_LOST]");
      expect(rejection.message).not.toContain("[E_BATCH_ABORT]");
      expect(rejection.message).toContain("edit[1] (apply-failure.txt)");
      expect(rejection.message).toMatch(BATCH_VERDICT);
      expect(await readFile(path, "utf-8")).toBe(drifted);
    });
  });
  it("an item rejected in the apply loop keeps the attributed edit clause and prefix under the batch verdict", async () => {
    const content = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
    await withTempFile("apply-payload.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "apply-payload.txt");

      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "apply-payload.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "ALPHA" },
              { anchor_from: hashes[1]!, anchor_to: hashes[3]!, text: "X", at: "before" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;

      const message = rejection.message;
      expect(message.match(/\[E_BAD_PAYLOAD\]/g)?.length).toBe(1);
      expect(message).toContain("[E_BAD_PAYLOAD]: The edit payload is not valid:");
      expect(message).not.toContain("The payload is not valid:");
      expect(message).toContain("- edit[1] (apply-payload.txt) [E_BAD_PAYLOAD]:");
      expect(message).toMatch(BATCH_VERDICT);
      expect(await readFile(path, "utf-8")).toBe(content);
    });
  });
});

describe("batch abort serve-block preservation and isolation (spec D2, section 3.4)", () => {
  const nineLines = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"].join("\n") + "\n";
  const driftedLines = nineLines.replace("l5\n", "L5X\n");

  async function serveThenDrift(
    ctx: unknown,
    readTool: any,
    name: string,
    path: string,
  ): Promise<{ l1Ref: string; l3Ref: string; l7Ref: string }> {
    const served = await readTool.execute("r1", { file: name }, undefined, undefined, ctx);
    const servedText = getText(served);
    const ref = (line: string): string =>
      extractHash(servedText.split("\n").find((l: string) => l.includes(`│${line}`))!);
    await writeFile(path, driftedLines, "utf-8");
    return { l1Ref: ref("l1"), l3Ref: ref("l3"), l7Ref: ref("l7") };
  }

  type Caught = Error & {
    code?: string;
    servedRows?: Array<{ position: number; hash: string }>;
    servedBlock?: string;
    details?: { cause?: string };
  };

  it("preserves the failing item's servedBlock and rows across the abort", async () => {
    await withTempFile("batch-serve.txt", nineLines, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const { l1Ref, l3Ref, l7Ref } = await serveThenDrift(ctx, readTool, "batch-serve.txt", path);
      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "batch-serve.txt",
            edits: [
              { anchor_from: l1Ref, anchor_to: l1Ref, text: "L1" },
              { anchor_from: l3Ref, anchor_to: l7Ref, text: "X" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Caught;

      expect(rejection.code).toBe("E_STALE_RANGE");
      expect(rejection.message).toContain("[E_STALE_RANGE]");
      expect(rejection.message).not.toContain("[E_BATCH_ABORT]");
      expect(rejection.message).toContain("edit[1] (batch-serve.txt)");
      expect(rejection.message).toMatch(BATCH_VERDICT);
      expect(typeof rejection.servedBlock).toBe("string");
      expect(rejection.servedBlock!.length).toBeGreaterThan(0);
      const rows = rejection.servedRows ?? [];
      expect(rows).toHaveLength(5);
      const blockLines = rejection
        .servedBlock!.split("\n")
        .filter((line) => /^[A-Za-z0-9]{4}│/.test(line));
      expect(blockLines).toHaveLength(rows.length);
      for (const row of rows) {
        expect(rejection.servedBlock).toContain(`${row.hash}│`);
      }
      expect(blockLines.map((line) => line.split("│")[1])).toEqual(["l3", "l4", "L5X", "l6", "l7"]);
      expect(rejection.details?.cause).toBe("retirement");
      expect(await readFile(path, "utf-8")).toBe(driftedLines);
    });
  });

  it("reports only the failing item with no sibling state leaking in", async () => {
    await withTempFile("batch-isolated.txt", nineLines, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const { l1Ref, l3Ref, l7Ref } = await serveThenDrift(
        ctx,
        readTool,
        "batch-isolated.txt",
        path,
      );
      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "batch-isolated.txt",
            edits: [
              { anchor_from: l1Ref, anchor_to: l1Ref, text: "L1" },
              { anchor_from: l3Ref, anchor_to: l7Ref, text: "X" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Caught;

      expect(rejection.code).toBe("E_STALE_RANGE");
      expect(rejection.message).toContain("edit[1]");
      expect(rejection.message).not.toContain("edit[0]");
      expect(rejection.message.match(/edit\[\d+\]/g)).toEqual(["edit[1]"]);
      const blockLines = (rejection.servedBlock ?? "")
        .split("\n")
        .filter((line) => /^[A-Za-z0-9]{4}│/.test(line));
      expect(blockLines.map((line) => line.split("│")[1])).toEqual(["l3", "l4", "L5X", "l6", "l7"]);
      expect(contentColumn(rejection.servedBlock ?? "")).not.toContain("L1");
      expect(rejection.message).not.toContain("│L1");
      expect(await readFile(path, "utf-8")).toBe(driftedLines);
    });
  });
});

describe("content column of a served block (#122)", () => {
  it("strips the anchor, so an anchor containing the sentinel is harmless", () => {
    expect(contentColumn("L1jg│l4\nHQPZ│l3")).toBe("l4\nl3");
    expect(contentColumn("not a row\nHQPZ│l3")).toBe("l3");
  });

  it("still fails when the sentinel leaks through the content column", () => {
    expect(() => expect(contentColumn("HQPZ│L1")).not.toContain("L1")).toThrow();
  });
});
