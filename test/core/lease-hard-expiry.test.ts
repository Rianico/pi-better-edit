/**
 * #160 / #159 decision — a served lease hard-expires after the 7-day session TTL.
 *
 * The decided semantics are the point of this file: an ACTIVE (un-retired) lease past the TTL is no
 * longer resolution authority (the read/edit grant path treats it as absent) and the janitor may
 * delete it in bounded batches. The boundary itself is pinned at exactly-TTL / just-inside /
 * just-outside, and retirement keeps its own 1-hour grace — the two terminal states are different.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  isExpiredActiveLease,
  loadHashStore,
  servedLeaseExpiryCutoff,
  shutdownHashStore,
  type HashStore,
} from "../../src/hash-store";
import { runJanitor } from "../../src/store-janitor";
import {
  STORE_JANITOR_DEFAULTS,
  type StoreJanitorSettings,
} from "../../src/store-kernel/settings.js";
import { leaseSpanSource } from "../../src/mutation-engine/edit-source";
import { sessionKeyFor } from "../../src/served-session/session";
import { snapshotHashFor, upsertSnapshot, VACUUM_RETIRED_PIN_MS } from "../../src/snapshot-store";
import { vacuumSnapshots } from "../../src/snapshot-store";
import { anchorRows, getText, setupIntegrationTest, withTempFile } from "../support/fixtures";
import { getWritableTempRoot } from "../support/fixtures";
import { initHasher } from "../../src/hashline/hasher";
import { ANCHOR_GENERATION } from "../../src/hashline/hash-identity.js";

beforeAll(async () => {
  await initHasher();
});

const NOW = 1_700_000_000_000;
const CUTOFF = servedLeaseExpiryCutoff(NOW);
const GRACE_CUTOFF = NOW - VACUUM_RETIRED_PIN_MS;
const SETTINGS: StoreJanitorSettings = {
  mode: STORE_JANITOR_DEFAULTS.mode,
  intervalMs: 60_000,
  batchSize: 2,
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

function plantSnapshot(store: HashStore, path: string, content: string): string {
  const snapshotHash = snapshotHashFor(content);
  upsertSnapshot(store, {
    path,
    snapshotHash,
    lineCount: content.split("\n").length,
    hashes: ["AAAA"],
    content,
  });
  return snapshotHash;
}

/** A committed snapshot row with one lineage row, the shape a real materialization leaves. */
function plantVersion(db: DatabaseSync, path: string, hash: string, createdAt: number): number {
  const row = db
    .prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) " +
        "VALUES (?, ?, 1, ?, 1, ?) RETURNING snapshot_id",
    )
    .get(path, hash, createdAt, ANCHOR_GENERATION) as { snapshot_id: number };
  db.prepare(
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?, 1, ?, ?, ?)",
  ).run(row.snapshot_id, row.snapshot_id * 1000, `canon-${hash}`, `anchor-${hash}`);
  return row.snapshot_id;
}

function plantLease(
  db: DatabaseSync,
  input: {
    path: string;
    anchor: string;
    servedSnapshotHash: string;
    updatedAt: number;
    retiredAt: number | null;
  },
): void {
  db.prepare(
    "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, served_snapshot_hash, served_line_number, updated_at, retired_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    "s1",
    input.path,
    input.anchor,
    1,
    "cafe",
    input.servedSnapshotHash,
    1,
    input.updatedAt,
    input.retiredAt,
  );
}

function anchorsOf(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT anchor FROM served_leases ORDER BY anchor").all() as { anchor: string }[]
  ).map((row) => row.anchor);
}

describe("the canonical lease hard-expiry boundary (ADR-0045)", () => {
  it("expires strictly past the TTL: exactly TTL and just inside still resolve", () => {
    const active = (updatedAt: number) => ({ retired_at: null, updated_at: updatedAt });

    expect(isExpiredActiveLease(active(CUTOFF), NOW)).toBe(false); // exactly TTL
    expect(isExpiredActiveLease(active(CUTOFF + 1), NOW)).toBe(false); // just inside
    expect(isExpiredActiveLease(active(CUTOFF - 1), NOW)).toBe(true); // just outside
  });

  it("leaves retired leases to their own grace, whatever their updated_at", () => {
    expect(isExpiredActiveLease({ retired_at: NOW, updated_at: CUTOFF - 1 }, NOW)).toBe(false);
    expect(isExpiredActiveLease({ retired_at: NOW, updated_at: NOW }, NOW)).toBe(false);
  });
});

describe("janitor GC of expired active leases", () => {
  it("deletes only the just-outside rows and keeps the TTL boundary and the retired grace", async () => {
    await withStoreDir("pi-lease-expiry-", async () => {
      const store = await loadHashStore();
      const db = store.db;
      const snapshotHash = plantSnapshot(store, "/expiry.ts", "x\n");
      const lease = (anchor: string, updatedAt: number, retiredAt: number | null = null) =>
        plantLease(db, {
          path: "/expiry.ts",
          anchor,
          servedSnapshotHash: snapshotHash,
          updatedAt,
          retiredAt,
        });

      lease("aaaa", CUTOFF); // exactly TTL — still resolvable
      lease("bbbb", CUTOFF + 1); // just inside
      lease("cccc", CUTOFF - 1); // just outside the TTL — deleted
      lease("dddd", CUTOFF - 1_000_000, GRACE_CUTOFF + 1); // retired inside grace — kept
      lease("eeee", NOW, GRACE_CUTOFF - 1); // retired past grace — deleted
      lease("ffff", NOW, GRACE_CUTOFF); // exactly at the grace boundary — kept

      const outcome = runJanitor({ db, now: NOW, settings: SETTINGS });

      expect(outcome.deleted.expiredLeases).toBe(2);
      expect(anchorsOf(db)).toEqual(["aaaa", "bbbb", "dddd", "ffff"]);
    });
  });

  it("deletes an expired active batch with bounded statements", async () => {
    await withStoreDir("pi-lease-expiry-batch-", async () => {
      const store = await loadHashStore();
      const db = store.db;
      const snapshotHash = plantSnapshot(store, "/batch.ts", "x\n");
      for (let index = 0; index < 5; index++) {
        plantLease(db, {
          path: "/batch.ts",
          anchor: `a00${index}`,
          servedSnapshotHash: snapshotHash,
          updatedAt: CUTOFF - 1,
          retiredAt: null,
        });
      }

      const statements: string[] = [];
      const proto = DatabaseSync.prototype as unknown as {
        prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
      };
      const originalPrepare = proto.prepare;
      proto.prepare = function patched(sql: string) {
        if (
          sql.startsWith("DELETE FROM served_leases WHERE rowid IN") &&
          sql.includes("served_leases.retired_at IS NULL AND served_leases.updated_at < ?")
        ) {
          statements.push(sql);
        }
        return originalPrepare.call(this, sql);
      };
      try {
        runJanitor({ db, now: NOW, settings: SETTINGS });
      } finally {
        proto.prepare = originalPrepare;
      }

      // 5 rows at batchSize 2 is 3 statements, all bounded, none unbounded.
      expect(statements).toHaveLength(3);
      expect(statements.every((sql) => sql.endsWith("LIMIT ?)"))).toBe(true);
      expect(anchorsOf(db)).toEqual([]);
    });
  });
});

describe("the grant path treats an expired active lease as absent", () => {
  const CONTENT = "alpha\nbravo\ncharlie\n";

  it("loses resolution authority in the lease source and in the read/edit tools", async () => {
    await withTempFile("hard-expiry.txt", CONTENT, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const file = "hard-expiry.txt";
      {
        const read = await readTool.execute("r0", { file }, undefined, undefined, ctx);
        const anchors = anchorRows(getText(read)).map((row) => row.split("│")[0]!);
        const store = await loadHashStore();
        const leasePath = (
          store.db.prepare("SELECT file_path FROM served_leases LIMIT 1").get() as {
            file_path: string;
          }
        ).file_path;
        const expired = anchors[0]!;
        const live = anchors[1]!;
        const now = Date.now();
        store.db
          .prepare("UPDATE served_leases SET updated_at = ? WHERE file_path = ? AND anchor = ?")
          .run(servedLeaseExpiryCutoff(now) - 60_000, leasePath, expired);

        const source = leaseSpanSource({
          store,
          sessionKey: sessionKeyFor(ctx),
          absolutePath: leasePath,
          content: CONTENT,
        });
        expect(source.leaseFor(expired)).toBeUndefined();
        expect(source.leaseFor(live)).toBeDefined();

        // An anchor window centres on a lease: with none, it warns instead of resolving.
        const warned = await readTool.execute(
          "r1",
          { file, windows: [{ around_anchor: expired, radius: 1 }] },
          undefined,
          undefined,
          ctx,
        );
        expect(getText(warned)).toContain(`Anchor '${expired}' not found`);

        // The edit fails closed: the anchor no longer names a line this session can resolve.
        await expect(
          editTool.execute(
            "e1",
            { file, edits: [{ anchor_from: expired, anchor_to: expired, text: "ALPHA" }] },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/E_UNKNOWN_ANCHOR/);
      }
    });
  });

  it("keeps an unexpired lease and a retired lease available to the grant path", async () => {
    await withTempFile("hard-expiry-live.txt", CONTENT, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute(
        "r0",
        { file: "hard-expiry-live.txt" },
        undefined,
        undefined,
        ctx,
      );
      const anchors = anchorRows(getText(read)).map((row) => row.split("│")[0]!);
      const store = await loadHashStore();
      // WHY: the store is worker-scoped, so other tests' leases are still present. Name THIS
      // WHY: file's lease path by an anchor the read just served.
      const leasePath = (
        store.db
          .prepare("SELECT file_path FROM served_leases WHERE anchor = ? LIMIT 1")
          .get(anchors[0]!) as { file_path: string }
      ).file_path;
      const retired = anchors[0]!;
      const inside = anchors[1]!;
      const now = Date.now();
      store.db
        .prepare(
          "UPDATE served_leases SET updated_at = ?, retired_at = ? WHERE file_path = ? AND anchor = ?",
        )
        .run(servedLeaseExpiryCutoff(now) - 60_000, now, leasePath, retired);
      store.db
        .prepare("UPDATE served_leases SET updated_at = ? WHERE file_path = ? AND anchor = ?")
        .run(servedLeaseExpiryCutoff(now) + 60_000, leasePath, inside);

      const source = leaseSpanSource({
        store,
        sessionKey: sessionKeyFor(ctx),
        absolutePath: leasePath,
        content: CONTENT,
      });
      // Retirement is a different terminal state: the row is returned (with its retiredAt) so the
      // resolver can judge it; it is not silently dropped by the TTL rule.
      expect(source.leaseFor(retired)?.retiredAt).toBe(now);
      expect(source.leaseFor(inside)?.retiredAt).toBeNull();
    });
  });
});

describe("vacuum and the hard-expiry predicate", () => {
  it("does not let an expired active lease pin its snapshot", async () => {
    await withStoreDir("pi-lease-vacuum-", async () => {
      const db = (await loadHashStore()).db;
      const now = Date.now();
      for (let version = 0; version < 12; version++) {
        const hash = `vacuum-${version}`;
        plantVersion(db, "/vacuum.ts", hash, now - (12 - version) * 1000);
        plantLease(db, {
          path: "/vacuum.ts",
          anchor: `a00${version}`,
          servedSnapshotHash: hash,
          updatedAt: servedLeaseExpiryCutoff(now) - 1,
          retiredAt: null,
        });
      }

      const result = vacuumSnapshots(db);

      // The expired leases contribute no pin at all, so the per-path window (10) keeps 10 and
      // evicts the two oldest.
      expect(result.pinnedBytes).toBe(0);
      expect(result.evicted).toBe(2);
      const remaining = (
        db.prepare("SELECT snapshot_hash FROM file_snapshots ORDER BY created_at").all() as {
          snapshot_hash: string;
        }[]
      ).map((row) => row.snapshot_hash);
      expect(remaining).toHaveLength(10);
      expect(remaining).not.toContain("vacuum-0");
      expect(remaining).not.toContain("vacuum-1");
    });
  });

  it("still pins a snapshot whose lease is inside the TTL", async () => {
    await withStoreDir("pi-lease-vacuum-live-", async () => {
      const db = (await loadHashStore()).db;
      const now = Date.now();
      for (let version = 0; version < 12; version++) {
        const hash = `live-${version}`;
        plantVersion(db, "/live.ts", hash, now - (12 - version) * 1000);
        plantLease(db, {
          path: "/live.ts",
          anchor: `b00${version}`,
          servedSnapshotHash: hash,
          updatedAt: version === 0 ? now : servedLeaseExpiryCutoff(now) - 1,
          retiredAt: null,
        });
      }

      const result = vacuumSnapshots(db);

      // The oldest version's lease is unexpired, so it contributes a live pin and survives the
      // window; the next two oldest unpinned versions are evicted instead.
      expect(result.pinnedBytes).toBeGreaterThan(0);
      const remaining = (
        db.prepare("SELECT snapshot_hash FROM file_snapshots").all() as {
          snapshot_hash: string;
        }[]
      ).map((row) => row.snapshot_hash);
      expect(remaining).toContain("live-0");
      expect(remaining).not.toContain("live-1");
      expect(remaining).not.toContain("live-2");
    });
  });
});
