import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures";

/** The atomicity trailer every item rejection of a multi-item call must carry (spec §3.2.3). */
const ATOMICITY_TRAILER =
  "The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.";

async function doRead(ctx: any, readTool: any): Promise<void> {
  await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
}

describe("edit noop-loop counter commit boundary", () => {
  it("keeps the counters when a later item in the batch rejects", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path: file }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", file);
      await doRead(ctx, readTool);
      const noop = { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "bbb"]] };

      // WHY: two identical no-ops arm the counter to the warn tier (2x); the
      // WHY: third identical resend must refuse (3x).
      const first = await editTool.execute("e1", noop, undefined, undefined, ctx);
      expect(getText(first)).toContain("No changes made");
      const second = await editTool.execute("e2", noop, undefined, undefined, ctx);
      expect(getText(second)).toContain("[W_NOOP]");

      // WHY: item 0 applies to the in-memory working buffer, then item 1's
      // WHY: replacement reproduces a served row, so the loop rejects after an
      // WHY: earlier item applied in memory — the batch rolls back with zero
      // WHY: bytes written. A commit-boundary clear must leave the counters
      // WHY: intact here; an in-loop clear wipes them despite the rollback.
      const rejection = (await editTool
        .execute(
          "e3",
          {
            path: "sample.ts",
            edits: [
              [hashes[0]!, hashes[0]!, "AAA"],
              [hashes[1]!, hashes[1]!, `${hashes[1]!}│bbb`],
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;
      expect(rejection.message).toContain("[E_SUSPICIOUS_TEXT]");
      expect(rejection.message).toContain(ATOMICITY_TRAILER);
      expect(await readFile(file, "utf-8")).toBe("aaa\nbbb\nccc\nddd\n");

      // WHY: the counters survived the rollback, so the identical resend is
      // WHY: the third strike and refuses.
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
      const noop = { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "bbb"]] };

      await editTool.execute("e1", noop, undefined, undefined, ctx);
      const second = await editTool.execute("e2", noop, undefined, undefined, ctx);
      expect(getText(second)).toContain("[W_NOOP]");

      // WHY: the applied item reaches the in-memory buffer, then the atomic
      // WHY: write fails and the undo restores the pre-call bytes — zero bytes
      // WHY: changed. The counters must survive: the post-commit clear site is
      // WHY: never reached.
      const fsWrite = await import("../../src/fs-write");
      const spy = vi.spyOn(fsWrite, "writeAtomic").mockRejectedValueOnce(new Error("disk full"));
      try {
        await expect(
          editTool.execute(
            "e3",
            { path: "sample.ts", edits: [[hashes[0]!, hashes[0]!, "AAA"]] },
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
      const noop = { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "bbb"]] };

      await editTool.execute("e1", noop, undefined, undefined, ctx);
      await editTool.execute("e2", noop, undefined, undefined, ctx);

      // WHY: a committed apply resets the loop tracker, so a fresh resend
      // WHY: starts from zero — no warn tier, no refusal.
      const applied = await editTool.execute(
        "e3",
        { path: "sample.ts", edits: [[hashes[3]!, hashes[3]!, "DDD"]] },
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
        { path: "sample.ts", edits: [[fresh[1]!, fresh[1]!, "bbb"]] },
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
