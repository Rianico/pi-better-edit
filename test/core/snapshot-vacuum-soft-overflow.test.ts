import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import {
  reportVacuumSoftOverflow,
  snapshotHashFor,
  upsertSnapshot,
  VACUUM_LINEAGE_BYTES_PER_LINE,
  type VacuumResult,
} from "../../src/snapshot-store";
import { initHasher } from "../../src/hashline/hasher";
import { getWritableTempRoot } from "../support/fixtures";

beforeAll(async () => {
  await initHasher();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-soft-overflow-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  try {
    await run(home);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
}

function overSoftOverflowResult(): VacuumResult {
  return {
    evicted: 0,
    totalBytes: 120 * 1024 * 1024,
    pinnedBytes: 120 * 1024 * 1024,
    deferredBytes: 70 * 1024 * 1024,
    overSoftOverflow: true,
  };
}

function underSoftOverflowResult(): VacuumResult {
  return {
    evicted: 0,
    totalBytes: 10,
    pinnedBytes: 0,
    deferredBytes: 0,
    overSoftOverflow: false,
  };
}

function seedVersion(
  db: DatabaseSync,
  path: string,
  hash: string,
  lineCount: number,
  createdAt: number,
): number {
  const row = db
    .prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) " +
        "VALUES (?, ?, ?, ?, 1) RETURNING snapshot_id",
    )
    .get(path, hash, lineCount, createdAt) as { snapshot_id: number };
  db.prepare(
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) " +
      "VALUES (?, 1, ?, ?, ?)",
  ).run(row.snapshot_id, row.snapshot_id * 1000, `canon-${hash}`, `anc-${hash}`);
  return row.snapshot_id;
}

function seedLease(db: DatabaseSync, path: string, snapshotHash: string): void {
  db.prepare(
    "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, " +
      "served_snapshot_hash, served_line_number, updated_at, retired_at) VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?)",
  ).run(
    "sessionA",
    path,
    `anc-${snapshotHash}`,
    `canon-${snapshotHash}`,
    snapshotHash,
    Date.now(),
    null,
  );
}

describe("vacuum soft-overflow diagnostic (spec §3.6.1)", () => {
  it("emits one operator-visible warning with byte counts when overSoftOverflow holds", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = overSoftOverflowResult();

      reportVacuumSoftOverflow(store.db, result);

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message).toContain(String(result.totalBytes));
      expect(message).toContain(String(result.pinnedBytes));
      expect(message).toContain(String(result.deferredBytes));
    });
  });

  it("stays silent when overSoftOverflow does not hold", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      reportVacuumSoftOverflow(store.db, underSoftOverflowResult());

      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("throttles repeated over-soft-overflow passes to a single warning", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      reportVacuumSoftOverflow(store.db, overSoftOverflowResult());
      reportVacuumSoftOverflow(store.db, overSoftOverflowResult());
      reportVacuumSoftOverflow(store.db, overSoftOverflowResult());

      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  it("re-arms after the store recovers below the soft cap", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      reportVacuumSoftOverflow(store.db, overSoftOverflowResult());
      reportVacuumSoftOverflow(store.db, underSoftOverflowResult());
      reportVacuumSoftOverflow(store.db, overSoftOverflowResult());

      expect(warn).toHaveBeenCalledTimes(2);
    });
  });

  it("never throws when the diagnostic channel fails", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      vi.spyOn(console, "warn").mockImplementation(() => {
        throw new Error("diagnostic sink down");
      });

      expect(() => reportVacuumSoftOverflow(store.db, overSoftOverflowResult())).not.toThrow();
    });
  });

  it("materialization over the soft cap warns once, keeps pins, and returns normally", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const db = store.db;
      const bigLines = 300_000;
      for (let i = 0; i < 10; i++) {
        seedVersion(db, `/p${i}.ts`, `hash-${i}`, bigLines, 1000 * (i + 1));
        seedLease(db, `/p${i}.ts`, `hash-${i}`);
      }
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const pinnedBefore = (
        db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }
      ).n;
      const content = "alpha\n";

      expect(() =>
        upsertSnapshot(store, {
          path: "/new.ts",
          snapshotHash: snapshotHashFor(content),
          lineCount: 1,
          hashes: ["AAA"],
          content,
        }),
      ).not.toThrow();
      expect(() =>
        upsertSnapshot(store, {
          path: "/new2.ts",
          snapshotHash: snapshotHashFor("beta\n"),
          lineCount: 1,
          hashes: ["AAB"],
          content: "beta\n",
        }),
      ).not.toThrow();

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("totalBytes");
      expect(message).toContain("pinnedBytes");
      expect(message).toContain("deferredBytes");
      const pinnedAfter = (
        db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }
      ).n;
      expect(pinnedAfter).toBeGreaterThanOrEqual(pinnedBefore);
      expect(VACUUM_LINEAGE_BYTES_PER_LINE).toBe(40);
    });
  });
});
