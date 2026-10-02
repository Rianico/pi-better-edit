import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { lineHashes, initHasher } from "../../src/hashline/index.js";
import { withTempDir, setupIntegrationTest, useTestHome, getText } from "../support/fixtures.js";

// TICKET-04b §4: the correlated undo. Both files of a cut share one `file_undo.transaction_id`;
// undo of EITHER file reverts BOTH, or fails closed with no partial revert. The stale signal is
// the EXISTING `E_UNDO_STALE` code (unchanged registry member, MODEL audience) extended to every
// file of the transaction — the payload names the member that broke freshness.
const home = useTestHome();

beforeAll(async () => {
  await initHasher();
});

const SOURCE_BEFORE = "a\nb\nc\nd\n";
const TARGET_BEFORE = "1\n2\n3\n";

async function cutThrough(cwd: string) {
  const { ctx, readTool, editTool, undoTool } = setupIntegrationTest(cwd);
  await writeFile(join(cwd, "source.txt"), SOURCE_BEFORE, "utf-8");
  await writeFile(join(cwd, "target.txt"), TARGET_BEFORE, "utf-8");
  await readTool.execute("r1", { path: "source.txt" }, undefined, undefined, ctx);
  await readTool.execute("r2", { path: "target.txt" }, undefined, undefined, ctx);
  const hs = await lineHashes(SOURCE_BEFORE, `${home.testPath}/source.txt`);
  const ht = await lineHashes(TARGET_BEFORE, `${home.testPath}/target.txt`);
  await editTool.execute(
    "e1",
    {
      file: "target.txt",
      edits: [
        {
          anchor_from: ht[0]!,
          anchor_to: ht[0]!,
          text_ref: { anchor_from: hs[1]!, anchor_to: hs[2]!, file: "source.txt", mode: "cut" },
        },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  // Committed cut: target "b\nc\n2\n3\n", source "a\nd\n".
  expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("b\nc\n2\n3\n");
  expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe("a\nd\n");
  return { ctx, undo: undoTool };
}

describe("correlated undo of a cut transaction (ticket-04b §4)", () => {
  it("undoing the SOURCE reverts BOTH files of the transaction", async () => {
    await withTempDir("cut-undo-source-", async (cwd) => {
      const { ctx, undo } = await cutThrough(cwd);
      const result = await undo.execute("u1", { path: "source.txt" }, undefined, undefined, ctx);
      expect(result.isError, getText(result)).toBeFalsy();
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
    });
  });

  it("undoing the TARGET reverts BOTH files of the transaction", async () => {
    await withTempDir("cut-undo-target-", async (cwd) => {
      const { ctx, undo } = await cutThrough(cwd);
      const result = await undo.execute("u1", { path: "target.txt" }, undefined, undefined, ctx);
      expect(result.isError, getText(result)).toBeFalsy();
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
    });
  });

  it("an outside change to the other member fails undo closed, naming it, with no partial revert", async () => {
    await withTempDir("cut-undo-stale-", async (cwd) => {
      const { ctx, undo } = await cutThrough(cwd);
      await writeFile(join(cwd, "source.txt"), "a\nd\nINJECTED\n", "utf-8");
      const result = await undo.execute("u1", { path: "target.txt" }, undefined, undefined, ctx);
      expect(result.isError, "a stale transaction member must refuse the whole undo").toBe(true);
      const text = getText(result);
      expect(text).toContain("E_UNDO_STALE");
      // The payload names the member that broke freshness, not the requested path.
      expect(text).toContain("source.txt");
      // Fail closed: the requested target is NOT reverted either.
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("b\nc\n2\n3\n");
    });
  });

  it("a deleted member arm: undo fails closed naming the deleted file", async () => {
    await withTempDir("cut-undo-deleted-", async (cwd) => {
      const { ctx, undo } = await cutThrough(cwd);
      await rm(join(cwd, "source.txt"));
      const result = await undo.execute("u1", { path: "target.txt" }, undefined, undefined, ctx);
      expect(result.isError, "a deleted transaction member must refuse the whole undo").toBe(true);
      const text = getText(result);
      expect(text).toContain("E_UNDO_STALE");
      expect(text).toContain("source.txt");
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("b\nc\n2\n3\n");
    });
  });
});
