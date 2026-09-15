import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import { loadHashStore, type HashStore } from "../../src/hash-store";
import { snapshotHashFor } from "../../src/snapshot-store";
import { loadLeases, sessionKeyFor, type ServedLease } from "../../src/served-session/session";

const ORIGINAL = "alpha\nbravo\ncharlie\n";
const EDITED = "alpha\nbravo edited\ncharlie\n";

function snapshotExists(store: HashStore, path: string, content: string): boolean {
  const row = store.db
    .prepare(
      "SELECT snapshot_id FROM file_snapshots WHERE path = ? AND snapshot_hash = ? AND committed = 1",
    )
    .get(path, snapshotHashFor(content)) as { snapshot_id: number } | undefined;
  return row !== undefined;
}

function lineageCount(store: HashStore, path: string, content: string): number {
  const row = store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM line_lineage ll " +
        "JOIN file_snapshots fs ON fs.snapshot_id = ll.snapshot_id " +
        "WHERE fs.path = ? AND fs.snapshot_hash = ?",
    )
    .get(path, snapshotHashFor(content)) as { n: number };
  return row.n;
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

/**
 * Issue #116 (spec §3.1.2 steps 4-6, §3.2.4 step 4): the served-lease upsert is step 5 of the
 * materialization transaction — snapshot + lineage + retirement + leases commit or roll back as
 * one `BEGIN IMMEDIATE` unit on the read path and the edit path. No third transaction remains.
 */
describe("lease grant inside the materialization transaction (#116)", () => {
  it("binds read-path leases to the committed snapshot with retired_at IS NULL", async () => {
    await withTempFile("lease_read.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const res = await readTool.execute(
        "r1",
        { path: "lease_read.txt" },
        undefined,
        undefined,
        ctx,
      );
      const shown = getText(res).split("\n").length;

      const store = await loadHashStore();
      const leases = leasesForSnapshot(store, sessionKeyFor(ctx), path, ORIGINAL);
      expect(leases.length).toBe(shown);
      for (const lease of leases) {
        expect(lease.retired_at).toBeNull();
      }
      expect(snapshotExists(store, path, ORIGINAL)).toBe(true);
    });
  });

  it("binds edit-path diff leases to the committed snapshot with retired_at IS NULL", async () => {
    await withTempFile("lease_edit.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { path: "lease_edit.txt" },
        undefined,
        undefined,
        ctx,
      );
      const bravoHash = extractHash(getText(r1).split("\n")[1]!);

      await editTool.execute(
        "e1",
        { path: "lease_edit.txt", edits: [[bravoHash, bravoHash, "bravo edited"]] },
        undefined,
        undefined,
        ctx,
      );

      const store = await loadHashStore();
      const leases = leasesForSnapshot(store, sessionKeyFor(ctx), path, EDITED);
      expect(leases.length).toBe(3);
      for (const lease of leases) {
        expect(lease.retired_at).toBeNull();
      }
      expect(lineageCount(store, path, EDITED)).toBe(3);
    });
  });

  it("read atomicity: a lease failure rolls back the snapshot and lineage with it", async () => {
    await withTempFile("lease_read_atomic.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const store = await loadHashStore();
      store.db.exec(
        "CREATE TRIGGER lease_read_atomic_fail BEFORE INSERT ON served_leases " +
          "BEGIN SELECT RAISE(ABORT, 'induced lease failure'); END",
      );
      try {
        await readTool.execute("r1", { path: "lease_read_atomic.txt" }, undefined, undefined, ctx);
      } finally {
        store.db.exec("DROP TRIGGER lease_read_atomic_fail");
      }

      // No snapshot/lineage without its leases.
      expect(snapshotExists(store, path, ORIGINAL)).toBe(false);
      expect(lineageCount(store, path, ORIGINAL)).toBe(0);
      // …and no leases without their lineage.
      expect(leasesForSnapshot(store, sessionKeyFor(ctx), path, ORIGINAL)).toEqual([]);
    });
  });

  it("edit atomicity: a lease failure leaves no snapshot without leases and reports deferred sync", async () => {
    await withTempFile("lease_edit_atomic.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { path: "lease_edit_atomic.txt" },
        undefined,
        undefined,
        ctx,
      );
      const bravoHash = extractHash(getText(r1).split("\n")[1]!);

      const store = await loadHashStore();
      store.db.exec(
        "CREATE TRIGGER lease_edit_atomic_fail BEFORE INSERT ON served_leases " +
          "BEGIN SELECT RAISE(ABORT, 'induced lease failure'); END",
      );
      let text = "";
      let warnings: string[] | undefined;
      try {
        const res = await editTool.execute(
          "e1",
          { path: "lease_edit_atomic.txt", edits: [[bravoHash, bravoHash, "bravo edited"]] },
          undefined,
          undefined,
          ctx,
        );
        text = getText(res);
        warnings = (res.details as { warnings?: string[] } | undefined)?.warnings;
      } finally {
        store.db.exec("DROP TRIGGER lease_edit_atomic_fail");
      }

      // §3.6.2: the bytes are already on disk — success plus deferred sync, never a file rollback.
      expect(text).toContain("Successfully edited");
      expect(text).toContain("Store synchronization deferred");
      expect(warnings?.some((w) => w.includes("Store synchronization deferred"))).toBe(true);
      expect(await readFile(path, "utf-8")).toBe(EDITED);

      // No snapshot/lineage without its leases …
      expect(snapshotExists(store, path, EDITED)).toBe(false);
      expect(lineageCount(store, path, EDITED)).toBe(0);
      // … and no leases without their lineage (the serve-mirror recording grants no leases).
      expect(leasesForSnapshot(store, sessionKeyFor(ctx), path, EDITED)).toEqual([]);
    });
  });

  it("lineage failure leaves no leases without their lineage", async () => {
    await withTempFile("lease_lineage_atomic.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const store = await loadHashStore();
      store.db.exec(
        "CREATE TRIGGER lease_lineage_atomic_fail BEFORE INSERT ON line_lineage " +
          "BEGIN SELECT RAISE(ABORT, 'induced lineage failure'); END",
      );
      try {
        await readTool.execute(
          "r1",
          { path: "lease_lineage_atomic.txt" },
          undefined,
          undefined,
          ctx,
        );
      } finally {
        store.db.exec("DROP TRIGGER lease_lineage_atomic_fail");
      }

      expect(leasesForSnapshot(store, sessionKeyFor(ctx), path, ORIGINAL)).toEqual([]);
      expect(snapshotExists(store, path, ORIGINAL)).toBe(false);
    });
  });

  it("read leases survive a serve-mirror failure: no third transaction on the read path", async () => {
    await withTempFile("lease_read_notx3.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const store = await loadHashStore();
      store.db.exec(
        "CREATE TRIGGER lease_read_notx3_fail BEFORE INSERT ON served " +
          "BEGIN SELECT RAISE(ABORT, 'induced mirror failure'); END",
      );
      let readPromise: Promise<unknown> | undefined;
      try {
        readPromise = readTool.execute(
          "r1",
          { path: "lease_read_notx3.txt" },
          undefined,
          undefined,
          ctx,
        );
        await expect(readPromise).rejects.toThrow(/induced mirror failure/);
      } finally {
        store.db.exec("DROP TRIGGER lease_read_notx3_fail");
      }

      // The leases committed with the snapshot — they were never in the mirror transaction.
      const leases = leasesForSnapshot(store, sessionKeyFor(ctx), path, ORIGINAL);
      expect(leases.length).toBe(3);
      for (const lease of leases) {
        expect(lease.retired_at).toBeNull();
      }
    });
  });

  it("edit leases survive a serve-mirror failure: no third transaction on the edit path", async () => {
    await withTempFile("lease_edit_notx3.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { path: "lease_edit_notx3.txt" },
        undefined,
        undefined,
        ctx,
      );
      const bravoHash = extractHash(getText(r1).split("\n")[1]!);

      const store = await loadHashStore();
      store.db.exec(
        "CREATE TRIGGER lease_edit_notx3_fail BEFORE INSERT ON served " +
          "BEGIN SELECT RAISE(ABORT, 'induced mirror failure'); END",
      );
      try {
        const res = await editTool.execute(
          "e1",
          { path: "lease_edit_notx3.txt", edits: [[bravoHash, bravoHash, "bravo edited"]] },
          undefined,
          undefined,
          ctx,
        );
        expect(getText(res)).toContain("Successfully edited");
      } finally {
        store.db.exec("DROP TRIGGER lease_edit_notx3_fail");
      }
      expect(await readFile(path, "utf-8")).toBe(EDITED);

      const leases = leasesForSnapshot(store, sessionKeyFor(ctx), path, EDITED);
      expect(leases.length).toBe(3);
      for (const lease of leases) {
        expect(lease.retired_at).toBeNull();
      }
    });
  });

  it("edit deferred sync: a post-write store failure keeps the bytes and recovers on re-read", async () => {
    await withTempFile("lease_deferred.txt", ORIGINAL, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { path: "lease_deferred.txt" },
        undefined,
        undefined,
        ctx,
      );
      const bravoHash = extractHash(getText(r1).split("\n")[1]!);

      const store = await loadHashStore();
      store.db.exec(
        "CREATE TRIGGER lease_deferred_fail BEFORE INSERT ON file_snapshots " +
          "BEGIN SELECT RAISE(ABORT, 'induced snapshot failure'); END",
      );
      let text = "";
      try {
        const res = await editTool.execute(
          "e1",
          { path: "lease_deferred.txt", edits: [[bravoHash, bravoHash, "bravo edited"]] },
          undefined,
          undefined,
          ctx,
        );
        text = getText(res);
      } finally {
        store.db.exec("DROP TRIGGER lease_deferred_fail");
      }

      // §3.6.2: success for the bytes on disk plus the deferred-sync warning — never a rollback.
      expect(text).toContain("Successfully edited");
      expect(text).toContain("Store synchronization deferred");
      expect(await readFile(path, "utf-8")).toBe(EDITED);

      // Recovery: a re-read re-materializes from disk and the next edit succeeds.
      const r2 = await readTool.execute(
        "r2",
        { path: "lease_deferred.txt" },
        undefined,
        undefined,
        ctx,
      );
      const bravoHash2 = extractHash(getText(r2).split("\n")[1]!);
      const res2 = await editTool.execute(
        "e2",
        { path: "lease_deferred.txt", edits: [[bravoHash2, bravoHash2, "bravo final"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(res2)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbravo final\ncharlie\n");
    });
  });
});
