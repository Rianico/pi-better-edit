/**
 * #100 — the USE-TIME corruption quarantine trigger: the first statement that fails with a
 * corruption error quarantines and rebuilds the store, instead of leaving the damage for the
 * next open or the janitor's periodic deep check.
 *
 * WHY this file exists: the open path accepts a store whose header is intact (the #87c smoke
 * check) and the janitor deep-checks only at lifecycle boundaries, so damage inside page 2+
 * sits live until something touches it. The guarded handle makes that first touch the trigger:
 * it arms exactly one heal — shutdown, `quarantineStore`, reopen — and rethrows the ORIGINAL
 * error, so the failure stays loud and no success is ever synthesized.
 *
 * WHAT THE TESTS PIN, and why each is refutable:
 * - The REPRO itself: a stamped store with a corrupted table root still opens (the probe table
 *   survives the open, so no rebuild happened there), then the first statement touching the
 *   damage throws the engine's own `SQLITE_CORRUPT`, exactly one `.corrupt-*` lands beside the
 *   store, and the next access is fresh (the probe table is gone, the rebuilt store is empty).
 *   The damage is proved engine-visible first, from a copy, so the test cannot pass on damage
 *   SQLite would read cleanly.
 * - The double-heal race: two statements failing before the heal completes arm exactly ONE
 *   quarantine, and BOTH callers still hear the original corruption error rather than a
 *   teardown artifact.
 * - The invariance: syntax, constraint, busy and closed-handle failures never quarantine and
 *   leave the store intact — the discriminator decides, not the guard. The closed-handle case
 *   doubles as the stale-handle rule: a pre-heal proxy wraps a closed db, so reusing it after a
 *   heal must fail closed, never heal again.
 */
import { describe, expect, it, vi } from "vitest";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  hashStorePath,
  isCorruptionError,
  loadHashStore,
  shutdownHashStore,
} from "../../src/hash-store";
import { getWritableTempRoot } from "../support/fixtures";

/** SQLite's page-size field lives at this header offset (big-endian UInt16). */
const PAGE_SIZE_OFFSET = 16;

/** Enough wide rows that the probe table spans many pages. */
const PROBE_ROWS = 500;

/** The extension root this test owns, published under the env var `stateRoot()` reads; the store
 * lives in its `state/` subdirectory. */
async function withStoreDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), "pi-usetime-"));
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
 * Quarantine files of the store database itself. The `-wal`/`-shm` renames may or may not exist
 * beside it, so the count that must read exactly one filters on the database file's own name.
 */
async function quarantinedMain(dir: string): Promise<string[]> {
  // WHY the state subdir: the override names the extension's root, the store lives in `<root>/state`.
  const names = await readdir(join(dir, "state"));
  return names.filter((name) => name.startsWith("hash-store.sqlite.corrupt-"));
}

/** A stamped store carrying a multi-page `probe` table, closed so every row sits in the file. */
async function seedProbeStore(): Promise<void> {
  const store = await loadHashStore();
  store.db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
  const insert = store.db.prepare("INSERT INTO probe (payload) VALUES (?)");
  for (let i = 0; i < PROBE_ROWS; i++) insert.run("x".repeat(200));
  shutdownHashStore();
}

/** A stamped store carrying a small `probe` table, left open for the invariance cases. */
async function seedLightProbe(): Promise<Awaited<ReturnType<typeof loadHashStore>>> {
  const store = await loadHashStore();
  store.db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
  const insert = store.db.prepare("INSERT INTO probe (payload) VALUES (?)");
  for (let i = 0; i < 5; i++) insert.run(`row${i}`);
  return store;
}

/**
 * Corrupt the `probe` table's root page-type byte — damage the fast path's 100-byte header read
 * cannot see, on a page every `probe` statement must walk. The root page is read off the live
 * schema rather than assumed, so the damage cannot miss its table.
 */
async function corruptProbeRoot(): Promise<void> {
  const path = hashStorePath();
  const reader = new DatabaseSync(path);
  let rootpage = 0;
  try {
    const row = reader.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'probe'").get() as
      | { rootpage?: unknown }
      | undefined;
    if (typeof row?.rootpage === "number") rootpage = row.rootpage;
  } finally {
    reader.close();
  }
  expect(rootpage).toBeGreaterThanOrEqual(2);
  const file = await readFile(path);
  const pageSize = file.readUInt16BE(PAGE_SIZE_OFFSET);
  file[(rootpage - 1) * pageSize] = 0x00;
  await writeFile(path, file);
}

/**
 * Ask SQLITE ITSELF about the damaged bytes, from a COPY in a scratch dir of its own — the
 * guard-honesty pattern from the #87c smoke-check file. `undefined` means the engine read the
 * damage cleanly, which would make the trigger test below vacuous.
 */
async function engineVerdictOnProbe(): Promise<unknown> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), "pi-usetime-engine-"));
  const copy = join(dir, "hash-store.sqlite");
  try {
    await copyFile(hashStorePath(), copy);
    const db = new DatabaseSync(copy);
    try {
      db.prepare("SELECT count(*) FROM probe").get();
      return undefined;
    } catch (error) {
      return error;
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function probeRowCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS n FROM probe").get() as { n: number };
  return row.n;
}

describe("use-time corruption quarantine (#100)", () => {
  it("quarantines on the first failing statement, rethrows loudly, and the next access is fresh", async () => {
    await withStoreDir(async (dir) => {
      await seedProbeStore();
      await corruptProbeRoot();
      // The engine itself refuses these bytes at statement time ...
      const verdict = (await engineVerdictOnProbe()) as { errcode?: unknown } | undefined;
      expect(verdict?.errcode).toBe(11);
      // ... yet the stamped open still takes the fast path over them: the probe table survives
      // the open, so no rebuild happened there.
      const store = await loadHashStore();
      expect(
        store.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'probe'").get(),
      ).toBeDefined();
      let thrown: unknown;
      try {
        store.db.prepare("SELECT count(*) FROM probe").get();
      } catch (error) {
        thrown = error;
      }
      expect(isCorruptionError(thrown)).toBe(true);
      expect((thrown as { errcode?: unknown })?.errcode).toBe(11);
      // The statement above armed the heal; joining it is what makes this access fresh.
      const fresh = await loadHashStore();
      expect(await quarantinedMain(dir)).toHaveLength(1);
      expect(
        fresh.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'probe'").get(),
      ).toBeUndefined();
      expect(
        (fresh.db.prepare("SELECT count(*) AS n FROM snapshots").get() as { n: number }).n,
      ).toBe(0);
    });
  });

  it("two interleaved corruptions heal exactly once and both callers hear the original error", async () => {
    await withStoreDir(async (dir) => {
      await seedProbeStore();
      await corruptProbeRoot();
      const store = await loadHashStore();
      const first = store.db.prepare("SELECT count(*) FROM probe");
      const second = store.db.prepare("SELECT count(*) FROM probe");
      const failures: unknown[] = [];
      for (const statement of [first, second]) {
        try {
          statement.get();
        } catch (error) {
          failures.push(error);
        }
      }
      expect(failures).toHaveLength(2);
      for (const failure of failures) expect(isCorruptionError(failure)).toBe(true);
      await loadHashStore();
      expect(await quarantinedMain(dir)).toHaveLength(1);
    });
  });

  it("a syntax failure never quarantines and leaves the store intact", async () => {
    await withStoreDir(async (dir) => {
      const store = await seedLightProbe();
      expect(() => store.db.prepare("SELECT * FROM missing_table_xyz").get()).toThrow(
        /no such table/,
      );
      expect(() => store.db.exec("THIS IS NOT SQL")).toThrow(/syntax error/);
      expect(await quarantinedMain(dir)).toHaveLength(0);
      expect(probeRowCount(store.db)).toBe(5);
    });
  });

  it("a constraint failure never quarantines and leaves the store intact", async () => {
    await withStoreDir(async (dir) => {
      const store = await seedLightProbe();
      store.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("q", "1");
      let thrown: unknown;
      try {
        store.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("q", "1");
      } catch (error) {
        thrown = error;
      }
      expect(String((thrown as Error | undefined)?.message)).toMatch(/constraint/i);
      expect(isCorruptionError(thrown)).toBe(false);
      expect(await quarantinedMain(dir)).toHaveLength(0);
      expect(probeRowCount(store.db)).toBe(5);
    });
  });

  it("a busy failure never quarantines and leaves the store intact", async () => {
    await withStoreDir(async (dir) => {
      const store = await seedLightProbe();
      const rival = new DatabaseSync(hashStorePath());
      try {
        rival.exec("BEGIN IMMEDIATE");
        rival.prepare("INSERT INTO probe (payload) VALUES (?)").run("rival");
        let thrown: unknown;
        try {
          store.db.prepare("INSERT INTO probe (payload) VALUES (?)").run("store");
        } catch (error) {
          thrown = error;
        }
        expect((thrown as { errcode?: unknown })?.errcode).toBe(5);
        expect(isCorruptionError(thrown)).toBe(false);
      } finally {
        try {
          rival.exec("ROLLBACK");
        } catch {
          // The lock is already released; the rollback is best-effort cleanup.
        }
        rival.close();
      }
      expect(await quarantinedMain(dir)).toHaveLength(0);
      store.db.prepare("INSERT INTO probe (payload) VALUES (?)").run("after");
      expect(probeRowCount(store.db)).toBe(6);
    });
  });

  it("a stale handle on a closed store never quarantines", async () => {
    await withStoreDir(async (dir) => {
      const store = await loadHashStore();
      const stale = store.db;
      shutdownHashStore();
      let thrown: unknown;
      try {
        stale.prepare("SELECT 1").get();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect(isCorruptionError(thrown)).toBe(false);
      expect(await quarantinedMain(dir)).toHaveLength(0);
      // The store itself reopens fine afterwards — failing closed cost nothing.
      const reopened = await loadHashStore();
      expect(reopened.db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
    });
  });
});
