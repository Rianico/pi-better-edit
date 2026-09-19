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
