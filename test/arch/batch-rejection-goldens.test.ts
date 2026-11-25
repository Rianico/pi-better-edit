import { beforeAll, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  contentOnlyHashes,
  initHasher,
  fileHashesFor,
  lineHashes,
} from "../../src/hashline/hash-identity.js";
import { SPAN_MODE_ENV_VAR } from "../../src/span-mode-config.js";
import {
  anchorRows,
  extractHash,
  getText,
  setupIntegrationTest,
  withTempDir,
} from "../support/fixtures.js";
/**
 * Batch-rejection goldens (#334): each scenario renders through the real tool
 * seam and asserts the FULL model-facing message with `toBe`, so any byte the
 * refactor changes fails here. Row hashes embed the per-run temp dir (the path
 * seeds them), so row-carrying scenarios derive hash values via the production
 * `fileHashesFor` while positions, contents, verdicts, and headings stay
 * literal; S5 normalizes the `cwd` prefix to `<cwd>` for the same reason.
 */
beforeAll(async () => {
  await initHasher();
});

async function fails(execute: Promise<unknown>): Promise<Error> {
  try {
    await execute;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the edit to be rejected");
}

describe("batch rejection goldens (#334)", () => {
  it("pins a single stale item in a 2-item call (range family, fresh-read rows)", async () => {
    await withTempDir("batch-golden-stale-", async (cwd) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const path = join(cwd, "sample.ts");
      await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", path);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");
      const error = await fails(
        editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "ALPHA" },
              { anchor_from: hashes[1]!, anchor_to: hashes[2]!, text: "BETA\ngamma" },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      const drifted = "alpha\nBETA\ngamma\n";
      const driftedHashes = fileHashesFor(path, drifted);
      expect(error.message).toBe(
        "[MODEL] Batch rejected: 1 of 2 edits failed; nothing was written.\n" +
          "- edit[1] (sample.ts) [E_UNVERIFIED_RANGE]: a bound of this range no longer resolves to the line identity it was served with.\n" +
          "  Current range (fresh read):\n" +
          `  ${driftedHashes[1]}│BETA\n` +
          `  ${driftedHashes[2]}│gamma`,
      );
    });
  });

  it("pins a single rowless strict refusal in a 2-item call (E_UNSERVED_RANGE)", async () => {
    await withTempDir("batch-golden-strict-", async (cwd) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const content = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";
      await writeFile(join(cwd, "sample.txt"), content, "utf-8");
      await readTool.execute(
        "r1",
        { file: "sample.txt", windows: [{ offset: 1, limit: 3 }] },
        undefined,
        undefined,
        ctx,
      );
      await readTool.execute(
        "r2",
        { file: "sample.txt", windows: [{ offset: 7 }] },
        undefined,
        undefined,
        ctx,
      );
      const hashes = await lineHashes(content, join(cwd, "sample.txt"));
      process.env[SPAN_MODE_ENV_VAR] = "strict";
      try {
        const error = await fails(
          editTool.execute(
            "e1",
            {
              file: "sample.txt",
              edits: [
                { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "L1" },
                { anchor_from: hashes[2]!, anchor_to: hashes[6]!, text: "X" },
              ],
            },
            undefined,
            undefined,
            ctx,
          ),
        );
        expect(error.message).toBe(
          "[MODEL] Batch rejected: 1 of 2 edits failed; nothing was written.\n" +
            "- edit[1] (sample.txt) [E_UNSERVED_RANGE]: Strict span mode refused the edit to sample.txt: 3 of the 5 file lines it replaces were never served.\n" +
            "  Unserved file lines: 4-6",
        );
      } finally {
        delete process.env[SPAN_MODE_ENV_VAR];
      }
    });
  });

  it("pins several malformed items, one bullet each", async () => {
    await withTempDir("batch-golden-malformed-", async (cwd) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      await writeFile(join(cwd, "m.txt"), "alpha\nbeta\ngamma\n", "utf-8");
      const error = await fails(
        editTool.execute(
          "e1",
          {
            file: "m.txt",
            edits: [
              { anchor_from: "ZZ", anchor_to: "ZZ", text: "X" },
              { anchor_from: "QQQ", anchor_to: "QQQ", text: "Y" },
              { anchor_from: "WWWWW", anchor_to: "WWWWW", text: "Z" },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(error.message).toBe(
        "[MODEL] Batch rejected: 3 of 3 edits failed; nothing was written.\n" +
          '- edit[0] (m.txt) [E_MALFORMED_ANCHOR]: The anchor "ZZ" is not valid: Expected a 4-char alphanumeric anchor (e.g. "aB3x").\n' +
          '- edit[1] (m.txt) [E_MALFORMED_ANCHOR]: The anchor "QQQ" is not valid: Expected a 4-char alphanumeric anchor (e.g. "aB3x").\n' +
          '- edit[2] (m.txt) [E_MALFORMED_ANCHOR]: The anchor "WWWWW" is not valid: Expected a 4-char alphanumeric anchor (e.g. "aB3x").',
      );
    });
  });

  it("pins overlapping spans (E_BATCH_ABORT fold with Options line)", async () => {
    await withTempDir("batch-golden-overlap-", async (cwd) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const path = join(cwd, "sample.ts");
      await writeFile(path, "aaa\nbbb\nccc\n", "utf-8");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const error = await fails(
        editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BBB" },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "XX" },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      const currentHashes = fileHashesFor(path, "aaa\nbbb\nccc\n");
      expect(error.message).toBe(
        "[MODEL] Batch rejected: 1 of 2 edits failed; nothing was written.\n" +
          "- edit[1] (sample.ts) [E_BATCH_ABORT]: its span (lines 2-2) overlaps edit[0] (lines 2-2) at lines 2-2.\n" +
          "  Current range:\n" +
          `  ${currentHashes[1]}│bbb\n` +
          "  Options: merge the overlapping items into one span; or split them across separate calls.",
      );
    });
  });

  it("pins a 1-item failing call as a bare error with no verdict line", async () => {
    await withTempDir("batch-golden-single-", async (cwd) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await writeFile(join(cwd, "q.txt"), "one\ntwo\n", "utf-8");
      await readTool.execute("r1", { file: "q.txt" }, undefined, undefined, ctx);
      const error = await fails(
        editTool.execute(
          "e1",
          { file: "q.txt", edits: [{ anchor_from: "ZZZZ", anchor_to: "ZZZZ", text: "NEW" }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(error.message).not.toContain("Batch rejected:");
      expect(error.message.replace(cwd, "<cwd>")).toBe(
        '[MODEL] [E_UNKNOWN_ANCHOR] <cwd>/q.txt has not served the anchor "ZZZZ".',
      );
    });
  });

  it("pins a two-stage rejection with one bullet per stage in call order", async () => {
    await withTempDir("batch-golden-twostage-", async (cwd) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await writeFile(join(cwd, "a.txt"), "1\n2\n3\n", "utf-8");
      await writeFile(join(cwd, "b.txt"), "x\ny\nz\n", "utf-8");
      const target = anchorRows(
        getText(await readTool.execute("r1", { file: "a.txt" }, undefined, undefined, ctx)),
      ).map(extractHash);
      const foreign = await contentOnlyHashes("x\ny\nz\n");
      const error = await fails(
        editTool.execute(
          "e1",
          {
            file: "a.txt",
            edits: [
              { anchor_from: "ZZ", anchor_to: "ZZ", text: "X" },
              {
                anchor_from: target[1]!,
                anchor_to: target[1]!,
                text_ref: {
                  anchor_from: foreign[0]!,
                  anchor_to: foreign[1]!,
                  file: "b.txt",
                  mode: "copy",
                },
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(error.message).toBe(
        "[MODEL] Batch rejected: 2 of 2 edits failed; nothing was written.\n" +
          '- edit[0] (a.txt) [E_MALFORMED_ANCHOR]: The anchor "ZZ" is not valid: Expected a 4-char alphanumeric anchor (e.g. "aB3x").\n' +
          `- edit[1] (a.txt) [E_UNKNOWN_ANCHOR]: b.txt has not served the anchors "${foreign[0]}", "${foreign[1]}".`,
      );
    });
  });

  it("pins a gate-validation plus foreign failure in call order (literal probe)", async () => {
    await withTempDir("batch-golden-gate-foreign-", async (cwd) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await writeFile(join(cwd, "a.txt"), "1\n2\n3\n", "utf-8");
      await writeFile(join(cwd, "b.txt"), "x\ny\nz\n", "utf-8");
      const target = anchorRows(
        getText(await readTool.execute("r1", { file: "a.txt" }, undefined, undefined, ctx)),
      ).map(extractHash);
      const foreign = await contentOnlyHashes("x\ny\nz\n");
      const error = await fails(
        editTool.execute(
          "e1",
          {
            file: "a.txt",
            edits: [
              { anchor_from: "zzzz", anchor_to: "zzzz", text: "X" },
              {
                anchor_from: target[1]!,
                anchor_to: target[1]!,
                text_ref: {
                  anchor_from: foreign[0]!,
                  anchor_to: foreign[1]!,
                  file: "b.txt",
                  mode: "copy",
                },
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(error.message).toBe(
        "[MODEL] Batch rejected: 2 of 2 edits failed; nothing was written.\n" +
          '- edit[0] (a.txt) [E_UNKNOWN_ANCHOR]: a.txt has not served the anchor "zzzz".\n' +
          `- edit[1] (a.txt) [E_UNKNOWN_ANCHOR]: b.txt has not served the anchors "${foreign[0]}", "${foreign[1]}".`,
      );
      expect((error as Error & { code?: unknown }).code).toBe("E_UNKNOWN_ANCHOR");
      expect(await readFile(join(cwd, "a.txt"), "utf-8")).toBe("1\n2\n3\n");
      expect(await readFile(join(cwd, "b.txt"), "utf-8")).toBe("x\ny\nz\n");
    });
  });

  it("pins a malformed plus overlapping pair in call order (composition)", async () => {
    await withTempDir("batch-golden-composition-", async (cwd) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const path = join(cwd, "sample.ts");
      await writeFile(path, "aaa\nbbb\nccc\n", "utf-8");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const error = await fails(
        editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [
              { anchor_from: "ZZ", anchor_to: "ZZ", text: "X" },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BBB" },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "XX" },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      const currentHashes = fileHashesFor(path, "aaa\nbbb\nccc\n");
      expect(error.message).toBe(
        "[MODEL] Batch rejected: 2 of 3 edits failed; nothing was written.\n" +
          '- edit[0] (sample.ts) [E_MALFORMED_ANCHOR]: The anchor "ZZ" is not valid: Expected a 4-char alphanumeric anchor (e.g. "aB3x").\n' +
          "- edit[2] (sample.ts) [E_BATCH_ABORT]: its span (lines 2-2) overlaps edit[1] (lines 2-2) at lines 2-2.\n" +
          "  Current range:\n" +
          `  ${currentHashes[1]}│bbb\n` +
          "  Options: merge the overlapping items into one span; or split them across separate calls.",
      );
      expect((error as Error & { code?: unknown }).code).toBe("E_MALFORMED_ANCHOR");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("pins a gate-validation plus overlapping pair in call order (gate composition)", async () => {
    await withTempDir("batch-golden-gate-composition-", async (cwd) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const path = join(cwd, "sample.ts");
      await writeFile(path, "aaa\nbbb\nccc\n", "utf-8");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const error = await fails(
        editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [
              { anchor_from: "zzzz", anchor_to: "zzzz", text: "X" },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BBB" },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "XX" },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      const currentHashes = fileHashesFor(path, "aaa\nbbb\nccc\n");
      expect(error.message).toBe(
        "[MODEL] Batch rejected: 2 of 3 edits failed; nothing was written.\n" +
          '- edit[0] (sample.ts) [E_UNKNOWN_ANCHOR]: sample.ts has not served the anchor "zzzz".\n' +
          "- edit[2] (sample.ts) [E_BATCH_ABORT]: its span (lines 2-2) overlaps edit[1] (lines 2-2) at lines 2-2.\n" +
          "  Current range:\n" +
          `  ${currentHashes[1]}│bbb\n` +
          "  Options: merge the overlapping items into one span; or split them across separate calls.",
      );
      expect((error as Error & { code?: unknown }).code).toBe("E_UNKNOWN_ANCHOR");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("pins a missing target file preempting a malformed item with the bare load error", async () => {
    await withTempDir("batch-golden-missing-", async (cwd) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      // When the target file is missing, the load preempts merged failures: the bare answer is the accepted consequence of the single call-wide merge — reverting would discard a surviving item's validation failure.
      const error = await fails(
        editTool.execute(
          "e1",
          {
            file: "missing.txt",
            edits: [
              { anchor_from: "ZZ", anchor_to: "ZZ", text: "X" },
              { anchor_from: "abcd", anchor_to: "abcd", text: "Y" },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(error.message).not.toContain("Batch rejected:");
      expect(error.message).toBe("[MODEL] [E_NOT_FOUND] File not found: missing.txt.");
    });
  });
});
