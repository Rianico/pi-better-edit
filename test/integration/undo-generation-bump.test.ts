import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadHashStore } from "../../src/hash-store.js";
import { upsertUndo } from "../../src/undo-store.js";
import { contentOnlyHashes, fileHashesFor } from "../../src/hashline/index.js";
import {
  adoptPinnedSnapshotFor,
  anchorsForSnapshotHash,
} from "../../src/snapshot-store/index.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures";

const PRE = "aaa\nbbb\nccc\n";
const POST = "aaa\nBBB\nccc\n";

function rows(text: string): { hash: string; text: string }[] {
  const out: { hash: string; text: string }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z0-9]{4})│(.*)$/);
    if (m) out.push({ hash: m[1]!, text: m[2]! });
  }
  return out;
}

async function plantLegacyRow(absPath: string): Promise<void> {
  // WHY: reproduces a pre-bump store — the old code wrote content-only hashes with
  // WHY: a null key and no generation. `upsertUndo` always stamps the current
  // WHY: generation, so the test downgrades the row through SQL afterwards.
  const store = await loadHashStore();
  upsertUndo(store, absPath, {
    content: PRE,
    bom: "",
    ending: "\n",
    hashes: contentOnlyHashes(PRE),
    resultContent: POST,
    snapshotHash: null,
  });
  store.db.exec("UPDATE file_undo SET canon_version = 0 WHERE path = '" + absPath.replace(/'/g, "''") + "'");
}

describe("generation bump refuses pre-v3 anchors", () => {
  it("a legacy undo row restores file-scoped anchors and refuses cross-file use", async () => {
    await withTempFile("a.txt", POST, async ({ cwd }) => {
      const absA = join(cwd, "a.txt");
      const absB = join(cwd, "b.txt");
      await writeFile(absB, POST, "utf-8");
      await plantLegacyRow(absA);
      await plantLegacyRow(absB);
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      const editTool = getTool("edit");
      const undo = getTool("undo_last_edit");

      await undo.execute("u1", { path: "a.txt" }, undefined, undefined, ctx);
      await undo.execute("u2", { path: "b.txt" }, undefined, undefined, ctx);
      expect(await readFile(absA, "utf-8")).toBe(PRE);
      expect(await readFile(absB, "utf-8")).toBe(PRE);

      const aRows = rows(
        getText(await readTool.execute("r1", { path: "a.txt" }, undefined, undefined, ctx)),
      );
      const bRows = rows(
        getText(await readTool.execute("r2", { path: "b.txt" }, undefined, undefined, ctx)),
      );
      const expectedA = await fileHashesFor(absA, PRE);
      const expectedB = await fileHashesFor(absB, PRE);
      // WHY: the fresh read serves the current generation — never the planted
      // WHY: content-only hashes.
      expect(aRows.map((r) => r.hash)).toEqual(expectedA);
      expect(bRows.map((r) => r.hash)).toEqual(expectedB);
      expect(aRows.map((r) => r.hash)).not.toEqual(contentOnlyHashes(PRE));
      // WHY: explicit disjoint precondition for the refusal below.
      const inter = new Set(aRows.map((r) => r.hash));
      let overlap = 0;
      for (const r of bRows) if (inter.has(r.hash)) overlap++;
      expect(overlap).toBe(0);
      await expect(
        editTool.execute(
          "e1",
          {
            file: "b.txt",
            edits: [{ anchor_from: aRows[1]!.hash, anchor_to: aRows[1]!.hash, text: "CROSS" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_FOREIGN_ANCHOR/);
      expect(await readFile(absB, "utf-8")).toBe(PRE);
    });
  });

  it("a pinned foreign-generation descriptor is rejected and writes nothing", async () => {
    await withTempFile("p.txt", PRE, async ({ cwd }) => {
      const absP = join(cwd, "p.txt");
      await expect(
        adoptPinnedSnapshotFor({
          path: absP,
          snapshotHash: "2:deadbeef",
          lineCount: 3,
          hashes: contentOnlyHashes(PRE),
          content: PRE,
        }),
      ).rejects.toThrow(/E_BAD_PAYLOAD/);
      expect(await anchorsForSnapshotHash(absP, "2:deadbeef")).toBeUndefined();
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      const served = rows(
        getText(await readTool.execute("r1", { path: "p.txt" }, undefined, undefined, ctx)),
      );
      // WHY: the rejected pin left no lineage — the read serves the current
      // WHY: file-scoped derivation.
      expect(served.map((r) => r.hash)).toEqual(await fileHashesFor(absP, PRE));
    });
  });
});
