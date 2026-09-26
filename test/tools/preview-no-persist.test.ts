import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { DatabaseSync } from "node:sqlite";
import { lineHashes } from "../../src/hashline";
import { compPreview } from "../../src/edit";
import { loadHashStore } from "../../src/hash-store";
import { getSnapshot } from "../../src/snapshot-store";
import { hashStorePath } from "../../src/paths";
import { withTempFile, setupIntegrationTest } from "../support/fixtures";

describe("compPreview no-persist guarantee", () => {
  it("does not persist hypothetical result to hash store", async () => {
    const content = "a\nb\nc\nb\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (
        await import("../../src/fs-write")
      ).resolveTarget(await (await import("../../src/paths")).toCwd("sample.txt", cwd));
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);

      const hashes = await lineHashes(content, absolutePath);

      const storeBefore = await loadHashStore();
      const beforeHashes = getSnapshot(storeBefore, absolutePath, content);
      expect(beforeHashes).toBeDefined();
      expect(beforeHashes).toEqual(hashes);
      const bHash = hashes[1]!;
      const cHash = hashes[2]!;

      const preview = await compPreview(
        { path: "sample.txt", edits: [[bHash, cHash, "B"]] },
        cwd,
        ctx,
      );
      expect(preview).toHaveProperty("diff");

      const storeAfter = await loadHashStore();
      const afterHashes = getSnapshot(storeAfter, absolutePath, content);
      expect(afterHashes).toBeDefined();
      expect(afterHashes).toEqual(hashes);
    });
  });

  it("does not leave hypothetical snapshot behind after abandoned preview", async () => {
    const content = "a\nb\nc\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (
        await import("../../src/fs-write")
      ).resolveTarget(await (await import("../../src/paths")).toCwd("sample.txt", cwd));
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);

      const hashes = await lineHashes(content, absolutePath);

      await compPreview(
        { path: "sample.txt", edits: [[hashes[1]!, hashes[2]!, "X\nY"]] },
        cwd,
        ctx,
      );

      const store = await loadHashStore();
      expect(getSnapshot(store, absolutePath, content)).toEqual(hashes);
    });
  });

  it("does not invalidate anchors that were valid before preview", async () => {
    const content = "a\nb\nc\nb\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (
        await import("../../src/fs-write")
      ).resolveTarget(await (await import("../../src/paths")).toCwd("sample.txt", cwd));
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);

      const hashes = await lineHashes(content, absolutePath);

      const preview = await compPreview(
        { path: "sample.txt", edits: [[hashes[0]!, hashes[2]!, "x"]] },
        cwd,
        ctx,
      );
      expect(preview).toHaveProperty("diff");

      const freshHashes = await lineHashes(content, absolutePath);
      expect(freshHashes).toEqual(hashes);
    });
  });

  it("does not delete a corrupt snapshot row during preview", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (
        await import("../../src/fs-write")
      ).resolveTarget(await (await import("../../src/paths")).toCwd("sample.txt", cwd));
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const hashes = await lineHashes(content, absolutePath);
      const db = new DatabaseSync(hashStorePath(), { defensive: false } as any);
      db.prepare(
        "UPDATE line_lineage SET anchor = ? WHERE snapshot_id IN " +
          "(SELECT snapshot_id FROM file_snapshots WHERE path = ?) AND line_number = ?",
      ).run("ZZ", absolutePath, 1);
      db.prepare(
        "UPDATE line_lineage SET anchor = ? WHERE snapshot_id IN " +
          "(SELECT snapshot_id FROM file_snapshots WHERE path = ?) AND line_number = ?",
      ).run("ZZZZ", absolutePath, 2);
      db.close();

      const preview = await compPreview(
        { path: "sample.txt", edits: [[hashes[0]!, hashes[1]!, "X"]] },
        cwd,
        ctx,
      );
      expect(preview).toHaveProperty("diff");

      const check = new DatabaseSync(hashStorePath(), {
        defensive: false,
      } as any);
      const remaining = check
        .prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?")
        .get(absolutePath) as { n: number };
      check.close();
      expect(remaining.n).toBe(1);
    });
  });

  it("previewing a drifted range does not record serves — the same edit still rejects", async () => {
    const content = "alpha\nbeta\ngamma\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.txt" },
        undefined,
        undefined,
        ctx,
      );
      const firstText = firstRead.content[0].text as string;
      const lines = firstText.split("\n");
      const alphaRef = lines.find((l: string) => l.includes("│alpha"))!.split("│")[0]!;
      const gammaRef = lines.find((l: string) => l.includes("│gamma"))!.split("│")[0]!;

      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

      const preview = await compPreview(
        { path: "sample.txt", edits: [[alphaRef, gammaRef, "X"]] },
        cwd,
        ctx,
      );
      expect(preview).toHaveProperty("error");

      await expect(
        editTool.execute(
          "e1",
          { path: "sample.txt", edits: [[alphaRef, gammaRef, "X"]] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/\[E_STALE_RANGE\]/);
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("previewing over never-served lines does not make them served — their anchors still hold no lease", async () => {
    const content = "alpha\nbeta\ngamma\ndelta\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (
        await import("../../src/fs-write")
      ).resolveTarget(await (await import("../../src/paths")).toCwd("sample.txt", cwd));
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await readTool.execute(
        "r1",
        { path: "sample.txt", offset: 1, limit: 1 },
        undefined,
        undefined,
        ctx,
      );
      await readTool.execute(
        "r2",
        { path: "sample.txt", offset: 4, limit: 1 },
        undefined,
        undefined,
        ctx,
      );
      const hashes = await lineHashes(content, absolutePath);

      // Lines 2-3 are unserved; the interior gap renders a diff instead of a rejection (ADR-0024), so
      // the persistence detector moves to the interior anchors themselves.
      const preview = await compPreview(
        { path: "sample.txt", edits: [[hashes[0]!, hashes[3]!, "X"]] },
        cwd,
        ctx,
      );
      expect(preview).toHaveProperty("diff");

      // Had the preview served its hypothetical rows, lines 2-3 would now carry leases and this edit
      // would resolve. They must not, so the anchors stay unleased and the rejection carries no rows.
      await expect(
        editTool.execute(
          "e1",
          { path: "sample.txt", edits: [[hashes[1]!, hashes[2]!, "X"]] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/\[E_UNKNOWN_ANCHOR\]/);
    });
  });
});
