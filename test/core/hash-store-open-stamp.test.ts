/**
 * #87c/#87d — the stamp-gated open. A two-part stamp (the DB header's `PRAGMA user_version` for the
 * schema half, a `meta` row for the anchor-generation half) decides whether the generation sweep or
 * the `meta('version')` upsert run, so a healthy, stamp-matching open issues NO write transaction —
 * proved lock-free by opening while a rival process holds the store's write lock.
 *
 * The stamp is the open's last step: `buildStore` hands the stamp-due decision back, `openStore`
 * writes both halves once every hook has succeeded (inside the retry budget, because that write
 * leaves `openDbWithBusyRetry`'s envelope), and the hook phase's re-entrant ensure consults the
 * open's in-memory decision rather than the row — so a slow-path open sweeps exactly once and stamps
 * exactly once, and a hook that throws leaves no stamp over an unfinished store.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  hashStorePath,
  loadHashStore,
  onStoreOpen,
  shutdownHashStore,
  type HashStore,
} from "../../src/hash-store";
import { SERVED_PRUNE_INTERVAL_MS, SERVED_TTL_MS } from "../../src/constants";
import { HASH_STORE_VERSION } from "../../src/store-kernel/index.js";
import {
  ANCHOR_GENERATION,
  CANON_VERSION,
  contentOnlyHashes,
} from "../../src/hashline/hash-identity.js";
import { splitLines } from "../../src/utils";
import { initHasher } from "../../src/hashline/hasher";
import { snapshotHashFor, upsertSnapshot } from "../../src/snapshot-store";
import { getWritableTempRoot } from "../support/fixtures";

const STAMP_KEY = "store_stamp";
const PRUNE_RUN_KEY = "served_prune_at";
const STAMP_SHAPE = new RegExp(
  `^1:${HASH_STORE_VERSION}:${CANON_VERSION}:${ANCHOR_GENERATION}:\\d+$`,
);

function expectCurrentStamp(): string {
  const view = readStamp();
  expect(view.userVersion).toBe(HASH_STORE_VERSION);
  expect(view.version).toBe(String(HASH_STORE_VERSION));
  expect(view.stamp).toMatch(STAMP_SHAPE);
  return view.stamp as string;
}

beforeAll(async () => {
  await initHasher();
});

async function withStoreDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), "pi-stamp-"));
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", dir);
  try {
    await run(dir);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}

async function aliasStoreDir(dir: string): Promise<string> {
  const alias = join(dir, "alias");
  await symlink(dir, alias);
  return alias;
}

interface StampView {
  userVersion: number;
  version: string | undefined;
  stamp: string | undefined;
}

function readStamp(): StampView {
  const db = new DatabaseSync(hashStorePath());
  try {
    const header = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const rows = db
      .prepare("SELECT key, value FROM meta WHERE key IN (?, ?)")
      .all("version", STAMP_KEY) as unknown as { key: string; value: string }[];
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    return {
      userVersion: header.user_version,
      version: byKey.get("version"),
      stamp: byKey.get(STAMP_KEY),
    };
  } finally {
    db.close();
  }
}

interface StatementTrace {
  beginImmediate: number;
  sweepDeletes: number;
  /** `meta` upserts PREPARED by the open: the `version` row and the `store_stamp` row, one prepare each. */
  metaUpserts: number;
  /** `PRAGMA user_version = ...` writes the open issued — the header half of the stamp. */
  headerStamps: number;
  /** Every `exec` the open issued that would need the write lock. */
  writes: string[];
  /** Every `exec` the open issued, in order — the DDL trace of the two schema-ensure sites. */
  execs: string[];
}

function schemaEnsureSites(trace: StatementTrace): number {
  return trace.execs.filter((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS file_snapshots"))
    .length;
}

function startTrace(): { stop: () => StatementTrace } {
  const proto = DatabaseSync.prototype as unknown as {
    exec: (sql: string) => unknown;
    prepare: (sql: string) => unknown;
  };
  const originalExec = proto.exec;
  const originalPrepare = proto.prepare;
  let beginImmediate = 0;
  let sweepDeletes = 0;
  let metaUpserts = 0;
  let headerStamps = 0;
  const writes: string[] = [];
  const execs: string[] = [];
  proto.exec = function (sql: string) {
    const flat = sql.replace(/\s+/g, " ").trim();
    execs.push(flat);
    if (/^BEGIN IMMEDIATE/i.test(flat)) beginImmediate += 1;
    if (/^DELETE FROM (served_leases|file_snapshots|line_lineage)\b/i.test(flat)) sweepDeletes += 1;
    if (/^PRAGMA user_version\s*=/i.test(flat)) headerStamps += 1;
    if (/^(BEGIN IMMEDIATE|COMMIT|DELETE|INSERT|UPDATE|ALTER TABLE|DROP TABLE)/i.test(flat)) {
      writes.push(flat.slice(0, 80));
    }
    return originalExec.call(this, sql);
  };
  proto.prepare = function (sql: string) {
    const flat = sql.replace(/\s+/g, " ").trim();
    if (/^INSERT INTO meta/i.test(flat)) metaUpserts += 1;
    return originalPrepare.call(this, sql);
  };
  return {
    stop: () => {
      proto.exec = originalExec;
      proto.prepare = originalPrepare;
      return { beginImmediate, sweepDeletes, metaUpserts, headerStamps, writes, execs };
    },
  };
}

function holdWriteLock(): () => void {
  const holder = new DatabaseSync(hashStorePath(), { timeout: 0 });
  holder.exec("BEGIN IMMEDIATE");
  holder.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("rival", "1");
  return () => {
    try {
      holder.exec("ROLLBACK");
    } finally {
      holder.close();
    }
  };
}

function plantSnapshot(store: HashStore, path: string, content: string): void {
  upsertSnapshot(store, {
    path,
    snapshotHash: snapshotHashFor(content),
    lineCount: splitLines(content).length,
    hashes: contentOnlyHashes(content),
    content,
  });
}

function plantForeignGenerationRow(db: DatabaseSync, path: string): void {
  const row = db
    .prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) " +
        "VALUES (?,?,?,?,1,?) RETURNING snapshot_id",
    )
    .get(path, `${CANON_VERSION}:999:foreign`, 3, Date.now(), 999) as { snapshot_id: number };
  db.prepare(
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?,?,?,?,?)",
  ).run(row.snapshot_id, 0, 987654, "deadbeefdeadbeef", "zzz1");
}

function countRows(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

function countsOf(trace: StatementTrace): {
  beginImmediate: number;
  sweepDeletes: number;
  metaUpserts: number;
  headerStamps: number;
} {
  return {
    beginImmediate: trace.beginImmediate,
    sweepDeletes: trace.sweepDeletes,
    metaUpserts: trace.metaUpserts,
    headerStamps: trace.headerStamps,
  };
}

let hookThrows = false;
let holdWriteLockMs = 0;

/**
 * A lock holder for the "write lock held across the hook phase" test. It is a CHILD process because the
 * retry loop that waits on that lock sleeps the test worker's own event loop, so a timer in this process
 * could not fire while the deferred write is being retried. The child takes the store's write lock, says
 * so on stdout, and releases it `holdMs` later on its own loop.
 */
const LOCK_HOLDER_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { timeout: 0 });
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("hook-rival", "1");
process.stdout.write("locked\\n");
setTimeout(() => { try { db.exec("ROLLBACK"); } finally { db.close(); process.exit(0); } }, Number(process.argv[2]));
`;

onStoreOpen(async () => {
  if (hookThrows) throw new Error("injected hook failure");
  if (holdWriteLockMs > 0) {
    const holder = spawn(
      process.execPath,
      ["-e", LOCK_HOLDER_SCRIPT, hashStorePath(), String(holdWriteLockMs)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once("data", () => resolve());
      holder.once("error", reject);
      holder.once("exit", (code) =>
        reject(new Error(`lock holder exited before locking (${code})`)),
      );
    });
    holder.unref();
  }
});

describe("stamp-gated open (#87c)", () => {
  it("takes no write lock: a fast-path open succeeds while a rival holds BEGIN IMMEDIATE", async () => {
    await withStoreDir(async (dir) => {
      const store = await loadHashStore();
      plantSnapshot(store, join(dir, "healthy.ts"), "aaa\nbbb\nccc\n");
      expectCurrentStamp();
      shutdownHashStore();

      const release = holdWriteLock();
      const trace = startTrace();
      let opened = false;
      const started = performance.now();
      try {
        await loadHashStore();
        opened = true;
      } finally {
        const measured = performance.now() - started;
        const recorded = trace.stop();
        release();
        expect(recorded.beginImmediate).toBe(0);
        expect(recorded.sweepDeletes).toBe(0);
        expect(recorded.writes).toEqual([]);
        expect(measured).toBeLessThan(2000);
      }
      expect(opened).toBe(true);
    });
  });

  it("sweeps at both call sites on a fresh store, stamps it, then takes the fast path", async () => {
    await withStoreDir(async () => {
      const first = startTrace();
      await loadHashStore();
      const firstTrace = first.stop();
      expect(firstTrace.beginImmediate).toBe(1);
      expect(firstTrace.sweepDeletes).toBe(2);
      expect(schemaEnsureSites(firstTrace)).toBe(2);
      expectCurrentStamp();

      shutdownHashStore();
      const second = startTrace();
      await loadHashStore();
      const secondTrace = second.stop();
      expect(secondTrace.beginImmediate).toBe(0);
      expect(secondTrace.sweepDeletes).toBe(0);
      expect(schemaEnsureSites(secondTrace)).toBe(2);
      expect(secondTrace.writes).toEqual([]);
      expectCurrentStamp();
    });
  });

  it("a mismatch in EITHER stamp half runs the slow path and rewrites both halves", async () => {
    for (const poison of [
      {
        half: "the schema half",
        apply: (db: DatabaseSync) => db.exec("PRAGMA user_version = 0"),
        mismatched: { userVersion: 0 },
      },
      {
        half: "the generation half",
        apply: (db: DatabaseSync) =>
          db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("2:1", STAMP_KEY),
        mismatched: { stamp: "2:1" },
      },
    ] as const) {
      await withStoreDir(async (dir) => {
        const store = await loadHashStore();
        plantSnapshot(store, join(dir, "healthy.ts"), "aaa\nbbb\nccc\n");
        plantForeignGenerationRow(store.db, join(dir, "poisoned.ts"));
        expectCurrentStamp();
        poison.apply(store.db);
        expect(readStamp()).toMatchObject(poison.mismatched);
        shutdownHashStore();

        const trace = startTrace();
        const reopened = await loadHashStore();
        const recorded = trace.stop();
        expect(recorded.beginImmediate).toBe(1);
        expect(recorded.sweepDeletes).toBe(4);
        expect(schemaEnsureSites(recorded)).toBe(2);
        expect(
          countRows(
            reopened.db,
            "SELECT COUNT(*) AS n FROM file_snapshots WHERE anchor_generation != ?",
            ANCHOR_GENERATION,
          ),
        ).toBe(0);
        expect(
          countRows(
            reopened.db,
            "SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id NOT IN (SELECT snapshot_id FROM file_snapshots)",
          ),
        ).toBe(0);
        expectCurrentStamp();
      });
    }
  });

  it("folds the open-hook count into the stamp, so an ADDED hook invalidates it", async () => {
    await withStoreDir(async () => {
      const store = await loadHashStore();
      plantForeignGenerationRow(store.db, "/poisoned.ts");
      const count = Number((readStamp().stamp as string).split(":")[4]);
      expect(Number.isInteger(count)).toBe(true);
      store.db
        .prepare("UPDATE meta SET value = ? WHERE key = ?")
        .run(
          `1:${HASH_STORE_VERSION}:${CANON_VERSION}:${ANCHOR_GENERATION}:${count + 1}`,
          STAMP_KEY,
        );
      shutdownHashStore();

      const trace = startTrace();
      const reopened = await loadHashStore();
      const recorded = trace.stop();
      expect(recorded.beginImmediate).toBe(1);
      expect(
        countRows(
          reopened.db,
          "SELECT COUNT(*) AS n FROM file_snapshots WHERE anchor_generation != ?",
          ANCHOR_GENERATION,
        ),
      ).toBe(0);
      expect(expectCurrentStamp()).toBe(
        `1:${HASH_STORE_VERSION}:${CANON_VERSION}:${ANCHOR_GENERATION}:${count}`,
      );
    });
  });

  it("folds the stamp's FORMAT version in, so changing the field list invalidates old stamps", async () => {
    await withStoreDir(async () => {
      const store = await loadHashStore();
      plantForeignGenerationRow(store.db, "/poisoned.ts");
      const value = readStamp().stamp as string;
      store.db
        .prepare("UPDATE meta SET value = ? WHERE key = ?")
        .run(`0:${value.split(":").slice(1).join(":")}`, STAMP_KEY);
      shutdownHashStore();

      const trace = startTrace();
      const reopened = await loadHashStore();
      const recorded = trace.stop();
      expect(recorded.beginImmediate).toBe(1);
      expect(
        countRows(
          reopened.db,
          "SELECT COUNT(*) AS n FROM file_snapshots WHERE anchor_generation != ?",
          ANCHOR_GENERATION,
        ),
      ).toBe(0);
      expect(expectCurrentStamp()).toBe(value);
    });
  });

  it("a stale or future HASH_STORE_VERSION takes the slow path and is rewritten", async () => {
    for (const version of [HASH_STORE_VERSION - 1, HASH_STORE_VERSION + 1]) {
      await withStoreDir(async () => {
        const store = await loadHashStore();
        plantForeignGenerationRow(store.db, "/poisoned.ts");
        store.db.exec(`PRAGMA user_version = ${version}`);
        shutdownHashStore();

        const trace = startTrace();
        const reopened = await loadHashStore();
        const recorded = trace.stop();
        expect(recorded.beginImmediate).toBe(1);
        expect(
          countRows(
            reopened.db,
            "SELECT COUNT(*) AS n FROM file_snapshots WHERE anchor_generation != ?",
            ANCHOR_GENERATION,
          ),
        ).toBe(0);
        expect(expectCurrentStamp()).toMatch(STAMP_SHAPE);
      });
    }
  });

  it("a failing sweep leaves the stamp unset, and the restored open stamps it", async () => {
    await withStoreDir(async () => {
      const proto = DatabaseSync.prototype as unknown as { exec: (sql: string) => unknown };
      const originalExec = proto.exec;
      proto.exec = function (sql: string) {
        if (/DELETE FROM file_snapshots/i.test(sql)) throw new Error("injected mid-sweep failure");
        return originalExec.call(this, sql);
      };
      try {
        await expect(loadHashStore()).rejects.toThrow(/injected mid-sweep failure/);
      } finally {
        proto.exec = originalExec;
      }
      expect(readStamp()).toMatchObject({
        userVersion: 0,
        version: undefined,
        stamp: undefined,
      });

      await loadHashStore();
      expectCurrentStamp();
    });
  });

  it("pins the version row and the header to the store version", async () => {
    await withStoreDir(async () => {
      const store = await loadHashStore();
      expect(store.db.prepare("SELECT value FROM meta WHERE key = 'version'").get()).toEqual({
        value: String(HASH_STORE_VERSION),
      });
      expect(store.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: HASH_STORE_VERSION,
      });
      shutdownHashStore();
      const reopened = await loadHashStore();
      expect(reopened.db.prepare("SELECT value FROM meta WHERE key = 'version'").get()).toEqual({
        value: String(HASH_STORE_VERSION),
      });
      expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: HASH_STORE_VERSION,
      });
      expectCurrentStamp();
    });
  });

  it("leaves planted rows alone across a stamp-matching reopen (the deliberate trade)", async () => {
    await withStoreDir(async (dir) => {
      const store = await loadHashStore();
      plantForeignGenerationRow(store.db, join(dir, "poisoned.ts"));
      shutdownHashStore();
      const fast = await loadHashStore();
      expect(
        countRows(
          fast.db,
          "SELECT COUNT(*) AS n FROM file_snapshots WHERE anchor_generation != ?",
          ANCHOR_GENERATION,
        ),
      ).toBe(1);

      fast.db.exec("PRAGMA user_version = 0");
      shutdownHashStore();
      const slow = await loadHashStore();
      expect(
        countRows(
          slow.db,
          "SELECT COUNT(*) AS n FROM file_snapshots WHERE anchor_generation != ?",
          ANCHOR_GENERATION,
        ),
      ).toBe(0);
    });
  });
});

describe("the stamp is the open's last step (#87d)", () => {
  it("a hook that throws leaves no stamp, and the next open takes the slow path and re-stamps", async () => {
    await withStoreDir(async () => {
      hookThrows = true;
      try {
        await expect(loadHashStore(), "the open must fail at the throwing hook").rejects.toThrow(
          /injected hook failure/,
        );
      } finally {
        hookThrows = false;
      }

      const failed = readStamp();
      expect(failed, `stamp after a throwing hook: ${JSON.stringify(failed)}`).toEqual({
        userVersion: 0,
        version: String(HASH_STORE_VERSION),
        stamp: undefined,
      });

      const probe = new DatabaseSync(hashStorePath());
      try {
        expect(
          countRows(
            probe,
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'file_undo'",
          ),
        ).toBe(1);
      } finally {
        probe.close();
      }

      const trace = startTrace();
      await loadHashStore();
      const recorded = trace.stop();
      expect(recorded.beginImmediate).toBe(1);
      expect(recorded.sweepDeletes).toBe(4);
      expectCurrentStamp();
    });
  });

  it("retries the deferred stamp write when the store is busy at the end of the open", async () => {
    await withStoreDir(async () => {
      const store = await loadHashStore();
      store.db.exec("PRAGMA user_version = 0");
      shutdownHashStore();

      let draws = 0;
      const budget = {
        timeoutMs: 25,
        maxAttempts: 40,
        backoffBaseMs: 10,
        backoffCapMs: 40,
        backoffJitterMs: 0,
        random: () => {
          draws += 1;
          return 0;
        },
      };
      holdWriteLockMs = 350;
      try {
        await loadHashStore(budget);
      } finally {
        holdWriteLockMs = 0;
      }
      expect(draws, "the deferred stamp write must have retried").toBeGreaterThanOrEqual(1);
      expectCurrentStamp();
    });
  });

  it("sweeps once and writes the stamp once on the slow path, and nothing at all on the fast path", async () => {
    await withStoreDir(async () => {
      const store = await loadHashStore();
      plantForeignGenerationRow(store.db, "/poisoned.ts");
      store.db.exec("PRAGMA user_version = 0");
      shutdownHashStore();

      const trace = startTrace();
      await loadHashStore();
      const slow = trace.stop();
      const slowCounts = countsOf(slow);
      expect(slowCounts, `slow-path open: ${JSON.stringify(slowCounts)}`).toEqual({
        beginImmediate: 1,
        sweepDeletes: 4,
        metaUpserts: 2,
        headerStamps: 1,
      });
      expect(schemaEnsureSites(slow)).toBe(2);
      expectCurrentStamp();

      shutdownHashStore();
      const fast = startTrace();
      await loadHashStore();
      const fastTrace = fast.stop();
      const fastCounts = { ...countsOf(fastTrace), writes: fastTrace.writes };
      expect(fastCounts, `fast-path open: ${JSON.stringify(fastCounts)}`).toEqual({
        beginImmediate: 0,
        sweepDeletes: 0,
        metaUpserts: 0,
        headerStamps: 0,
        writes: [],
      });
    });
  });
});

describe("periodic served-mirror prune (#87c)", () => {
  function plantMirrorRows(store: HashStore): { expired: string[]; fresh: string } {
    const now = Date.now();
    const insert = store.db.prepare(
      "INSERT INTO served_session_meta (session_id, file_path, hashes, updated_at) VALUES (?,?,?,?)",
    );
    for (const id of ["old-a", "old-b"])
      insert.run(id, `/gone/${id}.ts`, "[]", now - SERVED_TTL_MS - 1);
    insert.run("live", "/kept.ts", "[]", now);
    return { expired: ["old-a", "old-b"], fresh: "live" };
  }

  function mirrorSessions(db: DatabaseSync): string[] {
    const rows = db
      .prepare(
        "SELECT session_id FROM served_session_meta WHERE hashes IS NOT NULL ORDER BY session_id",
      )
      .all() as unknown as { session_id: string }[];
    return rows.map((row) => row.session_id);
  }

  it("a due prune clears exactly the expired mirror columns", async () => {
    await withStoreDir(async () => {
      const store = await loadHashStore();
      const { expired, fresh } = plantMirrorRows(store);
      expect(expired).toHaveLength(2);
      shutdownHashStore();

      const reopened = await loadHashStore();
      expect(mirrorSessions(reopened.db)).toEqual([fresh]);
      const recorded = reopened.db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(PRUNE_RUN_KEY) as { value: string } | undefined;
      expect(recorded).toBeDefined();
    });
  });

  it("runs only when due: a backdated run stamp fires, a fresh one does not", async () => {
    await withStoreDir(async () => {
      const store = await loadHashStore();
      plantMirrorRows(store);
      store.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(PRUNE_RUN_KEY, String(Date.now()));
      shutdownHashStore();
      const notDue = await loadHashStore();
      expect(mirrorSessions(notDue.db)).toEqual(["live", "old-a", "old-b"]);
      expect(
        countRows(
          notDue.db,
          "SELECT COUNT(*) AS n FROM served_session_meta WHERE hashes IS NOT NULL AND updated_at < ?",
          Date.now() - SERVED_TTL_MS,
        ),
      ).toBe(2);

      notDue.db
        .prepare("UPDATE meta SET value = ? WHERE key = ?")
        .run(String(Date.now() - SERVED_PRUNE_INTERVAL_MS - 1), PRUNE_RUN_KEY);
      shutdownHashStore();
      const due = await loadHashStore();
      expect(mirrorSessions(due.db)).toEqual(["live"]);
    });
  });

  it("does not write the run stamp when there is nothing to prune", async () => {
    await withStoreDir(async () => {
      await loadHashStore();
      shutdownHashStore();
      const reopened = await loadHashStore();
      expect(
        reopened.db.prepare("SELECT value FROM meta WHERE key = ?").get(PRUNE_RUN_KEY),
      ).toBeUndefined();
    });
  });
});

/**
 * #87c — three REAL opens of ONE store, in one process, in both orders, quoting each leg's statement
 * counts. Each leg reaches the store through a different spelling of its path (`aliasStoreDir`),
 * because `loadHashStore` caches per path STRING; the open's own shutdown is then the only thing that
 * ends the previous connection, so the SLOT, not the handle, is what these counts pin.
 *
 * The slow and fast legs restate "sweeps once and writes the stamp once on the slow path" per leg.
 * RED PROOF: remove `openStamp = stamp` and leg 1 reds on `beginImmediate` (2 against 1), as do
 * seven sibling tests in this file, each in its own shape.
 */
describe("two sequential opens in one process (#87c)", () => {
  const FIRST_OPEN_LEG = { beginImmediate: 1, sweepDeletes: 2, metaUpserts: 2, headerStamps: 1 };
  const SLOW_LEG = { beginImmediate: 1, sweepDeletes: 4, metaUpserts: 2, headerStamps: 1 };
  const FAST_LEG = { beginImmediate: 0, sweepDeletes: 0, metaUpserts: 0, headerStamps: 0 };

  it("runs slow then fast, then fast then slow, on one store in one process", async () => {
    await withStoreDir(async (dir) => {
      const alias = await aliasStoreDir(dir);

      const leg1 = startTrace();
      await loadHashStore();
      const leg1Run = leg1.stop();
      const leg1Counts = countsOf(leg1Run);
      expect(leg1Counts, `leg 1, fresh store: ${JSON.stringify(leg1Counts)}`).toEqual(
        FIRST_OPEN_LEG,
      );
      expect(
        schemaEnsureSites(leg1Run),
        "both ensure sites ran; the gate skipped the second sweep",
      ).toBe(2);
      expectCurrentStamp();
      expect(await realpath(join(alias, "state", "hash-store.sqlite"))).toBe(
        await realpath(join(dir, "state", "hash-store.sqlite")),
      );

      vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", alias);
      const leg2 = startTrace();
      const store = await loadHashStore();
      const leg2Run = leg2.stop();
      const leg2Counts = { ...countsOf(leg2Run), writes: leg2Run.writes };
      expect(leg2Counts, `leg 2, stamp current: ${JSON.stringify(leg2Counts)}`).toEqual({
        ...FAST_LEG,
        writes: [],
      });
      expect(
        schemaEnsureSites(leg2Run),
        "both ensure sites ran; the gate skipped both sweeps",
      ).toBe(2);

      store.db.exec("PRAGMA user_version = 0");
      vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", dir);
      const leg3 = startTrace();
      await loadHashStore();
      const leg3Run = leg3.stop();
      const leg3Counts = countsOf(leg3Run);
      expect(leg3Counts, `leg 3, header half moved: ${JSON.stringify(leg3Counts)}`).toEqual(
        SLOW_LEG,
      );
      expect(
        schemaEnsureSites(leg3Run),
        "both ensure sites ran; the gate skipped the second sweep",
      ).toBe(2);
      expectCurrentStamp();
    });
  });
});
