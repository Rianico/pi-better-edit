import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import { loadHashStore, type HashStore } from "../../src/hash-store";
import { snapshotHashFor } from "../../src/snapshot-store";
import { loadLeases, sessionKeyFor, type ServedLease } from "../../src/served-session/session";

const ORIGINAL = "first line\nsecond line\nthird line\n";

function nextCounter(store: HashStore, path: string): number | undefined {
  const row = store.db.prepare("SELECT next_id FROM line_id_counters WHERE path = ?").get(path) as
    | { next_id: number }
    | undefined;
  return row?.next_id;
}

function lineageAnchors(store: HashStore, path: string, snapshotHash: string): string[] {
  const rows = store.db
    .prepare(
      "SELECT ll.anchor AS anchor FROM line_lineage ll " +
        "JOIN file_snapshots fs ON fs.snapshot_id = ll.snapshot_id " +
        "WHERE fs.path = ? AND fs.snapshot_hash = ?",
    )
    .all(path, snapshotHash) as unknown as { anchor: string }[];
  return rows.map((row) => row.anchor);
}

/**
 * Regression for the undo revert serve seam (issue #82, spec §3.1.2 / §7.2.9): `undo_last_edit`
 * restores content whose `file_snapshots` row is a CACHE HIT pinned by `file_undo.snapshot_hash`.
 * The revert must therefore adopt the canonical snapshot (zero `line_id_counters` allocations),
 * retire the leases of lines the edit introduced, and re-serve the restored anchors with
 * `retired_at = NULL` / `served_snapshot_hash` bound to the pinned hash — otherwise the model
 * must burn a `read` before it can edit again.
 */
describe("undo_last_edit adopts the pinned canonical snapshot", () => {
  it("re-serves restored leases with zero counter allocations and retires lines the revert removed", async () => {
    await withTempFile("undo_lease.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool, editTool, undoTool } = setupIntegrationTest(cwd);

      const r1 = await readTool.execute(
        "r1",
        { path: "undo_lease.txt" },
        undefined,
        undefined,
        ctx,
      );
      const line2Hash = extractHash(getText(r1).split("\n")[1]!);

      await editTool.execute(
        "e1",
        { path: "undo_lease.txt", edits: [[line2Hash, line2Hash, "second line edited"]] },
        undefined,
        undefined,
        ctx,
      );

      const store = await loadHashStore();
      const sessionKey = sessionKeyFor(ctx);
      const counterAfterEdit = nextCounter(store, path);
      const editedAnchor = loadLeases(store, sessionKey, path).find(
        (lease) => lease.served_line_number === 2 && lease.anchor !== line2Hash,
      )!.anchor;

      await undoTool.execute("u1", { path: "undo_lease.txt" }, undefined, undefined, ctx);

      expect(await readFile(path, "utf-8")).toBe(ORIGINAL);

      // The pinned snapshot is a cache hit: the counter must not have moved (zero allocations).
      expect(nextCounter(store, path)).toBe(counterAfterEdit);

      const pinned = snapshotHashFor(ORIGINAL);
      const leases = loadLeases(store, sessionKey, path);
      const restored = leases.find((lease) => lease.anchor === line2Hash);
      expect(restored).toBeDefined();
      expect(restored!.retired_at).toBeNull();
      expect(restored!.served_snapshot_hash).toBe(pinned);

      // The authoritative writer retired the lease of the line the revert removed.
      const removed = leases.find((lease) => lease.anchor === editedAnchor);
      expect(removed).toBeDefined();
      expect(removed!.retired_at).not.toBeNull();

      // No active lease may reference a line absent from the adopted lineage.
      const anchors = lineageAnchors(store, path, pinned);
      const active: ServedLease[] = leases.filter((lease) => lease.retired_at === null);
      for (const lease of active) expect(anchors).toContain(lease.anchor);
    });
  });
});
