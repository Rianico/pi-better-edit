import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, anchorRows } from "../support/fixtures";
import { loadHashStore } from "../../src/hash-store";
import { snapshotHashFor } from "../../src/snapshot-store";

const CONTENT_B = "alpha\nbravo\ncharlie\n";
const CONTENT_A = "alpha\nbravo\n";

interface LeaseRow {
  anchor: string;
  retired_at: number | null;
}

/**
 * Regression for the read-path materialization seam (spec §3.1.3 authoritative `retired_at`
 * writer): a full read of content the session had already materialized is a `file_snapshots`
 * CACHE HIT, so `hashesFor` used to return without ever running the retirement update. Reverting
 * the file to an older snapshot then left leases from the newer version active forever — the
 * lease table kept claiming identity the session no longer held and re-opened the fail-closed
 * retry loop §3.1.2 exists to break.
 */
describe("read-path materialization retires absent leases on a snapshot cache hit", () => {
  it("retires leases whose anchor is absent from the re-read (reverted) snapshot", async () => {
    await withTempFile("revert.txt", CONTENT_A, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);

      await readTool.execute("r0", { file: "revert.txt" }, undefined, undefined, ctx);
      await writeFile(path, CONTENT_B, "utf-8");
      const readB = await readTool.execute("r1", { file: "revert.txt" }, undefined, undefined, ctx);
      const hashB = anchorRows(readB.content[0]!.text)[2]!.split("│")[0]!;

      const store = await loadHashStore();
      const rows = <T>(sql: string, ...params: (string | number)[]): T[] =>
        store.db.prepare(sql).all(...params) as unknown as T[];
      const activeSql =
        "SELECT anchor, retired_at FROM served_leases " +
        "WHERE file_path = ? AND retired_at IS NULL";

      expect(rows<LeaseRow>(activeSql, path).some((lease) => lease.anchor === hashB)).toBe(true);

      await writeFile(path, CONTENT_A, "utf-8");
      await readTool.execute("r2", { file: "revert.txt" }, undefined, undefined, ctx);

      const anchorsA = rows<{ anchor: string }>(
        "SELECT ll.anchor AS anchor FROM line_lineage ll " +
          "JOIN file_snapshots fs ON fs.snapshot_id = ll.snapshot_id " +
          "WHERE fs.path = ? AND fs.snapshot_hash = ?",
        path,
        snapshotHashFor(CONTENT_A),
      ).map((row) => row.anchor);
      expect(anchorsA).toHaveLength(2);

      const active = rows<LeaseRow>(activeSql, path);
      for (const lease of active) expect(anchorsA).toContain(lease.anchor);
      expect(active.some((lease) => lease.anchor === hashB)).toBe(false);
    });
  });
});
