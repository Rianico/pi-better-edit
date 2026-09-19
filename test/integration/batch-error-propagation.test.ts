import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

/** The atomicity trailer every item failure in a multi-item call must carry (spec §3.2.3). */
const ATOMICITY_TRAILER =
  "The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.";

/** The `HASH│content` rows the read served, in file order — the anchors the model would copy. */
async function servedHashes(ctx: unknown, readTool: any, path: string): Promise<string[]> {
  const result = await readTool.execute("r1", { path }, undefined, undefined, ctx);
  return getText(result)
    .split("\n")
    .filter((line) => /^[A-Za-z0-9]{3}│/.test(line))
    .map(extractHash);
}

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
            path: "bad-anchor.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "ALPHA" },
              // A `HASH│row` copied out of served output: `resEdit` rejects the item's anchor syntax.
              { anchor_from: `${hashes[1]}│beta`, anchor_to: hashes[1]!, replace_with: "BETA" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;

      // The item keeps its OWN code: `E_BATCH_ABORT` is reserved for overlapping/nested spans, and a
      // model sent hunting for coordinate overlap instead of fixing the anchor string retries wrong.
      expect(rejection.message).toContain("[E_MALFORMED_ANCHOR]");
      expect(rejection.message).not.toContain("[E_BATCH_ABORT]");
      expect(rejection.message).toContain("edit[1] (bad-anchor.txt)");
      expect(rejection.message).toContain(ATOMICITY_TRAILER);
      expect(await readFile(path, "utf-8")).toBe(content);
    });
  });

  it("an item that fails inside the sequential apply surfaces its own code plus the trailer", async () => {
    const content = "alpha\nbeta\ngamma\n";
    await withTempFile("apply-loop.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "apply-loop.txt");

      // Item 0 applies to the in-memory working buffer, then item 1's replacement contains a served hash echo
      // served for the line it replaces: the failure is raised in the sequential apply loop, after an
      // earlier item has already been applied to the buffer.
      const rejection = (await editTool
        .execute(
          "e1",
          {
            path: "apply-loop.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "ALPHA" },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: `${hashes[1]}│beta` },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;

      expect(rejection.message).toContain("[E_SUSPICIOUS_TEXT]");
      expect(rejection.message).not.toContain("[E_BATCH_ABORT]");
      expect(rejection.message).toContain("edit[1] (apply-loop.txt) failed");
      expect(rejection.message).toContain(ATOMICITY_TRAILER);
      // The earlier item reached only the in-memory buffer: the file keeps its pre-call bytes.
      expect(await readFile(path, "utf-8")).toBe(content);
    });
  });

  it("an item rejected while the batch applies surfaces its own code plus the trailer", async () => {
    const original = "alpha\nbeta\ngamma\n";
    const drifted = "alpha\nBETA\ngamma\n";
    await withTempFile("apply-failure.txt", original, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "apply-failure.txt");

      // Out-of-band write retires the leased line identity the item's anchor names, so item 1 fails
      // the served-state gate even though item 0 is still fine.
      await writeFile(path, drifted, "utf-8");

      const rejection = (await editTool
        .execute(
          "e1",
          {
            path: "apply-failure.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "ALPHA" },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "beta" },
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
      expect(rejection.message).toContain(ATOMICITY_TRAILER);
      expect(await readFile(path, "utf-8")).toBe(drifted);
    });
  });
});

describe("batch abort serve-block preservation and isolation (spec D2, section 3.4)", () => {
  const nineLines = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"].join("\n") + "\n";

  /** Reads lines 1-3 and 7-9, leaving the interior 4-6 never served. */
  async function partialServe(
    ctx: unknown,
    readTool: any,
    name: string,
  ): Promise<{ l1Ref: string; l3Ref: string; l7Ref: string }> {
    const first = await readTool.execute("r1", { path: name, limit: 3 }, undefined, undefined, ctx);
    const firstText = getText(first);
    const second = await readTool.execute(
      "r2",
      { path: name, offset: 7 },
      undefined,
      undefined,
      ctx,
    );
    const secondText = getText(second);
    return {
      l1Ref: extractHash(firstText.split("\n").find((l) => l.includes("│l1"))!),
      l3Ref: extractHash(firstText.split("\n").find((l) => l.includes("│l3"))!),
      l7Ref: extractHash(secondText.split("\n").find((l) => l.includes("│l7"))!),
    };
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
      const { l1Ref, l3Ref, l7Ref } = await partialServe(ctx, readTool, "batch-serve.txt");
      const rejection = (await editTool
        .execute(
          "e1",
          {
            path: "batch-serve.txt",
            edits: [
              { anchor_from: l1Ref, anchor_to: l1Ref, replace_with: "L1" },
              { anchor_from: l3Ref, anchor_to: l7Ref, replace_with: "X" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Caught;

      // The failing item keeps its own code and retry rows — never a relabel, never a re-read.
      expect(rejection.code).toBe("E_STALE_RANGE");
      expect(rejection.message).toContain("[E_STALE_RANGE]");
      expect(rejection.message).not.toContain("[E_BATCH_ABORT]");
      expect(rejection.message).toContain("edit[1] (batch-serve.txt)");
      expect(rejection.message).toContain(ATOMICITY_TRAILER);
      // The pre-rendered serve block survives the abort instead of degrading to "".
      expect(typeof rejection.servedBlock).toBe("string");
      expect(rejection.servedBlock!.length).toBeGreaterThan(0);
      const rows = rejection.servedRows ?? [];
      expect(rows).toHaveLength(5);
      const blockLines = rejection
        .servedBlock!.split("\n")
        .filter((line) => /^[A-Za-z0-9]{3}│/.test(line));
      expect(blockLines).toHaveLength(rows.length);
      for (const row of rows) {
        expect(rejection.servedBlock).toContain(`${row.hash}│`);
      }
      // The block renders the failing item's window (lines 3-7), content-exact.
      expect(blockLines.map((line) => line.split("│")[1])).toEqual(["l3", "l4", "l5", "l6", "l7"]);
      // The batch envelope keeps the failing item's own diagnosis.
      expect(rejection.details?.cause).toBe("never-served");
      // Atomicity: the clean sibling reached only the buffer.
      expect(await readFile(path, "utf-8")).toBe(nineLines);
    });
  });

  it("reports only the failing item with no sibling state leaking in", async () => {
    await withTempFile("batch-isolated.txt", nineLines, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const { l1Ref, l3Ref, l7Ref } = await partialServe(ctx, readTool, "batch-isolated.txt");
      const rejection = (await editTool
        .execute(
          "e1",
          {
            path: "batch-isolated.txt",
            edits: [
              { anchor_from: l1Ref, anchor_to: l1Ref, replace_with: "L1" },
              { anchor_from: l3Ref, anchor_to: l7Ref, replace_with: "X" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Caught;

      expect(rejection.code).toBe("E_STALE_RANGE");
      // Sibling feedback keys stay per item: exactly the failing index is named.
      expect(rejection.message).toContain("edit[1]");
      expect(rejection.message).not.toContain("edit[0]");
      expect(rejection.message.match(/edit\[\d+\]/g)).toEqual(["edit[1]"]);
      // No sibling bytes leak into the envelope: the block holds the failing window only.
      const blockLines = (rejection.servedBlock ?? "")
        .split("\n")
        .filter((line) => /^[A-Za-z0-9]{3}│/.test(line));
      expect(blockLines.map((line) => line.split("│")[1])).toEqual(["l3", "l4", "l5", "l6", "l7"]);
      expect(blockLines.join("\n")).not.toContain("L1");
      expect(rejection.message).not.toContain("│L1");
      expect(await readFile(path, "utf-8")).toBe(nineLines);
    });
  });
});
