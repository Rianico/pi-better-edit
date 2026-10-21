/**
 * #90 — the store janitor: the throttle, the batched GC, and the periodic deep check.
 *
 * WHY this file exists: the open-time sweep is stamp-gated (`src/hash-store.ts`) and the fast path
 * runs no `PRAGMA quick_check` at all (#87c, PR #101), so a poisoned row and page-level damage could
 * both sit in a store that every open accepts. Ticket #90's answer is a PERIODIC item off the
 * tool-call path, and these tests pin each half of it refutably:
 * - THROTTLE: two runs inside the interval delete once, and a backdated record deletes again — with
 *   `now` injected, so the result does not depend on host load or on wall-clock drift.
 * - GC: a foreign-generation row and a terminal lease past the retirement grace go; a
 *   current-generation row, a live lease and a lease still inside the grace stay; the deletes arrive
 *   in statements bounded by the knob, not in one unbounded scan.
 * - EXCLUSION: ONE test asserts BOTH halves — the wiring subscribes exactly `session_start` and
 *   `session_shutdown` and runs the janitor on each, while across an open plus the write a
 *   `read`/`edit`/`undo_last_edit` call performs the janitor issues ZERO statements, prepares no
 *   `PRAGMA quick_check` and records no run. A positive-only assertion would prove the janitor RUNS,
 *   never that it is EXCLUDED, and exclusion is what protects tool-call latency.
 * - DEEP CHECK: damage the header smoke check accepts is detected (`isHealthy` false) and handed to
 *   the open path's own quarantine-and-rebuild, which is what closes #90's detection and healing
 *   clauses; #100's use-time trigger is NOT here, by design.
 * - CHECKPOINT: the janitor owns no checkpoint — the WAL it writes is truncated by the close path
 *   that already owns `wal_checkpoint(TRUNCATE)`.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  hashStorePath,
  isHealthy,
  loadHashStore,
  shutdownHashStore,
  type HashStore,
} from "../../src/hash-store";
import {
  JANITOR_EVENTS,
  JANITOR_META_KEY,
  janitorPass,
  registerJanitorHooks,
  runJanitor,
  type JanitorOutcome,
} from "../../src/store-janitor";
import { STORE_JANITOR_DEFAULTS, type StoreJanitorSettings } from "../../src/store-config";
import { VACUUM_RETIRED_PIN_MS } from "../../src/snapshot-store";
import { SERVED_TTL_MS } from "../../src/constants";
import { CANON_VERSION } from "../../src/hashline";
import { snapshotHashFor, upsertSnapshot } from "../../src/snapshot-store";
import { initHasher } from "../../src/hashline/hasher";
import { getWritableTempRoot } from "../support/fixtures";

beforeAll(async () => {
  await initHasher();
});

/** The knobs one test runs with: a real interval, a small batch, injected clock. */
const SETTINGS: StoreJanitorSettings = {
  mode: STORE_JANITOR_DEFAULTS.mode,
  intervalMs: 60_000,
  batchSize: 64,
};
/** The instant the throttle is judged at — injected, so no assertion here reads a real clock. */
const NOW = 1_700_000_000_000;

/** A store dir of this test's own, published under the env var `configDir()` reads verbatim. */
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

function countRows(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/** A snapshot row of ANOTHER generation: exactly what the GC exists to remove. */
function plantForeignSnapshot(db: DatabaseSync, path: string): number {
  const row = db
    .prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) " +
        "VALUES (?,?,?,?,1,?) RETURNING snapshot_id",
    )
    .get(path, `${CANON_VERSION}:999:foreign`, 3, NOW, 999) as { snapshot_id: number };
  db.prepare(
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?,?,?,?,?)",
  ).run(row.snapshot_id, 0, 987_654, "deadbeefdeadbeef", "zzz1");
  return row.snapshot_id;
}

/** A current-generation snapshot, the shape a real read materializes. */
function plantCurrentSnapshot(store: HashStore, path: string, content: string): string {
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

function plantLease(
  db: DatabaseSync,
  input: {
    path: string;
    anchor: string;
    servedSnapshotHash: string;
    retiredAt: number | null;
    updatedAt?: number;
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
    input.updatedAt ?? NOW,
    input.retiredAt,
  );
}

interface JanitorTrace {
  /** Every statement shaped like the janitor's bounded delete, in order. */
  readonly janitorDeletes: string[];
  /** Every `PRAGMA quick_check` prepared — the deep check's only statement. */
  readonly quickChecks: number;
  /** Every DELETE any connection issued, so the open path's own statements can be reported. */
  readonly allDeletes: string[];
}

/**
 * Record every statement any connection prepares or execs, so a test can count the janitor's own
 * statements and the deep check's. Same instrument shape as `hash-store-open-stamp.test.ts`
 * (`exec` + `prepare` patched, restored in `finally`), narrowed to what this file asserts.
 */
function startTrace(): { stop: () => JanitorTrace } {
  // SAFETY: patching the built-in's prototype for the duration of one test, exactly as
  // SAFETY: `hash-store-open-stamp.test.ts` does; the narrow cast only names the two members used.
  const proto = DatabaseSync.prototype as unknown as {
    exec: (sql: string) => unknown;
    prepare: (sql: string) => unknown;
  };
  const originalExec = proto.exec;
  const originalPrepare = proto.prepare;
  const janitorDeletes: string[] = [];
  const allDeletes: string[] = [];
  let quickChecks = 0;
  const record = (raw: string): void => {
    const flat = raw.replace(/\s+/g, " ").trim();
    if (flat.startsWith("DELETE FROM ")) allDeletes.push(flat);
    if (/^DELETE FROM \w+ WHERE rowid IN \(SELECT rowid FROM/.test(flat)) {
      janitorDeletes.push(flat);
    }
  };
  proto.exec = function (sql: string) {
    record(sql);
    return originalExec.call(this, sql);
  };
  proto.prepare = function (sql: string) {
    record(sql);
    if (/^PRAGMA quick_check/i.test(sql)) quickChecks += 1;
    return originalPrepare.call(this, sql);
  };
  return {
    stop: () => {
      proto.exec = originalExec;
      proto.prepare = originalPrepare;
      return { janitorDeletes, quickChecks, allDeletes };
    },
  };
}

function janitorStatusOf(outcome: JanitorOutcome): string {
  return `ran=${outcome.ran} reason=${outcome.reason ?? "-"} deleted=${JSON.stringify(outcome.deleted)}`;
}

describe("the janitor's throttle", () => {
  it("runs the sweep once inside the interval, and records that run under its own meta key", async () => {
    await withStoreDir("pi-janitor-throttle-", async () => {
      const db = (await loadHashStore()).db;
      plantForeignSnapshot(db, "/foreign-1.ts");

      const first = runJanitor({ db, now: NOW, settings: SETTINGS });
      expect(janitorStatusOf(first)).toBe(
        `ran=true reason=- deleted={"snapshots":1,"lineage":0,"leases":0,"expiredLeases":0}`,
      );
      expect(db.prepare("SELECT value FROM meta WHERE key = ?").get(JANITOR_META_KEY)).toEqual({
        value: String(NOW),
      });
    });
  });

  it("removes nothing on a second run inside the window, and sweeps again once the record is backdated", async () => {
    await withStoreDir("pi-janitor-window-", async () => {
      const db = (await loadHashStore()).db;
      plantForeignSnapshot(db, "/foreign-1.ts");
      runJanitor({ db, now: NOW, settings: SETTINGS });

      plantForeignSnapshot(db, "/foreign-2.ts");
      const trace = startTrace();
      const second = janitorPass({
        now: NOW + SETTINGS.intervalMs - 1,
        settings: SETTINGS,
        db,
        cwd: ".",
      });
      const observed = trace.stop();
      expect(await second).toMatchObject({ ran: false, reason: "throttled" });
      expect(observed.janitorDeletes).toEqual([]);
      expect(observed.quickChecks).toBe(0);
      expect(
        countRows(db, "SELECT count(*) n FROM file_snapshots WHERE anchor_generation != 1"),
      ).toBe(1);

      db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(
        String(NOW - SETTINGS.intervalMs),
        JANITOR_META_KEY,
      );
      const third = runJanitor({ db, now: NOW, settings: SETTINGS });
      expect(third.deleted.snapshots).toBe(1);
      expect(
        countRows(db, "SELECT count(*) n FROM file_snapshots WHERE anchor_generation != 1"),
      ).toBe(0);
    });
  });
});

describe("the janitor's GC", () => {
  it("removes foreign-generation rows and keeps the current generation", async () => {
    await withStoreDir("pi-janitor-generation-", async () => {
      const store = await loadHashStore();
      const currentHash = plantCurrentSnapshot(store, "/current.ts", "a\nb\nc\n");
      const foreignId = plantForeignSnapshot(store.db, "/foreign.ts");
      plantLease(store.db, {
        path: "/foreign.ts",
        anchor: "zzz2",
        servedSnapshotHash: `${CANON_VERSION}:999:foreign`,
        retiredAt: null,
      });
      plantLease(store.db, {
        path: "/current.ts",
        anchor: "aaaa",
        servedSnapshotHash: currentHash,
        retiredAt: null,
      });

      const outcome = runJanitor({ db: store.db, now: NOW, settings: SETTINGS });
      expect(outcome.deleted.snapshots).toBe(1);
      expect(
        countRows(
          store.db,
          "SELECT count(*) n FROM file_snapshots WHERE snapshot_id = ?",
          foreignId,
        ),
      ).toBe(0);
      expect(
        countRows(store.db, "SELECT count(*) n FROM line_lineage WHERE snapshot_id = ?", foreignId),
      ).toBe(0);
      // The current-generation rows and the lease that names them survive untouched; the lease that
      // named the foreign generation went with it.
      expect(countRows(store.db, "SELECT count(*) n FROM file_snapshots")).toBe(1);
      expect(
        countRows(
          store.db,
          "SELECT count(*) n FROM served_leases WHERE served_snapshot_hash = ?",
          `${CANON_VERSION}:999:foreign`,
        ),
      ).toBe(0);
      expect(
        countRows(
          store.db,
          "SELECT count(*) n FROM served_leases WHERE served_snapshot_hash = ?",
          currentHash,
        ),
      ).toBe(1);
    });
  });

  it("deletes in statements bounded by the batch knob rather than in one unbounded scan", async () => {
    await withStoreDir("pi-janitor-batch-", async () => {
      const db = (await loadHashStore()).db;
      for (let i = 0; i < 5; i++) plantForeignSnapshot(db, `/foreign-${i}.ts`);

      const trace = startTrace();
      const outcome = runJanitor({ db, now: NOW, settings: { ...SETTINGS, batchSize: 2 } });
      const observed = trace.stop();

      expect(outcome.deleted.snapshots).toBe(5);
      const snapshotBatches = observed.janitorDeletes.filter((sql) =>
        sql.startsWith("DELETE FROM file_snapshots"),
      );
      expect(snapshotBatches).toHaveLength(3);
      expect(snapshotBatches.every((sql) => sql.endsWith("LIMIT ?)"))).toBe(true);
    });
  });

  it("removes terminal and TTL-expired leases, keeping live ones and both boundaries", async () => {
    await withStoreDir("pi-janitor-grace-", async () => {
      const store = await loadHashStore();
      const live = plantCurrentSnapshot(store, "/live.ts", "x\n");
      plantLease(store.db, {
        path: "/live.ts",
        anchor: "aaaa",
        servedSnapshotHash: live,
        retiredAt: null,
      });
      plantLease(store.db, {
        path: "/live.ts",
        anchor: "bbbb",
        servedSnapshotHash: live,
        retiredAt: NOW - VACUUM_RETIRED_PIN_MS + 1,
      });
      plantLease(store.db, {
        path: "/live.ts",
        anchor: "cccc",
        servedSnapshotHash: live,
        retiredAt: NOW - VACUUM_RETIRED_PIN_MS - 1,
      });
      // #160: an ACTIVE lease past the session TTL is expired authority and is removed too.
      plantLease(store.db, {
        path: "/live.ts",
        anchor: "dddd",
        servedSnapshotHash: live,
        retiredAt: null,
        updatedAt: NOW - SERVED_TTL_MS - 1,
      });
      // Exactly at the TTL is still inside the boundary (ADR-0045) and survives.
      plantLease(store.db, {
        path: "/live.ts",
        anchor: "eeee",
        servedSnapshotHash: live,
        retiredAt: null,
        updatedAt: NOW - SERVED_TTL_MS,
      });

      const outcome = runJanitor({ db: store.db, now: NOW, settings: SETTINGS });
      expect(outcome.deleted.expiredLeases).toBe(2);
      const surviving = store.db
        .prepare("SELECT anchor FROM served_leases ORDER BY anchor")
        .all() as { anchor: string }[];
      expect(surviving.map((row) => row.anchor)).toEqual(["aaaa", "bbbb", "eeee"]);
    });
  });

  it("removes a lineage row orphaned by an interrupted write", async () => {
    await withStoreDir("pi-janitor-orphan-", async () => {
      const db = (await loadHashStore()).db;
      // WHY the FK is off for this insert: an orphan is exactly a row with no snapshot, which the
      // cascade cannot produce — a crash between a snapshot delete and its lineage delete can.
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare(
        "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?,?,?,?,?)",
      ).run(424_242, 0, 1, "beef", "zzzz");
      db.exec("PRAGMA foreign_keys = ON");

      const outcome = runJanitor({ db, now: NOW, settings: SETTINGS });
      expect(outcome.deleted.lineage).toBe(1);
      expect(
        countRows(db, "SELECT count(*) n FROM line_lineage WHERE snapshot_id = ?", 424_242),
      ).toBe(0);
    });
  });

  it("does not open the store at all in mode off", async () => {
    await withStoreDir("pi-janitor-off-", async (dir) => {
      const outcome = await janitorPass({
        cwd: ".",
        settings: { ...SETTINGS, mode: "off" },
      });
      expect(outcome).toMatchObject({ ran: false, reason: "off" });
      expect(existsSync(join(dir, "hash-store.sqlite"))).toBe(false);
    });
  });
});

/**
 * The EXCLUSION invariant, both halves in ONE test: the wiring subscribes the janitor to the two
 * off-hot-path lifecycle events (and to no hot-path event), and a tool-call open plus the write it
 * performs issues no janitor statement at all. Split into two files, the positive half alone would
 * prove only that the janitor RUNS, never that it is EXCLUDED — so a drift between the halves has to
 * fail ONE test rather than quietly leave both green.
 */
describe("the exclusion invariant", () => {
  /** The event names the extension API exposes that a maintenance pass must never ride on. */
  const HOT_PATH_EVENTS = [
    "tool_call",
    "tool_result",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "context",
    "before_provider_request",
  ];
  /** What the injected pass answers: an ordinary run that found nothing. */
  const RUN: JanitorOutcome = {
    ran: true,
    deleted: { snapshots: 0, lineage: 0, leases: 0, expiredLeases: 0 },
    deepCheckFailed: false,
    rebuilt: false,
  };

  it("wires the janitor to the off-hot-path events and executes no janitor statement across an open and a write", async () => {
    // Half 1 — the WIRING: exactly the two lifecycle events are subscribed, each handler runs the
    // janitor, and no hot-path event is subscribed at all.
    const subscriptions: Array<{ event: string; handler: () => Promise<void> }> = [];
    const pi = {
      on(event: string, handler: () => Promise<void>) {
        subscriptions.push({ event, handler });
      },
    };
    const run = vi.fn(async () => RUN);
    registerJanitorHooks(pi as never, { runJanitor: run });

    expect(subscriptions.map((entry) => entry.event)).toEqual([...JANITOR_EVENTS]);
    for (const forbidden of HOT_PATH_EVENTS) {
      expect(subscriptions.some((entry) => entry.event === forbidden)).toBe(false);
    }
    for (const { handler } of subscriptions) await handler();
    expect(run).toHaveBeenCalledTimes(subscriptions.length);
    expect(subscriptions.length).toBeGreaterThan(0);

    // Half 2 — the EXCLUSION, measured on the open a real tool call performs.
    await withStoreDir("pi-janitor-hotpath-", async () => {
      // The store is seeded, stamped and closed OUTSIDE the trace, so what is traced is the FAST open
      // a read/edit call performs — not the slow one a brand-new store pays by design.
      const seeded = await loadHashStore();
      plantCurrentSnapshot(seeded, "/edited.ts", "one\ntwo\n");
      shutdownHashStore();

      const trace = startTrace();
      const store = await loadHashStore();
      plantCurrentSnapshot(store, "/edited.ts", "one\ntwo\nthree\n");
      shutdownHashStore();
      const observed = trace.stop();

      expect(observed.janitorDeletes).toEqual([]);
      // WHY 0 here and 1 on a brand-new store: the fast path runs no `PRAGMA quick_check` at all
      // (#87c) — the deep check the janitor owns is the only periodic one, and it is not here.
      expect(observed.quickChecks).toBe(0);
      // The open path's OWN statements, reported so a reader can see what remains and why: the
      // throttle-gated served-mirror prune (#87c) deletes by `updated_at`, never by generation, and
      // the stamp-gated generation sweep is skipped entirely on a stamp-matching open.
      console.log(
        `[janitor-hotpath] open-path deletes: ${observed.allDeletes.length} ` +
          `[${observed.allDeletes.join(" | ")}]; janitor deletes: ${observed.janitorDeletes.length}; ` +
          `quick_check prepares: ${observed.quickChecks}`,
      );
      // The throttle row is the janitor's own trace left in the store: an open never writes it.
      const db = new DatabaseSync(hashStorePath(), { readOnly: true });
      try {
        expect(
          db.prepare("SELECT value FROM meta WHERE key = ?").get(JANITOR_META_KEY),
        ).toBeUndefined();
      } finally {
        db.close();
      }
    });
  });
});

describe("the periodic deep check", () => {
  /**
   * Zero one 4 KiB page in the middle of the store file. The file's LENGTH is untouched, so the
   * header smoke check the fast path runs still accepts the store — which is exactly the damage class
   * the janitor's deep pass exists for.
   */
  async function damagePage(path: string, page: number): Promise<void> {
    const pageSize = statSync(path).size >= 4096 ? 4096 : 512;
    const handle = await open(path, "r+");
    try {
      const zeros = Buffer.alloc(pageSize);
      await handle.write(zeros, 0, pageSize, page * pageSize);
    } finally {
      await handle.close();
    }
  }

  it("detects damage the fast path accepts and hands the store to the open path's recovery", async () => {
    await withStoreDir("pi-janitor-deep-", async (dir) => {
      const store = await loadHashStore();
      // A lineage b-tree with its own pages, so a mid-file page is lineage storage rather than a page
      // the open's own hooks have to read.
      const lines = Array.from({ length: 4_000 }, (_value, index) => `l${index}`).join("\n");
      plantCurrentSnapshot(store, "/big.ts", lines);
      shutdownHashStore();

      await damagePage(hashStorePath(), 20);

      const reopened = await loadHashStore();
      expect(isHealthy(reopened.db)).toBe(false);

      const outcome = await janitorPass({
        now: NOW,
        settings: SETTINGS,
        db: reopened.db,
        cwd: ".",
      });
      expect(outcome.deepCheckFailed).toBe(true);
      expect(outcome.rebuilt).toBe(true);
      const quarantined = (await readdir(dir)).filter((name) => name.includes(".corrupt-"));
      expect(quarantined.length).toBeGreaterThan(0);

      // The recovery is the open path's: the rebuilt store is open, empty and writable.
      const rebuilt = await loadHashStore();
      expect(countRows(rebuilt.db, "SELECT count(*) n FROM file_snapshots")).toBe(0);
      expect(isHealthy(rebuilt.db)).toBe(true);
    });
  });

  it("leaves the healed store reachable through the open the next tool call performs", async () => {
    await withStoreDir("pi-janitor-after-", async () => {
      const store = await loadHashStore();
      plantForeignSnapshot(store.db, "/foreign.ts");
      const outcome = await janitorPass({ now: NOW, settings: SETTINGS, db: store.db, cwd: "." });
      expect(outcome.deepCheckFailed).toBe(false);
      expect(outcome.rebuilt).toBe(false);
      // Nothing was quarantined and the same connection is still the cached one.
      const again = await loadHashStore();
      expect(again.db).toBe(store.db);
    });
  });
});

describe("the WAL checkpoint's single owner", () => {
  it("leaves the WAL to the close path, measured", async () => {
    await withStoreDir("pi-janitor-wal-", async () => {
      const db = (await loadHashStore()).db;
      for (let i = 0; i < 40; i++) plantForeignSnapshot(db, `/foreign-${i}.ts`);
      const walPath = `${hashStorePath()}-wal`;

      runJanitor({ db, now: NOW, settings: SETTINGS });
      const afterJanitor = existsSync(walPath) ? statSync(walPath).size : 0;
      shutdownHashStore();
      const afterClose = existsSync(walPath) ? statSync(walPath).size : 0;

      // The numbers, printed: the report quotes this run's raw before/after WAL sizes.
      console.log(
        `[janitor-wal] after the janitor run: ${afterJanitor} bytes; after close: ${afterClose} bytes`,
      );
      expect(afterJanitor).toBeGreaterThan(0);
      expect(afterClose).toBe(0);
      expect(existsSync(walPath)).toBe(false);
    });
  });
});
