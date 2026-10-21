import { describe, expect, it } from "vitest";
import { realpath, rename, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { anchorRows, getText, setupIntegrationTest, withTempFile } from "../support/fixtures";
import { loadHashStore } from "../../src/hash-store";
import { lineHashes } from "../../src/hashline/index.js";
import { contentChecksum } from "../../src/hashline/hasher.js";
import { fileSnap, prepareFile, statKeyOf } from "../../src/file-content/index.js";
import { findStatSnapshotFor, snapshotHashFor } from "../../src/snapshot-store";

const CONTENT_A = "alpha\nbravo\ncharlie\ndelta\n";
// WHY: same byte length, same line count, every line's canon different — the change a stat identity
// that failed to advance would otherwise hide (ADR-0043's fallback).
const CONTENT_B = "alphA\nbravO\ncharliE\ndeltA\n";

interface SnapshotRow {
  snapshot_id: number;
  snapshot_hash: string;
  line_count: number;
  stat_key: string | null;
}

async function canonical(path: string): Promise<string> {
  return realpath(path);
}

/** The anchors `hashesFor` assigns to `content` at `path`'s canonical identity. */
async function expectedAnchors(path: string, content: string): Promise<string[]> {
  return lineHashes(content, await canonical(path));
}

function servedHashes(result: { content: Array<{ text?: string }> }): string[] {
  return anchorRows(getText(result)).map((row) => row.split("│")[0]!);
}

async function rows<T>(sql: string, ...params: (string | number)[]): Promise<T[]> {
  const store = await loadHashStore();
  return store.db.prepare(sql).all(...params) as unknown as T[];
}

async function snapshotRows(path: string): Promise<SnapshotRow[]> {
  return rows<SnapshotRow>(
    "SELECT snapshot_id, snapshot_hash, line_count, stat_key FROM file_snapshots WHERE path = ?",
    await canonical(path),
  );
}

describe("stat-identity snapshot adoption (ADR-0043)", () => {
  it("serves an unchanged re-read from the committed snapshot and stamps its stat identity", async () => {
    await withTempFile("stat-stable.txt", CONTENT_A, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const canonicalPath = await canonical(path);

      const first = await readTool.execute(
        "r0",
        { file: "stat-stable.txt" },
        undefined,
        undefined,
        ctx,
      );
      const second = await readTool.execute(
        "r1",
        { file: "stat-stable.txt" },
        undefined,
        undefined,
        ctx,
      );

      // Same bytes, same anchors, same epoch: the second read is the first read's file version.
      expect(getText(second)).toBe(getText(first));
      expect((second.details as { snapshotId?: string }).snapshotId).toBe(
        (first.details as { snapshotId?: string }).snapshotId,
      );

      const [row] = await snapshotRows(path);
      expect(row?.snapshot_hash).toBe(snapshotHashFor(CONTENT_A));
      expect(row?.stat_key).toBe(statKeyOf(await stat(canonicalPath)));

      // The stat lookup names the committed snapshot, and the epoch it reports is the one
      // `fileSnap` would produce — no content re-hash on the adoption path.
      const store = await loadHashStore();
      const matched = await findStatSnapshotFor(canonicalPath, row!.stat_key!);
      expect(matched?.snapshotHash).toBe(snapshotHashFor(CONTENT_A));
      expect(matched?.lineCount).toBe(4);
      const prepared = await prepareFile(path, cwd, {
        store,
        noPersist: true,
        render: "served",
        offset: 1,
        limit: 2,
      });
      expect(prepared.statAdoption).toEqual({
        snapshotHash: snapshotHashFor(CONTENT_A),
        snapshotId: (await fileSnap(path, contentChecksum(CONTENT_A))).snapshotId,
      });
    });
  });

  it("resolves only the served page's anchors, never the whole file's identity", async () => {
    const lines = Array.from({ length: 6000 }, (_, index) => `line ${index} of the fixture`);
    await withTempFile("stat-page.txt", lines.join("\n") + "\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute(
        "r0",
        { file: "stat-page.txt", offset: 1, limit: 5 },
        undefined,
        undefined,
        ctx,
      );

      const store = await loadHashStore();
      const prepared = await prepareFile(path, cwd, {
        store,
        noPersist: true,
        render: "served",
        offset: 10,
        limit: 20,
      });

      expect(prepared.lineTotals.split).toBe(6000);
      expect(prepared.statAdoption).toBeDefined();
      // WHY: 20 anchors for the page, not 6001 for the file — the walk this ticket removes.
      expect(prepared.fileHashes).toHaveLength(20);
      expect(prepared.served).toHaveLength(20);
      expect(prepared.fileHashes).toEqual(
        (await expectedAnchors(path, lines.join("\n") + "\n")).slice(9, 29),
      );
    });
  });

  it("detects a same-size, same-mtime content change through the fallback", async () => {
    await withTempFile("stat-lying.txt", CONTENT_A, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const canonicalPath = await canonical(path);
      const before = await stat(canonicalPath);

      const first = await readTool.execute(
        "r0",
        { file: "stat-lying.txt" },
        undefined,
        undefined,
        ctx,
      );
      const anchorsA = servedHashes(first);
      expect(anchorsA).toEqual(await expectedAnchors(path, CONTENT_A));

      // Rewrite with the same size and the same mtime: only ctime moved, so a stat lookup would miss.
      // Forge the missing increment (the coarse-timestamp filesystem this test stands in for) by
      // stamping the OLD snapshot with the file's CURRENT identity. Now the stat key matches a
      // snapshot the bytes no longer agree with — the canon check is the only thing left.
      await writeFile(path, CONTENT_B, "utf-8");
      await utimes(canonicalPath, before.atime, before.mtime);
      const lyingKey = statKeyOf(await stat(canonicalPath));
      const store = await loadHashStore();
      store.db
        .prepare("UPDATE file_snapshots SET stat_key = ? WHERE path = ? AND snapshot_hash = ?")
        .run(lyingKey, canonicalPath, snapshotHashFor(CONTENT_A));

      const second = await readTool.execute(
        "r1",
        { file: "stat-lying.txt" },
        undefined,
        undefined,
        ctx,
      );
      const anchorsB = servedHashes(second);
      expect(anchorsB).toEqual(await expectedAnchors(path, CONTENT_B));
      expect(anchorsB).not.toEqual(anchorsA);
      expect(getText(second)).toContain("alphA");

      // The fallback materialized B and stamped the identity it observed, so the next read is fast.
      const rowB = (await snapshotRows(path)).find(
        (row) => row.snapshot_hash === snapshotHashFor(CONTENT_B),
      );
      expect(rowB?.stat_key).toBe(lyingKey);
      expect((await findStatSnapshotFor(canonicalPath, lyingKey))?.snapshotHash).toBe(
        snapshotHashFor(CONTENT_B),
      );
    });
  });

  it("falls back on touch-without-content-change and re-stamps the new identity", async () => {
    await withTempFile("stat-touch.txt", CONTENT_A, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const canonicalPath = await canonical(path);

      const first = await readTool.execute(
        "r0",
        { file: "stat-touch.txt" },
        undefined,
        undefined,
        ctx,
      );
      const [before] = await snapshotRows(path);
      await utimes(canonicalPath, new Date(), new Date(Date.now() + 5_000));
      const touchedKey = statKeyOf(await stat(canonicalPath));

      // The old identity no longer names this file version: the stat path cannot adopt.
      expect(touchedKey).not.toBe(before?.stat_key);
      expect(await findStatSnapshotFor(canonicalPath, touchedKey)).toBeUndefined();

      const second = await readTool.execute(
        "r1",
        { file: "stat-touch.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(second)).toBe(getText(first));
      expect(servedHashes(second)).toEqual(await expectedAnchors(path, CONTENT_A));

      // Content-hash adoption stamped the observed version; the next read takes the stat path.
      const store = await loadHashStore();
      expect((await snapshotRows(path))[0]?.stat_key).toBe(touchedKey);
      const prepared = await prepareFile(path, cwd, {
        store,
        noPersist: true,
        render: "served",
      });
      expect(prepared.statAdoption?.snapshotHash).toBe(snapshotHashFor(CONTENT_A));
    });
  });

  it("falls back on an atomic rename and adopts the new inode's content", async () => {
    await withTempFile("stat-rename.txt", CONTENT_A, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const canonicalPath = await canonical(path);

      await readTool.execute("r0", { file: "stat-rename.txt" }, undefined, undefined, ctx);
      const [before] = await snapshotRows(path);

      const replacement = join(cwd, "stat-rename.next");
      await writeFile(replacement, CONTENT_B, "utf-8");
      await rename(replacement, canonicalPath);
      const replacedKey = statKeyOf(await stat(canonicalPath));
      expect(replacedKey.split(":")[0]).not.toBe(before?.stat_key?.split(":")[0]);
      expect(await findStatSnapshotFor(canonicalPath, replacedKey)).toBeUndefined();

      const second = await readTool.execute(
        "r1",
        { file: "stat-rename.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(servedHashes(second)).toEqual(await expectedAnchors(path, CONTENT_B));
      expect(getText(second)).toContain("charliE");

      const adopted = (await snapshotRows(path)).find(
        (row) => row.snapshot_hash === snapshotHashFor(CONTENT_B),
      );
      expect(adopted?.stat_key).toBe(replacedKey);
      expect((await findStatSnapshotFor(canonicalPath, replacedKey))?.snapshotHash).toBe(
        snapshotHashFor(CONTENT_B),
      );
    });
  });

  it("keeps edit resolution working across a stat adoption", async () => {
    await withTempFile("stat-edit.txt", CONTENT_A, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await readTool.execute("r0", { file: "stat-edit.txt" }, undefined, undefined, ctx);
      const read = await readTool.execute(
        "r1",
        { file: "stat-edit.txt" },
        undefined,
        undefined,
        ctx,
      );
      const anchors = servedHashes(read);
      const edited = await editTool.execute(
        "e0",
        {
          file: "stat-edit.txt",
          edits: [{ anchor_from: anchors[1], anchor_to: anchors[1], text: "BRAVO" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(edited)).toContain("BRAVO");
    });
  });

  it("renders the empty file's marker from the adopted snapshot", async () => {
    await withTempFile("stat-empty.txt", "", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const first = await readTool.execute(
        "r0",
        { file: "stat-empty.txt" },
        undefined,
        undefined,
        ctx,
      );
      const second = await readTool.execute(
        "r1",
        { file: "stat-empty.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(second)).toBe(getText(first));
      expect(getText(second)).toContain("empty");

      const store = await loadHashStore();
      const prepared = await prepareFile(path, cwd, {
        store,
        noPersist: true,
        render: "served",
      });
      expect(prepared.statAdoption?.snapshotHash).toBe(snapshotHashFor(""));
      expect(prepared.lineTotals.split).toBe(1);
    });
  });

  it("slices a multi-window page from the adopted snapshot", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `window line ${index}`);
    await withTempFile("stat-windows.txt", lines.join("\n") + "\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const windows = [
        { offset: 2, limit: 3 },
        { offset: 12, limit: 4 },
        { offset: 19, limit: 5 },
      ];
      const first = await readTool.execute(
        "r0",
        { file: "stat-windows.txt", windows },
        undefined,
        undefined,
        ctx,
      );
      const second = await readTool.execute(
        "r1",
        { file: "stat-windows.txt", windows },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(second)).toBe(getText(first));

      const store = await loadHashStore();
      const prepared = await prepareFile(path, cwd, {
        store,
        noPersist: true,
        render: "served",
        windows,
      });
      expect(prepared.statAdoption).toBeDefined();
      const all = await expectedAnchors(path, lines.join("\n") + "\n");
      // Each window's served anchors are its own lines, sliced from the one page walk.
      expect(prepared.served.map((row) => row.hash)).toEqual([
        ...all.slice(1, 4),
        ...all.slice(11, 15),
        ...all.slice(18, 20),
      ]);
    });
  });
});
