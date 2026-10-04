import { describe, expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import { loadHashStore, type HashStore } from "../../src/hash-store";
import { snapshotHashFor } from "../../src/snapshot-store";
import { loadLeases, sessionKeyFor, type ServedLease } from "../../src/served-session/session";

// WHY: CAND-3 requirement (c): one scenario needs `writeAtomic` itself to fail mid-undo so the
// store-mutation ordering is observable. The gate passes every other call through to the real
// implementation (the read/edit setup in the same file must keep writing normally).
const writeAtomicGate = vi.hoisted(() => ({ failNext: false }));
vi.mock("../../src/fs-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/fs-write.js")>();
  const originalWriteAtomic = actual.writeAtomic;
  return {
    ...actual,
    async writeAtomic(path: string, content: string): Promise<void> {
      if (writeAtomicGate.failNext) {
        writeAtomicGate.failNext = false;
        throw new Error("induced write failure");
      }
      return originalWriteAtomic(path, content);
    },
  };
});

/**
 * CAND-3: the post-write commit is ONE transaction on the edit path and the undo path —
 * snapshot + lineage + retirement + lease grant + served mirror all share the same
 * `BEGIN IMMEDIATE`. Torn store states (lease-without-mirror, mirror-without-lease) become
 * structurally unreachable: a mid-commit failure rolls everything back and the single
 * DEFERRED_STORE_SYNC_WARNING reports the deferred synchronization. On undo, all store
 * mutations additionally run AFTER `writeAtomic` (#117 discipline).
 */

const ORIGINAL = "alpha\nbravo\ncharlie\n";
const EDITED = "alpha\nbravo edited\ncharlie\n";

/** The raw served-mirror JSON for one (session, path), read directly from the `served` table. */
function mirrorHashes(store: HashStore, sessionKey: string, path: string): string | undefined {
  const row = store.db
    .prepare("SELECT hashes FROM served WHERE session_id = ? AND path = ?")
    .get(sessionKey, path) as { hashes: string } | undefined;
  return row?.hashes;
}

/** The legacy retired-set JSON for one (session, path), read directly from the `served` table. */
function mirrorRetired(store: HashStore, sessionKey: string, path: string): string | null {
  const row = store.db
    .prepare("SELECT retired FROM served WHERE session_id = ? AND path = ?")
    .get(sessionKey, path) as { retired: string | null } | undefined;
  return row?.retired ?? null;
}

function snapshotExists(store: HashStore, path: string, content: string): boolean {
  const row = store.db
    .prepare(
      "SELECT snapshot_id FROM file_snapshots WHERE path = ? AND snapshot_hash = ? AND committed = 1",
    )
    .get(path, snapshotHashFor(content)) as { snapshot_id: number } | undefined;
  return row !== undefined;
}

function leasesForSnapshot(
  store: HashStore,
  sessionKey: string,
  path: string,
  content: string,
): ServedLease[] {
  return loadLeases(store, sessionKey, path).filter(
    (lease) => lease.served_snapshot_hash === snapshotHashFor(content),
  );
}

describe("CAND-3 unified post-write commit transaction", () => {
  it("edit: a mirror-write failure leaves no leases without their mirror rows", async () => {
    await withTempFile("cand3_edit_mirror_fail.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { file: "cand3_edit_mirror_fail.txt" },
        undefined,
        undefined,
        ctx,
      );
      const bravoHash = extractHash(getText(r1).split("\n")[1]!);

      const store = await loadHashStore();
      const mirrorBefore = mirrorHashes(store, sessionKeyFor(ctx), path);
      expect(mirrorBefore).toBeDefined();

      store.db.exec(
        "CREATE TRIGGER cand3_edit_mirror_fail BEFORE UPDATE OF hashes ON served " +
          "BEGIN SELECT RAISE(ABORT, 'induced mirror failure'); END",
      );
      let text = "";
      try {
        const res = await editTool.execute(
          "e1",
          {
            file: "cand3_edit_mirror_fail.txt",
            edits: [{ anchor_from: bravoHash, anchor_to: bravoHash, text: "bravo edited" }],
          },
          undefined,
          undefined,
          ctx,
        );
        text = getText(res as { content: Array<{ text?: string }> });
      } finally {
        store.db.exec("DROP TRIGGER cand3_edit_mirror_fail");
      }

      // The bytes are on disk (§3.6.2): success + the ONE deferred-sync warning, never a rollback.
      expect(await readFile(path, "utf-8")).toBe(EDITED);
      expect(text).toContain("Successfully edited");
      expect(text).toContain("Store synchronization deferred");
      // Requirement (a): no `served_leases` rows for the new snapshot while the mirror lacks
      // them — both queried directly, and the reverse (snapshot/lineage without the mirror too).
      expect(leasesForSnapshot(store, sessionKeyFor(ctx), path, EDITED)).toEqual([]);
      expect(mirrorHashes(store, sessionKeyFor(ctx), path)).toBe(mirrorBefore);
      expect(snapshotExists(store, path, EDITED)).toBe(false);
    });
  });

  it("edit: a lease-grant failure leaves no mirror rows without their leases", async () => {
    await withTempFile("cand3_edit_lease_fail.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { file: "cand3_edit_lease_fail.txt" },
        undefined,
        undefined,
        ctx,
      );
      const bravoHash = extractHash(getText(r1).split("\n")[1]!);

      const store = await loadHashStore();
      const mirrorBefore = mirrorHashes(store, sessionKeyFor(ctx), path);
      expect(mirrorBefore).toBeDefined();

      store.db.exec(
        "CREATE TRIGGER cand3_edit_lease_fail BEFORE INSERT ON served_leases " +
          "BEGIN SELECT RAISE(ABORT, 'induced lease failure'); END",
      );
      let text = "";
      try {
        const res = await editTool.execute(
          "e1",
          {
            file: "cand3_edit_lease_fail.txt",
            edits: [{ anchor_from: bravoHash, anchor_to: bravoHash, text: "bravo edited" }],
          },
          undefined,
          undefined,
          ctx,
        );
        text = getText(res as { content: Array<{ text?: string }> });
      } finally {
        store.db.exec("DROP TRIGGER cand3_edit_lease_fail");
      }

      expect(await readFile(path, "utf-8")).toBe(EDITED);
      expect(text).toContain("Store synchronization deferred");
      // The reverse torn state: the grant failed INSIDE the transaction, so the mirror write
      // rolled back with it — no dense serve rows without leases (pre-CAND-3, `recordDiff`
      // committed the mirror in a separate transaction anyway).
      expect(mirrorHashes(store, sessionKeyFor(ctx), path)).toBe(mirrorBefore);
      expect(leasesForSnapshot(store, sessionKeyFor(ctx), path, EDITED)).toEqual([]);
    });
  });

  it("undo: a mirror-write failure leaves no leases without their mirror rows", async () => {
    await withTempFile("cand3_undo_mirror_fail.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool, editTool, undoTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { file: "cand3_undo_mirror_fail.txt" },
        undefined,
        undefined,
        ctx,
      );
      const bravoHash = extractHash(getText(r1).split("\n")[1]!);
      await editTool.execute(
        "e1",
        {
          file: "cand3_undo_mirror_fail.txt",
          edits: [{ anchor_from: bravoHash, anchor_to: bravoHash, text: "bravo edited" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const store = await loadHashStore();
      const sessionKey = sessionKeyFor(ctx);
      const mirrorBefore = mirrorHashes(store, sessionKey, path);
      const retiredBefore = mirrorRetired(store, sessionKey, path);
      const editedAnchor = loadLeases(store, sessionKey, path).find(
        (lease) => lease.served_line_number === 2 && lease.anchor !== bravoHash,
      )!.anchor;

      store.db.exec(
        "CREATE TRIGGER cand3_undo_mirror_fail BEFORE UPDATE OF hashes ON served " +
          "BEGIN SELECT RAISE(ABORT, 'induced mirror failure'); END",
      );
      let text = "";
      let warnings: string[] | undefined;
      try {
        const undone = await undoTool.execute(
          "u1",
          { path: "cand3_undo_mirror_fail.txt" },
          undefined,
          undefined,
          ctx,
        );
        text = getText(undone);
        warnings = (undone.details as { warnings?: string[] } | undefined)?.warnings;
      } finally {
        store.db.exec("DROP TRIGGER cand3_undo_mirror_fail");
      }

      // Bytes restored, tool reports success with the deferred-sync warning (§3.6.2).
      expect(await readFile(path, "utf-8")).toBe(ORIGINAL);
      expect(text).toContain("Undone last edit");
      expect(text).toContain("Store synchronization deferred");
      expect(warnings?.some((w) => w.includes("Store synchronization deferred"))).toBe(true);
      // Requirement (b): the adopt + retirement + displaced retire rolled back with the mirror —
      // the restored snapshot has no LIVE leases while its mirror rows are missing. (Retired rows
      // from the earlier read/edit legitimately pre-exist; the failed adopt must not revive them.)
      const originalLeases = leasesForSnapshot(store, sessionKey, path, ORIGINAL);
      expect(originalLeases.filter((lease) => lease.retired_at === null)).toEqual([]);
      expect(originalLeases.length).toBeGreaterThan(0);
      expect(mirrorHashes(store, sessionKey, path)).toBe(mirrorBefore);
      // The in-transaction retirement rolled back too: the edited line's lease is still live.
      const stillLive = loadLeases(store, sessionKey, path).find(
        (lease) => lease.anchor === editedAnchor,
      );
      expect(stillLive?.retired_at).toBeNull();
      // The displaced-anchor retire rode the same transaction: the legacy set is unchanged.
      expect(mirrorRetired(store, sessionKey, path)).toBe(retiredBefore);
    });
  });

  it("undo: a writeAtomic failure performs no store mutation at all", async () => {
    await withTempFile("cand3_undo_ordering.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool, editTool, undoTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { file: "cand3_undo_ordering.txt" },
        undefined,
        undefined,
        ctx,
      );
      const bravoHash = extractHash(getText(r1).split("\n")[1]!);
      await editTool.execute(
        "e1",
        {
          file: "cand3_undo_ordering.txt",
          edits: [{ anchor_from: bravoHash, anchor_to: bravoHash, text: "bravo edited" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const store = await loadHashStore();
      const sessionKey = sessionKeyFor(ctx);
      const leasesBefore = loadLeases(store, sessionKey, path);
      const mirrorBefore = mirrorHashes(store, sessionKey, path);
      const retiredBefore = mirrorRetired(store, sessionKey, path);
      const snapshotCountBefore = (
        store.db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }
      ).n;

      // Requirement (c): fail the write itself — an uncommitted restore must leave the store
      // untouched. Pre-CAND-3, the displaced-anchor retire ran BEFORE `writeAtomic` and had
      // already rewritten `served.retired` when the write failed.
      writeAtomicGate.failNext = true;
      await expect(
        undoTool.execute("u1", { path: "cand3_undo_ordering.txt" }, undefined, undefined, ctx),
      ).rejects.toThrow(/induced write failure/);
      expect(writeAtomicGate.failNext).toBe(false);

      expect(await readFile(path, "utf-8")).toBe(EDITED);
      expect(loadLeases(store, sessionKey, path)).toEqual(leasesBefore);
      expect(mirrorHashes(store, sessionKey, path)).toBe(mirrorBefore);
      expect(mirrorRetired(store, sessionKey, path)).toBe(retiredBefore);
      const snapshotCountAfter = (
        store.db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }
      ).n;
      expect(snapshotCountAfter).toBe(snapshotCountBefore);
    });
  });

  it("undo: the deferred-sync wording never claims fresh anchors; the success path keeps them", async () => {
    await withTempFile("cand3_undo_text.txt", ORIGINAL, async ({ cwd }) => {
      const { ctx, readTool, editTool, undoTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { file: "cand3_undo_text.txt" },
        undefined,
        undefined,
        ctx,
      );
      const bravoHash = extractHash(getText(r1).split("\n")[1]!);
      await editTool.execute(
        "e1",
        {
          file: "cand3_undo_text.txt",
          edits: [{ anchor_from: bravoHash, anchor_to: bravoHash, text: "bravo edited" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const store = await loadHashStore();
      store.db.exec(
        "CREATE TRIGGER cand3_undo_text_fail BEFORE UPDATE OF hashes ON served " +
          "BEGIN SELECT RAISE(ABORT, 'induced mirror failure'); END",
      );
      let text = "";
      try {
        const failed = await undoTool.execute(
          "u1",
          { path: "cand3_undo_text.txt" },
          undefined,
          undefined,
          ctx,
        );
        text = getText(failed);
      } finally {
        store.db.exec("DROP TRIGGER cand3_undo_text_fail");
      }

      // Requirement (d): the failure case names the warning instead of overstating the serve.
      expect(text).toContain("Store synchronization deferred");
      expect(text).not.toContain("carry fresh anchors");
      expect(text).toContain("not anchored for follow-up edits");
    });
  });

  it("undo: the unified commit leaves leases, mirror and snapshot consistent on success", async () => {
    await withTempFile("cand3_undo_success.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool, editTool, undoTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { file: "cand3_undo_success.txt" },
        undefined,
        undefined,
        ctx,
      );
      const bravoHash = extractHash(getText(r1).split("\n")[1]!);
      await editTool.execute(
        "e1",
        {
          file: "cand3_undo_success.txt",
          edits: [{ anchor_from: bravoHash, anchor_to: bravoHash, text: "bravo edited" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const undone = await undoTool.execute(
        "u1",
        { path: "cand3_undo_success.txt" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(undone);

      // Success-path wording is byte-identical to the pre-CAND-3 claim.
      expect(text).toContain("File reverted; diff rows carry fresh anchors for follow-up edits.");
      expect(text).not.toContain("Store synchronization deferred");
      expect(await readFile(path, "utf-8")).toBe(ORIGINAL);

      // The one transaction wrote leases AND mirror: every live restored lease's anchor appears
      // in the mirror at its served position (the shape the old two-transaction pair produced).
      const store = await loadHashStore();
      const sessionKey = sessionKeyFor(ctx);
      const mirror = JSON.parse(mirrorHashes(store, sessionKey, path) ?? "[]") as (string | null)[];
      const restored = leasesForSnapshot(store, sessionKey, path, ORIGINAL);
      expect(restored.length).toBe(3);
      for (const lease of restored) {
        expect(mirror[lease.served_line_number - 1]).toBe(lease.anchor);
      }
    });
  });
});
