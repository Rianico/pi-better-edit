import { describe, expect, it } from "vitest";
import { Compile } from "typebox/compile";
import { readFile, writeFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { editToolSchema } from "../../src/edit";
import { prepareEditArguments } from "../../src/edit-normalize";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

/** The atomicity trailer every item rejection of a multi-item call must carry (spec §3.2.3). */
const ATOMICITY_TRAILER =
  "The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.";

async function doRead(ctx: any, readTool: any, path: string) {
  await readTool.execute("r1", { path }, undefined, undefined, ctx);
}

describe("edit multi-item tool", () => {
  it("applies disjoint same-file ranges in order", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\neee\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\neee\n", path);
      await doRead(ctx, readTool, "sample.ts");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          edits: [
            [hashes[0]!, hashes[0]!, "AAA"],
            [hashes[2]!, hashes[2]!, "CCC"],
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited 1 file(s)");
      expect(getText(result)).toContain("2 of 2 edit(s) applied");
      expect(await readFile(path, "utf-8")).toBe("AAA\nbbb\nCCC\nddd\neee\n");
      expect(result.details.diff).toContain("│AAA");
      expect(result.details.diff).toContain("│CCC");
    });
  });

  it("matches single-edit behavior for a one-item payload", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await doRead(ctx, readTool, "sample.ts");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          edits: [[hashes[1]!, hashes[1]!, "BBB"]],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited 1 file(s)");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
      expect(result.details.diff).toContain("│BBB");
    });
  });

  it("rejects the whole call with nothing written when one item has a stale anchor", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", path);
      await doRead(ctx, readTool, "sample.ts");

      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

      const rejection = (await editTool
        .execute(
          "e1",
          {
            path: "sample.ts",
            edits: [
              [hashes[0]!, hashes[0]!, "ALPHA"],
              [hashes[1]!, hashes[1]!, "two"],
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;

      // The failing item keeps its OWN code — the retired lease is what the model must fix — plus the
      // atomicity trailer; `[E_BATCH_ABORT]` is reserved for overlapping/nested spans.
      expect(rejection.message).toContain("[E_TARGET_LOST]");
      expect(rejection.message).toContain("edit[1] (sample.ts) failed");
      expect(rejection.message).not.toContain("[E_BATCH_ABORT]");
      expect(rejection.message).toContain(ATOMICITY_TRAILER);

      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("serves a fresh read when an item's boundary anchor went stale", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", path);
      await doRead(ctx, readTool, "sample.ts");

      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

      const err = (await editTool
        .execute(
          "e1",
          {
            path: "sample.ts",
            edits: [
              [hashes[0]!, hashes[0]!, "ALPHA"],
              [hashes[1]!, hashes[2]!, "BETA\ngamma"],
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((e: unknown) => e)) as Error;
      expect(err.message).toContain("[E_UNVERIFIED_RANGE]");
      expect(err.message).toContain("edit[1] (sample.ts) failed");
      expect(err.message).not.toContain("[E_BATCH_ABORT]");
      expect(err.message).toContain(ATOMICITY_TRAILER);
      expect(err.message).toContain("Current range (fresh read):");

      const servedBeta = err.message.split("\n").find((l) => /^[A-Za-z0-9]{3}│BETA$/.test(l));
      expect(servedBeta).toBeDefined();
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");

      const servedHash = extractHash(servedBeta!);
      const followUp = await editTool.execute(
        "e2",
        {
          path: "sample.ts",
          edits: [[servedHash, servedHash, "beta"]],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(followUp)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("rejects overlapping items with nothing written", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await doRead(ctx, readTool, "sample.ts");

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.ts",
            edits: [
              [hashes[1]!, hashes[1]!, "BBB"],
              [hashes[1]!, hashes[1]!, "XX"],
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/\[E_BATCH_ABORT\] edit\[1\] \(sample\.ts\) failed/);

      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("reports a noop item without failing the call", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await doRead(ctx, readTool, "sample.ts");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          edits: [
            [hashes[1]!, hashes[1]!, "BBB"],
            [hashes[2]!, hashes[2]!, "ccc"],
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("1 of 2 edit(s) applied (1 noop)");
      expect(getText(result)).toContain("was a noop");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
      expect(result.details.metrics.classification).toBe("applied");
    });
  });

  it("reports no changes for an all-noop call", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await doRead(ctx, readTool, "sample.ts");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          edits: [[hashes[1]!, hashes[1]!, "bbb"]],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("No changes made");
      expect(result.details.metrics.classification).toBe("noop");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("rejects malformed envelopes with [E_BAD_PAYLOAD] without touching files", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await doRead(ctx, readTool, "sample.ts");

      const validator = Compile(editToolSchema);
      expect(
        validator.Check({
          file: "sample.ts",
          edits: [
            {
              anchor_from: hashes[0]!,
              anchor_to: hashes[0]!,
              replace_with: "AAA",
            },
          ],
        }),
      ).toBe(true);
      expect(
        validator.Check({
          file: "sample.ts",
          edits: [
            {
              file: "sample.ts",
              anchor_from: hashes[0]!,
              anchor_to: hashes[0]!,
              replace_with: "AAA",
            },
          ],
        }),
      ).toBe(false);

      await expect(
        editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [
              {
                file: "sample.ts",
                anchor_from: hashes[0]!,
                anchor_to: hashes[0]!,
                replace_with: "AAA",
              },
            ],
          } as any,
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_BAD_PAYLOAD/);
      await expect(
        editTool.execute("e1", { file: "sample.ts", edits: [] }, undefined, undefined, ctx),
      ).rejects.toThrow(/E_BAD_PAYLOAD/);

      await expect(editTool.execute("e1", "nope", undefined, undefined, ctx)).rejects.toThrow(
        /E_BAD_PAYLOAD/,
      );

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.ts",
            edits: [[hashes[0]!, hashes[0]!]],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_BAD_PAYLOAD/);

      const validItem = [hashes[0]!, hashes[0]!, "AAA"];
      const tooMany = Array.from({ length: 33 }, () => validItem);
      await expect(
        editTool.execute("e1", { path: "sample.ts", edits: tooMany }, undefined, undefined, ctx),
      ).rejects.toThrow(/E_BAD_PAYLOAD/);

      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("edits with an explicit file and carries no inference warning", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", path);
      await doRead(ctx, readTool, "sample.ts");

      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "AAA" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(
        result.details.warnings?.some((w: string) => w.includes('missing "file" resolved to')) ??
          false,
      ).toBe(false);
      expect(await readFile(path, "utf-8")).toBe("AAA\nbbb\n");
    });
  });

  it("applies item autocorrections (reversed range swap) like single edit", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await doRead(ctx, readTool, "sample.ts");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          edits: [[hashes[2]!, hashes[0]!, "XX"]],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(result.details.warnings?.some((w: string) => w.includes("[W_REVERSED_ANCHORS]"))).toBe(
        true,
      );
      expect(await readFile(path, "utf-8")).toBe("XX\n");
    });
  });

  it("reports drift outside the edited range on a successful call", async () => {
    await withTempFile(
      "sample.ts",
      "alpha\nbeta\ngamma\ndelta\nepsilon\n",
      async ({ cwd, path }) => {
        const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
        const hashes = await lineHashes("alpha\nbeta\ngamma\ndelta\nepsilon\n", path);
        await doRead(ctx, readTool, "sample.ts");

        await writeFile(path, "alpha\nbeta\ngamma\ndelta\nEPSILON\n", "utf-8");

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.ts",
            edits: [[hashes[1]!, hashes[1]!, "BETA"]],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(getText(result)).toContain("Successfully edited");
        expect(result.details.driftNotice).toContain("drift:");
        expect(result.details.driftNotice).toContain("EPSILON");
        expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\ndelta\nEPSILON\n");
      },
    );
  });

  it("applies the noop-loop guard to repeated all-noop calls", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await doRead(ctx, readTool, "sample.ts");

      const payload = {
        path: "sample.ts",
        edits: [[hashes[1]!, hashes[1]!, "bbb"]],
      };

      const first = await editTool.execute("e1", payload, undefined, undefined, ctx);
      expect(first.details.metrics.classification).toBe("noop");
      expect(getText(first)).not.toContain("[E_NOOP_LOOP]");

      const second = await editTool.execute("e2", payload, undefined, undefined, ctx);
      expect(getText(second)).toContain("[W_NOOP]");

      await expect(editTool.execute("e3", payload, undefined, undefined, ctx)).rejects.toThrow(
        /\[E_NOOP_LOOP\]/,
      );
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("serves the failing item's current range as usable anchors after a rejection", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await doRead(ctx, readTool, "sample.ts");

      const err = (await editTool
        .execute(
          "e1",
          {
            path: "sample.ts",
            edits: [
              [hashes[1]!, hashes[1]!, "BBB"],
              [hashes[1]!, hashes[1]!, "XX"],
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((e: unknown) => e)) as Error;
      expect(err.message).toContain("[E_BATCH_ABORT]");

      const servedRow = err.message.split("\n").find((l) => l.includes(`│${"bbb"}`))!;
      const servedHash = extractHash(servedRow);

      const followUp = await editTool.execute(
        "e2",
        {
          path: "sample.ts",
          edits: [[servedHash, servedHash, "BBB"]],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(followUp)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });
});

describe("prepareEditArguments normalization", () => {
  it("keeps the canonical object-root payload unchanged", () => {
    const args = {
      file: "a.ts",
      edits: [{ anchor_from: "AAA", anchor_to: "BBB", replace_with: "x" }],
    };
    expect(prepareEditArguments(args)).toEqual(args);
  });

  it("folds legacy tuples and null file to multi-item edits", () => {
    expect(
      prepareEditArguments({
        path: null,
        edits: [
          ["AAA", "BBB", "x"],
          ["CCC", "DDD", ""],
        ],
      }),
    ).toEqual({
      file: null,
      edits: [
        { anchor_from: "AAA", anchor_to: "BBB", replace_with: "x" },
        { anchor_from: "CCC", anchor_to: "DDD", replace_with: "" },
      ],
    });
  });

  it("rejects malformed shapes with an actionable E_BAD_PAYLOAD hint", () => {
    for (const args of [
      undefined,
      {},
      "a.ts",
      { file: "a.ts" },
      { file: "a.ts", edits: [] },
      { file: "a.ts", edits: "nope" },
      { file: "a.ts", edits: [["AAA"]] },
      { edit: ["a.ts", ["AAA", "BBB"], "x"] },
      ["a.ts", ["AAA", "BBB"], "x"],
    ]) {
      expect(() => prepareEditArguments(args)).toThrow(/\[E_BAD_PAYLOAD\]/);
      expect(() => prepareEditArguments(args)).toThrow(/canonical payload/);
    }
  });
});
