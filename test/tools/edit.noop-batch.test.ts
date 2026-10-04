import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures";

/** The atomicity trailer every item rejection of a multi-item call must carry (spec §3.2.3). */
const ATOMICITY_TRAILER =
  "The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.";

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function doRead(ctx: any, readTool: any, file: string): Promise<void> {
  await readTool.execute("r1", { file: file }, undefined, undefined, ctx);
}

describe("edit noop-loop guard in multi-item calls", () => {
  it("routes a looping second item through the batch envelope once with the atomicity trailer", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\neee\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\neee\n", path);
      await doRead(ctx, readTool, "sample.ts");

      // WHY: the first item names a different range on every submission, so its
      // WHY: slot keeps resetting while the second item's slot accumulates —
      // WHY: only per-slot tracking lets the sibling loop trip.
      const firstVariants: Array<[string, string]> = [
        [hashes[0]!, "aaa"],
        [hashes[2]!, "ccc"],
        [hashes[3]!, "ddd"],
      ];
      for (let round = 0; round < 2; round++) {
        const [anchor, replacement] = firstVariants[round]!;
        const result = await editTool.execute(
          `e${round + 1}`,
          {
            file: "sample.ts",
            edits: [
              { anchor_from: anchor, anchor_to: anchor, text: replacement },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" },
            ],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(result.details.metrics.classification).toBe("noop");
      }

      const [anchor, replacement] = firstVariants[2]!;
      const rejection = (await editTool
        .execute(
          "e3",
          {
            file: "sample.ts",
            edits: [
              { anchor_from: anchor, anchor_to: anchor, text: replacement },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error & { code?: string };

      expect(rejection.message).toContain("[E_NOOP_LOOP]");
      expect(rejection.code).toBe("E_NOOP_LOOP");
      // The looping sibling is named once, by the envelope — the inner
      // diagnostic no longer repeats it.
      expect(countOccurrences(rejection.message, "edit[1]")).toBe(1);
      expect(rejection.message).toContain("edit[1] (sample.ts) failed");
      expect(rejection.message).not.toContain("edit[0]");
      expect(rejection.message).toContain(ATOMICITY_TRAILER);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\nddd\neee\n");
    });
  });

  it("trips the guard when the same multi-item call is submitted repeatedly", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", path);
      await doRead(ctx, readTool, "sample.ts");

      const payload = {
        file: "sample.ts",
        edits: [
          { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "aaa" },
          { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" },
        ],
      };

      const first = await editTool.execute("e1", payload, undefined, undefined, ctx);
      expect(first.details.metrics.classification).toBe("noop");
      expect(getText(first)).not.toContain("[W_NOOP]");

      const second = await editTool.execute("e2", payload, undefined, undefined, ctx);
      expect(second.details.metrics.classification).toBe("noop");
      expect(getText(second)).toContain("[W_NOOP]");

      const rejection = (await editTool
        .execute("e3", payload, undefined, undefined, ctx)
        .catch((error: unknown) => error)) as Error & { code?: string };
      expect(rejection.message).toContain("[E_NOOP_LOOP]");
      expect(rejection.code).toBe("E_NOOP_LOOP");
      expect(rejection.message).toContain(ATOMICITY_TRAILER);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\nddd\n");
    });
  });

  it("keeps the single-item loop rejection free of the batch envelope", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await doRead(ctx, readTool, "sample.ts");

      const payload = {
        file: "sample.ts",
        edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" }],
      };

      const first = await editTool.execute("e1", payload, undefined, undefined, ctx);
      expect(first.details.metrics.classification).toBe("noop");

      const second = await editTool.execute("e2", payload, undefined, undefined, ctx);
      expect(getText(second)).toContain("[USER] [W_NOOP]");

      const rejection = (await editTool
        .execute("e3", payload, undefined, undefined, ctx)
        .catch((error: unknown) => error)) as Error & { code?: string };
      expect(rejection.message).toContain("[MODEL] [E_NOOP_LOOP]");
      expect(rejection.message).toContain("edit[0] (sample.ts)");
      expect(rejection.message).toContain("rejecting.");
      expect(rejection.message).not.toContain("rejecting the batch");
      expect(rejection.message).not.toContain("failed:");
      expect(rejection.message).not.toContain(ATOMICITY_TRAILER);
      expect(rejection.code).toBe("E_NOOP_LOOP");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("clearNoopLoop drops every slot for the file", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", path);
      await doRead(ctx, readTool, "sample.ts");

      const payload = {
        file: "sample.ts",
        edits: [
          { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "aaa" },
          { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" },
        ],
      };
      await editTool.execute("e1", payload, undefined, undefined, ctx);
      await editTool.execute("e2", payload, undefined, undefined, ctx);

      // WHY: an applied edit clears the guard, so both sibling slots restart —
      // WHY: a partial clear would leave one slot armed and reject below.
      await editTool.execute(
        "e3",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[2]!, anchor_to: hashes[2]!, text: "CCC" }],
        },
        undefined,
        undefined,
        ctx,
      );
      await doRead(ctx, readTool, "sample.ts");
      const fresh = await lineHashes("aaa\nbbb\nCCC\nddd\n", path);
      const resubmitted = {
        file: "sample.ts",
        edits: [
          { anchor_from: fresh[0]!, anchor_to: fresh[0]!, text: "aaa" },
          { anchor_from: fresh[1]!, anchor_to: fresh[1]!, text: "bbb" },
        ],
      };

      const third = await editTool.execute("e4", resubmitted, undefined, undefined, ctx);
      expect(third.details.metrics.classification).toBe("noop");
      expect(getText(third)).not.toContain("[W_NOOP]");

      const fourth = await editTool.execute("e5", resubmitted, undefined, undefined, ctx);
      expect(fourth.details.metrics.classification).toBe("noop");
      expect(getText(fourth)).toContain("[W_NOOP]");
      expect(getText(fourth)).not.toContain("[E_NOOP_LOOP]");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nCCC\nddd\n");
    });
  });
});
