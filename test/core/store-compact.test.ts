/**
 * #161 — reclaim store file space after the lease GC.
 *
 * The janitor's GC deletes rows; only a VACUUM gives the freed pages back to the filesystem. These
 * tests pin the scheduling contract (ADR-0046): compaction runs only on the maintenance boundary and
 * only when enough of the file is free to pay for the rewrite; a contended store defers instead of
 * stalling; a concurrent connection stays correct; and with nothing to reclaim no VACUUM is issued.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath, loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { runJanitor } from "../../src/store-janitor";
import { STORE_JANITOR_DEFAULTS, type StoreJanitorSettings } from "../../src/store-config";
import { SERVED_TTL_MS } from "../../src/constants";
import { ANCHOR_GENERATION, CANON_VERSION } from "../../src/hashline/hash-identity.js";
import { initHasher } from "../../src/hashline/hasher";
import { getWritableTempRoot } from "../support/fixtures";

beforeAll(async () => {
  await initHasher();
});

const NOW = 1_700_000_000_000;
const SETTINGS: StoreJanitorSettings = {
  mode: STORE_JANITOR_DEFAULTS.mode,
  intervalMs: 1,
  batchSize: 512,
};

async function withStoreDir(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), prefix));
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", dir);
  try {
    await run(dir);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}

function pragma(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Number(Object.values(row)[0]);
}

function fileBytes(db: DatabaseSync): number {
  return pragma(db, "page_count") * pragma(db, "page_size");
}

function freeBytes(db: DatabaseSync): number {
  return pragma(db, "freelist_count") * pragma(db, "page_size");
}

/** Seed one current-generation snapshot and `count` expired-active leases pinned to it. */
function seedExpiredLeases(db: DatabaseSync, count: number): void {
  const hash = `${CANON_VERSION}:${ANCHOR_GENERATION}:compact-fixture`;
  db.prepare(
    "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) " +
      "VALUES (?, ?, 1000, ?, 1, ?)",
  ).run("/compact.ts", hash, NOW, ANCHOR_GENERATION);
  const insert = db.prepare(
    "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, served_snapshot_hash, served_line_number, updated_at, retired_at) " +
      "VALUES ('s1', '/compact.ts', ?, ?, 'cafe', ?, ?, ?, NULL)",
  );
  db.exec("BEGIN");
  try {
    for (let index = 0; index < count; index++) {
      insert.run(
        `a${index.toString(36).padStart(5, "0")}`,
        index + 1,
        hash,
        index + 1,
        NOW - SERVED_TTL_MS - 1,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("compaction after the lease GC (ADR-0046)", () => {
  it("reclaims the free pages a GC pass leaves behind", async () => {
    await withStoreDir("pi-compact-after-gc-", async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedExpiredLeases(db, 30_000);
      const before = fileBytes(db);
      expect(freeBytes(db)).toBe(0);

      // Inject a 1-byte floor so a small fixture exercises the real VACUUM path; the ratio gate
      // still applies (the deleted leases dominate this file).
      const outcome = runJanitor({
        db,
        now: NOW,
        settings: SETTINGS,
        compactMinFreeBytes: 1,
      });

      expect(outcome.deleted.expiredLeases).toBe(30_000);
      expect(outcome.compacted.ran).toBe(true);
      expect(outcome.compacted.freeBytesBefore).toBeGreaterThan(0);
      expect(outcome.compacted.reclaimedBytes).toBeGreaterThan(0);
      expect(fileBytes(db)).toBeLessThan(before);
      expect(freeBytes(db)).toBe(0);
      // The store is intact and usable after the rewrite.
      expect((db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }).n).toBe(
        0,
      );
    });
  });

  it("issues no VACUUM when there is nothing to reclaim", async () => {
    await withStoreDir("pi-compact-noop-", async () => {
      const store = await loadHashStore();
      const db = store.db;
      const before = fileBytes(db);
      const statements: string[] = [];
      const proto = DatabaseSync.prototype as unknown as {
        exec: (sql: string) => unknown;
      };
      const originalExec = proto.exec;
      proto.exec = function patched(sql: string) {
        statements.push(sql);
        return originalExec.call(this, sql);
      };
      const outcome = (() => {
        try {
          return runJanitor({ db, now: NOW, settings: SETTINGS, compactMinFreeBytes: 0 });
        } finally {
          proto.exec = originalExec;
        }
      })();

      expect(outcome.compacted.ran).toBe(false);
      expect(outcome.compacted.reason).toBe("no-free-pages");
      expect(outcome.compacted.reclaimedBytes).toBe(0);
      expect(statements.some((sql) => /^\s*VACUUM\b/i.test(sql))).toBe(false);
      expect(fileBytes(db)).toBe(before);
    });
  });

  it("defers while a rival writer holds the store, then compacts after it commits", async () => {
    await withStoreDir("pi-compact-contended-", async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedExpiredLeases(db, 3_000);
      // Free the pages first, so the only remaining write is the janitor's own GC (which also has
      // to defer) and then the compaction.
      db.exec("DELETE FROM served_leases");
      expect(freeBytes(db)).toBeGreaterThan(0);

      const rival = new DatabaseSync(hashStorePath(), { timeout: 50 });
      try {
        rival.exec("BEGIN IMMEDIATE");
        rival.prepare("INSERT INTO meta (key, value) VALUES ('rival', '1')").run();

        const deferred = runJanitor({ db, now: NOW, settings: SETTINGS, compactMinFreeBytes: 0 });
        // The GC could not take the write lock, so the pass removed nothing and did not compact.
        expect(deferred.compacted.ran).toBe(false);
        expect(deferred.compacted.reason).toBe("skipped");
        expect(freeBytes(db)).toBeGreaterThan(0);

        rival.exec("COMMIT");
        const compacted = runJanitor({ db, now: NOW, settings: SETTINGS, compactMinFreeBytes: 0 });
        expect(compacted.compacted.ran).toBe(true);
        expect(freeBytes(db)).toBe(0);
        expect(rival.prepare("SELECT value FROM meta WHERE key = 'rival'").get()).toEqual({
          value: "1",
        });
      } finally {
        rival.close();
      }
    });
  });

  it("keeps a concurrent connection's view and writes correct across a compaction", async () => {
    await withStoreDir("pi-compact-concurrent-", async () => {
      const store = await loadHashStore();
      const db = store.db;
      seedExpiredLeases(db, 3_000);
      db.exec("DELETE FROM served_leases");

      const other = new DatabaseSync(hashStorePath(), { timeout: 500 });
      try {
        // A read transaction that started before the rewrite keeps its own snapshot in WAL.
        other.exec("BEGIN");
        const beforeCount = other.prepare("SELECT COUNT(*) AS n FROM meta").get() as { n: number };

        const outcome = runJanitor({ db, now: NOW, settings: SETTINGS, compactMinFreeBytes: 0 });
        // Either the rewrite ran, or a concurrent reader made SQLite defer it; both are correct and
        // neither may corrupt or fail the other connection's view.
        expect(outcome.ran).toBe(true);

        expect(other.prepare("SELECT COUNT(*) AS n FROM meta").get()).toEqual(beforeCount);
        other.exec("COMMIT");
        other.prepare("INSERT INTO meta (key, value) VALUES ('other', 'ok')").run();
        expect(db.prepare("SELECT value FROM meta WHERE key = 'other'").get()).toEqual({
          value: "ok",
        });
      } finally {
        other.close();
      }
    });
  });
});
