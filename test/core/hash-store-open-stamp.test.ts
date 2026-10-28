/**
 * #87c — the stamp-gated open: a healthy, stamp-matching open performs NO WRITE TRANSACTION AT ALL.
 *
 * WHY this file exists: the open chain used to sweep the store's generation state on every open, at
 * TWO call sites (`buildStore`'s `ensureSnapshotTables` and the snapshot-store open hook's re-entrant
 * `ensureSnapshotSchema`), and to re-write `meta('version')` on every open as well. All three are
 * writers, so a healthy open serialized against every other process on the shared store. The tests
 * below pin the replacement: a two-part stamp (the DB header's `PRAGMA user_version` for the schema
 * half, a `meta` row for the anchor-generation half) decides whether the sweep and the version upsert
 * run, and the whole fast path is proved lock-free by opening while a RIVAL HOLDS THE WRITE LOCK —
 * which no write statement can survive.
 *
 * (#87d) WHY THE STAMP IS THE OPEN'S LAST STEP: a stamp written inside `buildStore` — before
 * `isHealthy` and before the five registered hooks — certifies work that has not happened yet, so a hook
 * that throws leaves a VALID-LOOKING STAMP over an unfinished store and the next open takes the fast
 * path over it. The tests below pin the replacement: `buildStore` hands the stamp-due decision back
 * instead of writing the stamp, `openStore` writes both halves once every hook has succeeded (inside the
 * retry budget, because that write leaves `openDbWithBusyRetry`'s envelope), and the hook phase's
 * re-entrant ensure consults the open's IN-MEMORY decision rather than the row — so a slow-path open
 * still sweeps exactly ONCE and writes the stamp exactly ONCE.

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

/** The `meta` key holding the generation half of the open stamp. */
const STAMP_KEY = "store_stamp";
/** The `meta` key holding the last-run instant of the periodic served-mirror prune. */
const PRUNE_RUN_KEY = "served_prune_at";
/**
 * The stamp's documented format — `<format>:<store schema>:<canon>:<anchor generation>:<hooks>` — as a
 * shape, because the last field is the open-hook count: a build constant the test cannot import (the
 * registry is module-private and its count is only observable through the stamp it produces).
 */
const STAMP_SHAPE = new RegExp(
  `^1:${HASH_STORE_VERSION}:${CANON_VERSION}:${ANCHOR_GENERATION}:\\d+$`,
);

/**
 * Assert the store on disk carries a CURRENT stamp, and return its value so a test can compare it
 * against what a later open produces (the value must be a build constant, not a per-open value).
 */
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

/** The extension root this file owns, published under the env var `stateRoot()` reads; the store
 * lives in its `state/` subdirectory. */
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

/**
 * A SECOND PATH to the store file of `dir`: the alias is a symlink to `dir`, so the two spellings
 * resolve to ONE file while `loadHashStore`'s cache — keyed on the path STRING — cannot serve the
 * next leg from the previous leg's handle. That is what makes every leg of the two-sequential-opens
 * test below a REAL open, in one process, with no `shutdownHashStore()` between them: the open path's
 * own shutdown is the only thing that ends the previous connection. A symlink is the platform's only
 * spelling of one file that survives `path.join`'s normalisation of `.`, `..` and repeated
 * separators — and the same spelling is asserted to resolve back to the store file itself.
 */
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

/**
 * Read the stamp off the FILE, through a connection of its own — never through the open path. It
 * reads the store of the current config dir, which `withStoreDir` pins for the test.
 */
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

/**
 * How many times the open ran the schema ensure of the snapshot tables. The sweep has TWO call sites
 * and both funnel through `ensureSnapshotTables`, so this is what proves the gate covered BOTH of them
 * rather than one of them being skipped by never being reached.
 */
function schemaEnsureSites(trace: StatementTrace): number {
  return trace.execs.filter((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS file_snapshots"))
    .length;
}

/**
 * Record every statement any connection issues, so a test can count the write-lock takers an open runs.
 * `exec`-level for the statements that take the lock through `exec`, plus a `prepare` COUNTER for the two
 * `meta` upserts (each is prepared where it is run, exactly once, so counting prepares counts writes).
 * What this cannot see is covered by the rival-lock test instead: no write statement can succeed while
 * that lock is held.
 */
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

/** Hold the store's write lock from a rival connection and return its release function. */
function holdWriteLock(): () => void {
  const holder = new DatabaseSync(hashStorePath(), { timeout: 0 });
  holder.exec("BEGIN IMMEDIATE");
  // WHY: make the transaction a real one — a write lock is what the open must not need, and an
  // WHY: empty transaction would let SQLite collapse it.
  holder.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("rival", "1");
  return () => {
    try {
      holder.exec("ROLLBACK");
    } finally {
      holder.close();
    }
  };
}

/** A current-generation snapshot plus one lineage row, the shape a real read materializes. */
function plantSnapshot(store: HashStore, path: string, content: string): void {
  upsertSnapshot(store, {
    path,
    snapshotHash: snapshotHashFor(content),
    lineCount: splitLines(content).length,
    hashes: contentOnlyHashes(content),
    content,
  });
}

/** A snapshot row of another generation: exactly what the sweep exists to remove. */
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

/**
 * The statement counts an open owed: what it wrote, and how many write locks it took to do it. They
 * ride the assertion MESSAGE, so a failure reports the observed counts rather than only the diff.
 */
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

/**
 * The test's own open hook, registered LAST — after every hook the imports above register — so an open
 * that fails or blocks here has already run all of the open's other work. Inert unless a test arms it.
 */
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
    // WHY: THE DISCRIMINATOR. The base build's open reaches the sweep's `BEGIN IMMEDIATE`, blocks on
    // WHY: the rival's write lock for its whole retry budget and throws `errcode 5` — so SUCCEEDING
    // WHY: here is a complete proof that the open took no write lock at all: SQLite cannot write
    // WHY: without it, and every write attempt would have thrown busy instead.
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
        // WHY: the no-write proof, localized: the open issued no `BEGIN IMMEDIATE` and no sweep
        // WHY: delete. The bound is not a performance claim — it separates "completed the open" from
        // WHY: "sat in the contention budget", which the base build's failure costs.
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
      // WHY: ONE sweep on a fresh store — the slow path runs once per open, not once per call site:
      // WHY: `buildStore`'s site sweeps and `buildStore` then stamps, so the hook's re-entrant ensure
      // WHY: finds a matching stamp and stops. The 2 deletes are the two that site can run: at that
      // WHY: point `served_leases` does not exist yet, so its two lease deletes are skipped
      // WHY: (`hasLeases`) — they are vacuous on a fresh store, which has no leases to drop.
      expect(firstTrace.beginImmediate).toBe(1);
      expect(firstTrace.sweepDeletes).toBe(2);
      // WHY: and BOTH call sites still ran their schema ensure — the gate is what skipped the second
      // WHY: sweep, not a missing second call.
      expect(schemaEnsureSites(firstTrace)).toBe(2);
      expectCurrentStamp();

      shutdownHashStore();
      const second = startTrace();
      await loadHashStore();
      const secondTrace = second.stop();
      // WHY: the fast path takes NO write lock and runs NO sweep at EITHER site: nothing of the sort
      // WHY: is issued, and the version upsert is skipped with them.
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
          db.exec(`UPDATE meta SET value = '2:1' WHERE key = '${STAMP_KEY}'`),
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
        // WHY: the slow path runs again — ONCE, at `buildStore`'s site: the stamp it writes at the end
        // WHY: of the build is what makes the hook's second ensure a no-op. All four sweep deletes run
        // WHY: there, because `served_leases` exists by then.
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
    // WHY: the registry is built by module top-level pushes, so the count is a function of the BUILD.
    // WHY: This rewrites the count the way a build registering one MORE hook would leave it: the next
    // WHY: open must take the slow path — that new hook's work is not certified by the old stamp — and
    // WHY: then re-stamp its own count. LIMITATION: a swap (one hook out, one in) keeps the count, which
    // WHY: is why `HASH_STORE_VERSION`'s bump convention still governs semantic changes.
    await withStoreDir(async () => {
      const store = await loadHashStore();
      plantForeignGenerationRow(store.db, "/poisoned.ts");
      const count = Number((readStamp().stamp as string).split(":")[4]);
      expect(Number.isInteger(count)).toBe(true);
      store.db.exec(
        `UPDATE meta SET value = '1:${HASH_STORE_VERSION}:${CANON_VERSION}:${ANCHOR_GENERATION}:${count + 1}' WHERE key = '${STAMP_KEY}'`,
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
    // WHY: the leading field exists so a future shape change invalidates every stamp written by the old
    // WHY: shape BY CONSTRUCTION. This is that claim, exercised: an unknown format takes the slow path.
    await withStoreDir(async () => {
      const store = await loadHashStore();
      plantForeignGenerationRow(store.db, "/poisoned.ts");
      const value = readStamp().stamp as string;
      store.db.exec(
        `UPDATE meta SET value = '0:${value.split(":").slice(1).join(":")}' WHERE key = '${STAMP_KEY}'`,
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
      expect(expectCurrentStamp()).toBe(value);
    });
  });

  it("a stale or future HASH_STORE_VERSION takes the slow path and is rewritten", async () => {
    // WHY: the schema half of the stamp IS `HASH_STORE_VERSION`, so any change to an owner's
    // WHY: schema-ensure or gated work that bumps it invalidates every stamp on disk. Both directions
    // WHY: are checked: a store older than this build and one written by a NEWER build that this one
    // WHY: must not trust.
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
    // WHY: the stamp is the store's record that the WHOLE slow path — DDL, migrations and sweep —
    // WHY: completed. Stamping before (or during) the sweep would make a failed sweep permanent, so
    // WHY: this is the RED-proof test for that ordering: force the sweep to throw and the stamp must
    // WHY: still be absent; restore it and the next open stamps.
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
      // WHY: `meta('version')` keeps its value, format and semantics — the stamp is a SECOND row.
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
    // WHY: the sweep is an upgrade/migration action now, not a per-open one: rows that a matching
    // WHY: stamp says nothing about — here a foreign-generation row planted after the sweep — are NOT
    // WHY: removed by a reopen. This is the deliberate trade (the store's provenance is unchanged, so
    // WHY: there is nothing to upgrade); the poison goes when the stamp moves.
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
  /**
   * THE RED PROOF: a hook that throws must leave NO stamp, because the stamp certifies the WHOLE open —
   * the build, the migrations, the sweep and every hook. Stamped before the hooks, that failure leaves a
   * valid-looking stamp over an unfinished store, and the next open takes the fast path over it.
   */
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

      // THE RED ASSERTION: neither half of the stamp survives a failed open. The `version` row the gate
      // also reads is NOT part of the stamp — the build writes it, before any hook runs.
      const failed = readStamp();
      expect(failed, `stamp after a throwing hook: ${JSON.stringify(failed)}`).toEqual({
        userVersion: 0,
        version: String(HASH_STORE_VERSION),
        stamp: undefined,
      });

      // The hooks' DDL is deliberately ungated — it ran, and it stays, which is what keeps the open
      // self-healing. Nothing here is gated by the stamp.
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

      // With no stamp the next open cannot take the fast path: it sweeps again as ONE `BEGIN IMMEDIATE`
      // and writes BOTH halves, so the store is stamped again.
      const trace = startTrace();
      await loadHashStore();
      const recorded = trace.stop();
      expect(recorded.beginImmediate).toBe(1);
      expect(recorded.sweepDeletes).toBe(4);
      expectCurrentStamp();
    });
  });

  /**
   * The move takes the stamp write out of `openDbWithBusyRetry`'s envelope, so the deferred write needs
   * a retry of its own. The write lock here is REAL and held across the hook phase by a child process; an
   * unwrapped write would reject with `errcode 5` here, i.e. it would fail an open that had already done
   * all of its work.
   */
  it("retries the deferred stamp write when the store is busy at the end of the open", async () => {
    await withStoreDir(async () => {
      const store = await loadHashStore();
      // The next open must OWE a stamp write, so it reaches the deferred step.
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

  /**
   * THE COUNTS: the move must not double the slow path's work. Read on a store whose stamp no longer
   * matches — the upgrade shape — where the sweep's own site runs ONCE (the hook's re-entrant ensure
   * consults the open's in-memory decision, not the row the open has not written yet) and the stamp is
   * written ONCE, whichever statement issues it.
   */
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
      // BOTH ensure sites still ran: the gate skipped the second sweep, a call was not skipped.
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
  /** Two expired mirror rows and one fresh one, the shape the TTL prune judges. */
  function plantMirrorRows(store: HashStore): { expired: string[]; fresh: string } {
    const now = Date.now();
    const insert = store.db.prepare(
      "INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?,?,?,?)",
    );
    for (const id of ["old-a", "old-b"])
      insert.run(id, `/gone/${id}.ts`, "[]", now - SERVED_TTL_MS - 1);
    insert.run("live", "/kept.ts", "[]", now);
    return { expired: ["old-a", "old-b"], fresh: "live" };
  }

  function mirrorSessions(db: DatabaseSync): string[] {
    return (
      db.prepare("SELECT session_id FROM served ORDER BY session_id").all() as unknown as {
        session_id: string;
      }[]
    ).map((row) => row.session_id);
  }

  it("a due prune deletes exactly the expired rows", async () => {
    // WHY: semantics preserved — the same predicate, the same rows: the prune still issues
    // WHY: `DELETE FROM served WHERE updated_at < ?` with the cutoff `now - SERVED_TTL_MS`, and the
    // WHY: existence read that guards it asks the SAME question with the SAME parameter.
    await withStoreDir(async () => {
      const store = await loadHashStore();
      const { expired, fresh } = plantMirrorRows(store);
      expect(expired).toHaveLength(2);
      shutdownHashStore();

      const reopened = await loadHashStore();
      expect(mirrorSessions(reopened.db)).toEqual([fresh]);
      // WHY: the run is recorded only when it actually ran, so the next open does not repeat it.
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
      // WHY: a fresh run stamp is the "already ran" state — the item must stay down.
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
          "SELECT COUNT(*) AS n FROM served WHERE updated_at < ?",
          Date.now() - SERVED_TTL_MS,
        ),
      ).toBe(2);

      // WHY: backdate the run stamp past the interval and the item is due again.
      notDue.db
        .prepare("UPDATE meta SET value = ? WHERE key = ?")
        .run(String(Date.now() - SERVED_PRUNE_INTERVAL_MS - 1), PRUNE_RUN_KEY);
      shutdownHashStore();
      const due = await loadHashStore();
      expect(mirrorSessions(due.db)).toEqual(["live"]);
    });
  });

  it("does not write the run stamp when there is nothing to prune", async () => {
    // WHY: the timestamp write is itself a write-lock taker, so it is owed only to a run that
    // WHY: deleted something — otherwise a due-but-empty prune would keep the fast path lock-free and
    // WHY: yet write.
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
 * #87c — TWO SEQUENTIAL OPENS IN ONE PROCESS, IN BOTH ORDERS, WITH THE SLOT THE HOOK PHASE READS.
 *
 * WHY this exists beside "sweeps once and writes the stamp once on the slow path": that test pins what
 * ONE open owes. This test pins the same contract PER LEG, across three real opens of ONE store in one
 * process and in BOTH orders — slow then fast, then fast then slow — quoting each leg's statement counts
 * (`BEGIN IMMEDIATE`, sweep DELETEs, meta upserts, header stamps).
 *
 * NOT A NOVELTY, and the paragraph this replaces claimed one: deleting `openStamp = stamp` reds THIS
 * test at leg 1 (`{beginImmediate: 2}` against `{beginImmediate: 1}`) AND reds SEVEN tests this file
 * ALREADY had, identically — "sweeps at both call sites on a fresh store…", "a mismatch in EITHER
 * stamp half…", "folds the open-hook count into the stamp…", "folds the stamp's FORMAT version in…",
 * "a stale or future HASH_STORE_VERSION…", "a hook that throws leaves no stamp…" and "sweeps once and
 * writes the stamp once on the slow path…". Measured on the file as it stood BEFORE this test was
 * added: 15 tests, 7 red under that one deletion. The property was already pinned; what this test adds
 * is the per-leg contract above, and that is worth having.
 *
 * THE LEGS ARE REAL OPENS OF ONE STORE, AND NO TEST-SIDE SHUTDOWN RUNS BETWEEN THEM. A second
 * `loadHashStore()` on an unchanged config path is served from the cache, so each leg reaches the
 * store through a different spelling of its path (`aliasStoreDir`, asserted below to resolve to the
 * same file). The open path's own shutdown is then the only thing that ends the previous connection —
 * which is also why the SLOT, not the handle, is what these counts pin.
 *
 * RED PROOF: remove `openStamp = stamp` (or move it after the hook loop) and leg 1 reds FIRST, on
 * `beginImmediate`: `{beginImmediate: 2, sweepDeletes: 6}` against this leg's `{beginImmediate: 1,
 * sweepDeletes: 2}` — with neither a slot nor a persisted stamp the hook's re-entrant ensure sweeps a
 * second time. Leg 1 ends the test, so the later legs' counts are never observed here; that same
 * mutation on a store which already holds `served_leases` doubles to 8 sweep DELETEs against 4 in
 * "sweeps once and writes the stamp once on the slow path". Its leg-1 failure is the same one the seven
 * tests listed above report, each in its own shape.
 *
 * THE SLOW AND FAST COUNTS RESTATE what "sweeps once and writes the stamp once on the slow path"
 * already asserts: the legs compare that same shape across open orders rather than a different one.
 */
describe("two sequential opens in one process (#87c)", () => {
  /**
   * What a store's FIRST open owes when there is no stamp: one `BEGIN IMMEDIATE` around the sweep, the
   * sweep's two DELETEs (a fresh build has no `served_leases` table yet, so its lease deletes are not
   * owed), the version and stamp `meta` upserts, and the header write.
   */
  const FIRST_OPEN_LEG = { beginImmediate: 1, sweepDeletes: 2, metaUpserts: 2, headerStamps: 1 };
  /**
   * What an open owes when its stamp does NOT match on a store that already has the lease table: the
   * same again plus the sweep's two `served_leases` deletes.
   */
  const SLOW_LEG = { beginImmediate: 1, sweepDeletes: 4, metaUpserts: 2, headerStamps: 1 };
  /** What an open owes when its stamp DOES match: nothing — the fast path takes no write lock. */
  const FAST_LEG = { beginImmediate: 0, sweepDeletes: 0, metaUpserts: 0, headerStamps: 0 };

  it("runs slow then fast, then fast then slow, on one store in one process", async () => {
    await withStoreDir(async (dir) => {
      const alias = await aliasStoreDir(dir);

      // LEG 1 — SLOW, the store's first open: no stamp, so the sweep's site runs once, the hook's
      // re-entrant ensure reads the slot instead of the unwritten row, and both halves are stamped.
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
      // The precondition every later leg rests on: the two spellings name ONE store file, not two.
      expect(await realpath(join(alias, "state", "hash-store.sqlite"))).toBe(
        await realpath(join(dir, "state", "hash-store.sqlite")),
      );

      // LEG 2 — the stamp leg 1 wrote matches, so the second open of the same store owes no statement.
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

      // LEG 3 — FAST THEN SLOW, on the same store: the header half is moved on leg 2's OWN connection,
      // outside any open (the slot was cleared when leg 2's hook phase ended). The next open must
      // notice, and the store still holds the lease table leg 1 built, so this sweep is the full one.
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
