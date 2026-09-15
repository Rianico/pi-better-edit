import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import { loadHashStore, type HashStore } from "../../src/hash-store";
import { snapshotHashFor } from "../../src/snapshot-store";
import { loadLeases, sessionKeyFor, type ServedLease } from "../../src/served-session/session";

const ORIGINAL = "first line\nsecond line\nthird line\n";
const EDITED = "first line\nsecond line edited\nthird line\n";

/** The `file_snapshots.snapshot_id` committed for `(path, snapshotHash)`, if any. */
function lineageCount(store: HashStore, path: string, snapshotHash: string): number {
  const row = store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM line_lineage ll " +
        "JOIN file_snapshots fs ON fs.snapshot_id = ll.snapshot_id " +
        "WHERE fs.path = ? AND fs.snapshot_hash = ?",
    )
    .get(path, snapshotHash) as { n: number };
  return row.n;
}

function nextCounter(store: HashStore, path: string): number | undefined {
  const row = store.db.prepare("SELECT next_id FROM line_id_counters WHERE path = ?").get(path) as
    | { next_id: number }
    | undefined;
  return row?.next_id;
}

/** Evicts the pinned restored snapshot, seeding the retention miss the vacuum can produce. */
function evictSnapshot(store: HashStore, path: string, snapshotHash: string): void {
  store.db
    .prepare(
      "DELETE FROM line_lineage WHERE snapshot_id IN " +
        "(SELECT snapshot_id FROM file_snapshots WHERE path = ? AND snapshot_hash = ?)",
    )
    .run(path, snapshotHash);
  store.db
    .prepare("DELETE FROM file_snapshots WHERE path = ? AND snapshot_hash = ?")
    .run(path, snapshotHash);
}

/**
 * Issue #107 (spec §3.1.2): the undo revert is ONE restore transaction. `writeAtomic` runs first
 * (the disk bytes are authoritative, §3.6.2), then a single `BEGIN IMMEDIATE` adopts the pinned
 * canonical snapshot, runs the authoritative retirement update and re-serves the restored lines.
 * A failure in the last step must therefore leave no partial state — and must never roll the file
 * back: the tool reports success with the deferred-synchronization warning.
 */
describe("undo_last_edit restore transaction atomicity", () => {
  it("rolls back adoption, retirement and re-serve together when the re-serve fails", async () => {
    await withTempFile("undo_atomicity.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool, editTool, undoTool } = setupIntegrationTest(cwd);

      const r1 = await readTool.execute(
        "r1",
        { path: "undo_atomicity.txt" },
        undefined,
        undefined,
        ctx,
      );
      const readLines = getText(r1).split("\n");
      const line1Hash = extractHash(readLines[0]!);
      const line2Hash = extractHash(readLines[1]!);

      await editTool.execute(
        "e1",
        { path: "undo_atomicity.txt", edits: [[line2Hash, line2Hash, "second line edited"]] },
        undefined,
        undefined,
        ctx,
      );

      const store = await loadHashStore();
      const sessionKey = sessionKeyFor(ctx);
      const pinnedHash = snapshotHashFor(ORIGINAL);
      const editedHash = snapshotHashFor(EDITED);

      const beforeUndo: ServedLease[] = loadLeases(store, sessionKey, path);
      // The edit's serve bound the untouched line 1 to the EDITED snapshot.
      expect(beforeUndo.find((lease) => lease.anchor === line1Hash)!.served_snapshot_hash).toBe(
        editedHash,
      );
      const editedAnchor = beforeUndo.find(
        (lease) => lease.served_line_number === 2 && lease.anchor !== line2Hash,
      )!.anchor;

      // Seed the retention miss so the adoption's lineage / counter writes are observable.
      evictSnapshot(store, path, pinnedHash);
      const counterBefore = nextCounter(store, path);

      // Induce a failure in the LAST step of the restore transaction: the restored-line re-serve.
      store.db.exec(
        "CREATE TRIGGER undo_atomicity_fail BEFORE INSERT ON served_leases " +
          "BEGIN SELECT RAISE(ABORT, 'induced re-serve failure'); END",
      );
      let text = "";
      let warnings: string[] | undefined;
      try {
        const undone = await undoTool.execute(
          "u1",
          { path: "undo_atomicity.txt" },
          undefined,
          undefined,
          ctx,
        );
        text = getText(undone);
        warnings = (undone.details as { warnings?: string[] } | undefined)?.warnings;
      } finally {
        store.db.exec("DROP TRIGGER undo_atomicity_fail");
      }

      // §3.6.2: the bytes are already on disk, so the tool reports success + deferred store sync.
      expect(text).toContain("Undone last edit");
      expect(text).toContain("Store synchronization deferred");
      expect(warnings?.some((w) => w.includes("Store synchronization deferred"))).toBe(true);
      expect(await readFile(path, "utf-8")).toBe(ORIGINAL);

      // No adopted lineage without leases: the pinned snapshot the restore committed was rolled back.
      expect(lineageCount(store, path, pinnedHash)).toBe(0);
      // …and the id block the adoption allocated for the restored lines did not leak.
      expect(nextCounter(store, path)).toBe(counterBefore);

      const afterUndo = loadLeases(store, sessionKey, path);
      // No lease rows without the retirement update: the re-serve rolled back with it, so line 1
      // still holds the lease the edit's serve gave it.
      expect(afterUndo.find((lease) => lease.anchor === line1Hash)!.served_snapshot_hash).toBe(
        editedHash,
      );
      // …and the retirement update did not commit either: the removed line's lease is still live.
      expect(afterUndo.find((lease) => lease.anchor === editedAnchor)!.retired_at).toBeNull();
    });
  });
});
