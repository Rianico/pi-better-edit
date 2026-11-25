import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { lineHashes } from "../../src/hashline/hash-identity.js";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures";

/** The unified batch-rejection verdict line every multi-item rejection carries (spec #329 §4). */
const BATCH_VERDICT =
  /^\[MODEL\] Batch rejected: \d+ of \d+ edits? failed; nothing was written\.$/m;

async function doRead(ctx: any, readTool: any): Promise<void> {
  await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
}

describe("edit noop-loop counter commit boundary", () => {
  it("keeps the counters when a later item in the batch rejects", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path: file }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", file);
      await doRead(ctx, readTool);
      const noop = {
        file: "sample.ts",
        edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" }],
      };

      const first = await editTool.execute("e1", noop, undefined, undefined, ctx);
      expect(getText(first)).toContain("No changes made");
      const second = await editTool.execute("e2", noop, undefined, undefined, ctx);
      expect(getText(second)).toContain("[W_NOOP]");

      const rejection = (await editTool
        .execute(
          "e3",
          {
            file: "sample.ts",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "AAA" },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: `${hashes[1]!}│bbb` },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;
      expect(rejection.message).toContain("[E_SUSPICIOUS_TEXT]");
      expect(rejection.message).toMatch(BATCH_VERDICT);
      expect(await readFile(file, "utf-8")).toBe("aaa\nbbb\nccc\nddd\n");

      const third = (await editTool
        .execute("e4", noop, undefined, undefined, ctx)
        .catch((error: unknown) => error)) as Error;
      expect(third).toBeInstanceOf(Error);
      expect(third.message).toContain("[E_NOOP_LOOP]");
    });
  });

  it("keeps the counters when the atomic write fails", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path: file }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", file);
      await doRead(ctx, readTool);
      const noop = {
        file: "sample.ts",
        edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" }],
      };

      await editTool.execute("e1", noop, undefined, undefined, ctx);
      const second = await editTool.execute("e2", noop, undefined, undefined, ctx);
      expect(getText(second)).toContain("[W_NOOP]");

      const fsWrite = await import("../../src/fs-write");
      const spy = vi.spyOn(fsWrite, "writeAtomic").mockRejectedValueOnce(new Error("disk full"));
      try {
        await expect(
          editTool.execute(
            "e3",
            {
              file: "sample.ts",
              edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "AAA" }],
            },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
      expect(await readFile(file, "utf-8")).toBe("aaa\nbbb\nccc\nddd\n");

      const third = (await editTool
        .execute("e4", noop, undefined, undefined, ctx)
        .catch((error: unknown) => error)) as Error;
      expect(third).toBeInstanceOf(Error);
      expect(third.message).toContain("[E_NOOP_LOOP]");
    });
  });

  it("clears the counters after a successful apply", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path: file }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", file);
      await doRead(ctx, readTool);
      const noop = {
        file: "sample.ts",
        edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" }],
      };

      await editTool.execute("e1", noop, undefined, undefined, ctx);
      await editTool.execute("e2", noop, undefined, undefined, ctx);

      const applied = await editTool.execute(
        "e3",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[3]!, anchor_to: hashes[3]!, text: "DDD" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(applied)).toContain("Successfully edited");
      expect(await readFile(file, "utf-8")).toBe("aaa\nbbb\nccc\nDDD\n");

      await doRead(ctx, readTool);
      const fresh = await lineHashes("aaa\nbbb\nccc\nDDD\n", file);
      const resubmitted = await editTool.execute(
        "e4",
        {
          file: "sample.ts",
          edits: [{ anchor_from: fresh[1]!, anchor_to: fresh[1]!, text: "bbb" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(resubmitted)).toContain("No changes made");
      expect(getText(resubmitted)).not.toContain("[W_NOOP]");
      expect(getText(resubmitted)).not.toContain("[E_NOOP_LOOP]");
    });
  });
});
