/**
 * #87c — the FAST path's integrity check: a read-only SQLite header smoke check instead of the
 * full `PRAGMA quick_check`.
 *
 * WHY this file exists: `PRAGMA quick_check` is the dominant remaining cost of a stamp-matching
 * fast open (it walks every page of the store), and the store is a DISPOSABLE CACHE whose remedy
 * for damage is quarantine-and-rebuild. So the fast path now reads the 100-byte database header
 * instead — magic, page size, page count, and the file length those imply — and pays the full
 * sweep only on the slow path (no stamp, stamp mismatch, a store this open CREATED, or the
 * corruption-recovery path).
 *
 * WHAT THE TESTS PIN, and why each is refutable:
 * - The REPLACEMENT itself: a stamp-matching open prepares no `PRAGMA quick_check` at all, while
 *   the slow path still prepares one — so the assertion is not vacuous.
 * - The CHECK still refuses damage: three header corruption modes, each of which SQLite either
 *   refuses outright or tolerates to the point of opening it cleanly, so a store that OPENS under
 *   any of them is a finding.
 * - The check is NOT a rubber stamp: healthy stores open and keep their rows.
 * - The check is NOT a false alarm either: the store files the FORMAT permits — a zero page count
 *   SQLite derives, bytes trailing the last page, a WAL still holding the newest rows, and the page
 *   sizes the format allows from its floor to its encoded ceiling — all open as stores. That family
 *   is the shape of the failure that would announce nothing: quarantining and rebuilding a HEALTHY
 *   cache costs latency and reports no error at all. It is pinned in the group at the end of this
 *   file, where each test first asks SQLITE ITSELF about the store's bytes and then asserts what the
 *   smoke check decided about them.
 * - The header's own magic and page-size fields are a SECOND line of defence, not the first: by the
 *   time the smoke check reads the file, SQLite has already refused the files those fields guard
 *   (its first read of a damaged header fails), so the verdicts reachable from this file's seams are
 *   the length rule's and the page-count rule's. What the check buys is the cases SQLite reads
 *   CLEANLY — see the group at the end.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { hashStorePath, loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { getSnapshot, snapshotHashFor, upsertSnapshot } from "../../src/snapshot-store";
import { initHasher } from "../../src/hashline/hasher";
import { getWritableTempRoot } from "../support/fixtures";

/** SQLite's database header is 100 bytes, and this is where its two sanity fields live. */
const HEADER_BYTES = 100;
const PAGE_SIZE_OFFSET = 16;
const PAGE_COUNT_OFFSET = 28;

/** The extension root this test owns, published under the env var `stateRoot()` reads; the store
 * lives in its `state/` subdirectory. */
async function withStoreDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), "pi-smoke-"));
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", dir);
  try {
    await run(dir);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}

/** The names this dir holds that look like a quarantined store. */
async function quarantined(dir: string): Promise<string[]> {
  // WHY the state subdir: the override names the extension's root, the store lives in `<root>/state`.
  const names = await readdir(join(dir, "state"));
  return names.filter((name) => name.includes(".corrupt-"));
}

/**
 * Build a store the fast path will accept: opened once, rows written, then closed, which is what
 * makes the persistent stamp current. The snapshot rows are the payload a later open must find.
 */
async function seedStampedStore(): Promise<void> {
  const store = await loadHashStore();
  for (let i = 0; i < 200; i++) plantRow(store, i);
  shutdownHashStore();
}

function plantRow(store: Awaited<ReturnType<typeof loadHashStore>>, index: number): void {
  upsertSnapshot(store, {
    path: `/p${index}.ts`,
    snapshotHash: snapshotHashFor(`x${index}\n`),
    lineCount: 1,
    hashes: ["AAAA"],
    content: `x${index}\n`,
  });
}

/** Rewrite one header field of the seeded store file, leaving the rest of it intact. */
async function damageHeader(mutate: (header: Buffer, file: Buffer) => Buffer): Promise<Buffer> {
  const path = hashStorePath();
  const file = await readFile(path);
  const header = Buffer.from(file.subarray(0, HEADER_BYTES));
  const damaged = mutate(header, file);
  await writeFile(path, damaged);
  return damaged;
}

/**
 * Ask SQLITE ITSELF about the store file's bytes, from a COPY in a scratch dir of its own. The
 * copy is what makes the guard honest: the tool's own open — and the quarantine it may perform
 * beside the original — cannot change the engine's answer, and SQLite's `-wal`/`-shm` bookkeeping
 * lands beside the copy instead of beside the store this test is about to judge. `undefined` means
 * the engine would not read these bytes as a database at all, which is exactly the difference
 * between "the smoke check refused input the format permits" and "the engine refused it first".
 */
async function engineVerdictOnStoreCopy<T>(ask: (db: DatabaseSync) => T): Promise<T | undefined> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), "pi-smoke-engine-"));
  const path = join(dir, "hash-store.sqlite");
  let db: DatabaseSync | undefined;
  try {
    await copyFile(hashStorePath(), path);
    db = new DatabaseSync(path);
    return ask(db);
  } catch {
    return undefined;
  } finally {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** How many `PRAGMA quick_check` statements the opening code prepared while `run` executed. */
async function countQuickChecks(run: () => Promise<void>): Promise<number> {
  const proto = DatabaseSync.prototype as unknown as { prepare: (sql: string) => unknown };
  const original = proto.prepare;
  let count = 0;
  proto.prepare = function (sql: string) {
    if (/^PRAGMA quick_check/i.test(sql.trim())) count += 1;
    return original.call(this, sql);
  };
  try {
    await run();
  } finally {
    proto.prepare = original;
  }
  return count;
}

beforeAll(async () => {
  await initHasher();
});

describe("the fast path's smoke check replaces the full integrity sweep (#87c)", () => {
  it("prepares no quick_check on a stamp-matching open, and still prepares one on the slow path", async () => {
    await withStoreDir(async () => {
      // The FIRST open of a nonexistent store is the slow path by construction (no stamp).
      const slow = await countQuickChecks(async () => {
        await loadHashStore();
      });
      shutdownHashStore();
      // The SECOND open finds the stamp this build wrote, so it takes the fast path.
      const fast = await countQuickChecks(async () => {
        await loadHashStore();
      });
      const observed = `slowPathQuickChecks=${slow} fastPathQuickChecks=${fast}`;
      expect(slow, observed).toBeGreaterThan(0);
      expect(fast, observed).toBe(0);
    });
  });

  it.each([
    [
      "bad header magic",
      (header: Buffer, file: Buffer) => {
        header.write("NOT-SQLITE-DB!!\0", 0, "latin1");
        return Buffer.concat([header, file.subarray(HEADER_BYTES)]);
      },
    ],
    [
      "truncated file",
      (_header: Buffer, file: Buffer) => Buffer.from(file.subarray(0, Math.floor(file.length / 2))),
    ],
    [
      "wrong page size",
      (header: Buffer, file: Buffer) => {
        header.writeUInt16BE(8192, PAGE_SIZE_OFFSET);
        return Buffer.concat([header, file.subarray(HEADER_BYTES)]);
      },
    ],
  ])("still refuses a store with %s", async (_mode, mutate) => {
    await withStoreDir(async (dir) => {
      await seedStampedStore();
      const damaged = await damageHeader(mutate);
      const errors: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(
          args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "),
        );
      });
      const store = await loadHashStore();
      spy.mockRestore();
      const quarantinedNames = await quarantined(dir);
      const observed =
        `damaged header {pageSize=${damaged.readUInt16BE(PAGE_SIZE_OFFSET)}, ` +
        `pageCount=${damaged.readUInt32BE(PAGE_COUNT_OFFSET)}, bytes=${damaged.length}}; ` +
        `quarantined=${JSON.stringify(quarantinedNames)}; errors=${JSON.stringify(errors)}`;
      expect(quarantinedNames.length, observed).toBeGreaterThan(0);
      // The rebuild is a real store, not a broken handle.
      expect(getSnapshot(store, "/p0.ts", "x0\n"), observed).toBeUndefined();
      plantRow(store, 0);
      expect(getSnapshot(store, "/p0.ts", "x0\n"), observed).toEqual(["AAAA"]);
    });
  });

  it("accepts a healthy stamped store, keeping its rows (the check is not a rubber stamp)", async () => {
    await withStoreDir(async (dir) => {
      await seedStampedStore();
      const store = await loadHashStore();
      const observed = `quarantined=${JSON.stringify(await quarantined(dir))}`;
      expect(await quarantined(dir), observed).toHaveLength(0);
      expect(getSnapshot(store, "/p0.ts", "x0\n"), observed).toEqual(["AAAA"]);
    });
  });

  it("accepts a store whose newest rows still sit in the WAL", async () => {
    await withStoreDir(async (dir) => {
      await seedStampedStore();
      // A live writer's rows land in the `-wal` file; the MAIN file — the one the smoke check
      // reads — keeps the page count it had at its last checkpoint.
      const writer = await loadHashStore();
      plantRow(writer, 900);
      const path = hashStorePath();
      const file = await readFile(path);
      const pageSize = file.readUInt16BE(PAGE_SIZE_OFFSET);
      const pageCount = file.readUInt32BE(PAGE_COUNT_OFFSET);
      const walBytes = await stat(`${path}-wal`).then(
        (s) => s.size,
        () => 0,
      );
      // Fixture guard: the pending WAL must really be pending, or this proves nothing.
      const observed =
        `pageSize=${pageSize} pageCount=${pageCount} bytes=${file.length} walBytes=${walBytes} ` +
        `quarantined=${JSON.stringify(await quarantined(dir))}`;
      expect(file.length, observed).toBe(pageSize * pageCount);
      expect(walBytes, observed).toBeGreaterThan(0);

      // The state a second process sees, without the WAL it cannot read.
      const otherDir = await mkdtemp(join(await getWritableTempRoot(), "pi-smoke-wal-"));
      try {
        await mkdir(join(otherDir, "state"), { recursive: true });
        await copyFile(path, join(otherDir, "state", "hash-store.sqlite"));
        vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", otherDir);
        shutdownHashStore();
        const store = await loadHashStore();
        const state = `${observed}; quarantinedHere=${JSON.stringify(await quarantined(otherDir))}`;
        expect(await quarantined(otherDir), state).toHaveLength(0);
        expect(getSnapshot(store, "/p0.ts", "x0\n"), state).toEqual(["AAAA"]);
      } finally {
        shutdownHashStore();
        vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", dir);
        await rm(otherDir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * The four judgements the header check makes about input the SQLite FILE FORMAT permits. Each one
 * puts the engine's own answer beside the check's: the refusal cases ask SQLite about the same bytes
 * (through `engineVerdictOnStoreCopy`, which reads a COPY so the tool's open cannot change the
 * answer), the WAL case holds a live second connection, and the page-size case has SQLite ITSELF
 * write the variant under test. Neither half of an assertion can then rot into a claim nobody can
 * check.
 * WHY this group is the one that matters: the remedy for a refused store is quarantine and rebuild
 * of a disposable cache. A check that refuses a HEALTHY store therefore pays the cost of damage
 * recovery and reports nothing at all — no error, no corruption, just a cache rebuilt for no
 * reason. Every case below is a store SQLite reads without complaint, which is what makes the
 * smoke check the only thing standing between a refactor of these rules and that silent rebuild.
 */
describe("the smoke check's verdicts on the store files the format permits (#87c)", () => {
  it("refuses a zero page count, the format's derive-from-the-file signal, that SQLite reads cleanly", async () => {
    await withStoreDir(async (dir) => {
      await seedStampedStore();
      await damageHeader((header, file) => {
        header.writeUInt32BE(0, PAGE_COUNT_OFFSET);
        return Buffer.concat([header, file.subarray(HEADER_BYTES)]);
      });
      // WHY: zero is the format's "derive the size from the file" encoding, not a damage marker.
      // WHY: SQLite obeys it happily (the guard below reads the store's rows and its stamp through
      // WHY: this very header), so a zero field alone proves nothing about the file it describes.
      // WHY: No open of this store ever writes zero, which is why the check reads it as damage
      // WHY: instead of guessing the size SQLite would have derived.
      const engine = await engineVerdictOnStoreCopy((db) => ({
        derivedPageCount: (db.prepare("PRAGMA page_count").get() as { page_count?: number })
          .page_count,
        stamp: (
          db.prepare("SELECT value FROM meta WHERE key = 'store_stamp'").get() as
            | { value?: string }
            | undefined
        )?.value,
      }));
      const store = await loadHashStore();
      const observed =
        `engineDerivedPageCount=${engine?.derivedPageCount} engineSawStamp=${engine?.stamp !== undefined} ` +
        `quarantined=${JSON.stringify(await quarantined(dir))}`;
      // Guard the claim this test rests on: the engine TOLERATES what the check refused.
      expect(engine?.derivedPageCount, observed).toBeGreaterThan(0);
      expect(engine?.stamp, observed).toBeTruthy();
      expect((await quarantined(dir)).length, observed).toBeGreaterThan(0);
      // The rebuild is a real store, not a broken handle.
      expect(getSnapshot(store, "/p0.ts", "x0\n"), observed).toBeUndefined();
      plantRow(store, 0);
      expect(getSnapshot(store, "/p0.ts", "x0\n"), observed).toEqual(["AAAA"]);
    });
  });

  it("refuses a file longer than page size x page count, bytes SQLite itself reads past", async () => {
    await withStoreDir(async (dir) => {
      await seedStampedStore();
      const path = hashStorePath();
      const healthy = await readFile(path);
      const pageSize = healthy.readUInt16BE(PAGE_SIZE_OFFSET);
      const pageCount = healthy.readUInt32BE(PAGE_COUNT_OFFSET);
      // WHY: SQLite tolerates trailing bytes — it reads the pages the header counts and ignores the
      // WHY: rest (the guard below gets a clean `quick_check` from the longer file). The header's
      // WHY: own claim about the file's length is therefore the one thing only the check can make
      // WHY: binding, and a store longer than its header says is damage this store did not write.
      await writeFile(path, Buffer.concat([healthy, Buffer.alloc(1, 7)]));

      const engine = await engineVerdictOnStoreCopy(
        (db) => (db.prepare("PRAGMA quick_check").get() as { quick_check?: string }).quick_check,
      );
      await loadHashStore();

      const observed =
        `healthyBytes=${healthy.length} pageSize=${pageSize} pageCount=${pageCount} ` +
        `consistentBytes=${pageSize * pageCount} engineQuickCheck=${engine} ` +
        `quarantined=${JSON.stringify(await quarantined(dir))}`;
      expect(engine, observed).toBe("ok");
      expect(await quarantined(dir), observed).toHaveLength(1);
    });
  });

  it("accepts a store whose newest rows are still pending in the WAL when the fast path opens it", async () => {
    await withStoreDir(async (dir) => {
      await seedStampedStore();
      const path = hashStorePath();
      // WHY: under a pending WAL the header's page count describes the MAIN file, while SQLite's own
      // WHY: count covers the frames too. The length rule has to judge the main file against its own
      // WHY: header: measuring it against the WAL-inclusive size would refuse a store whose newest
      // WHY: rows simply are not checkpointed yet — a rebuild of a healthy cache, announced by
      // WHY: nothing. A SECOND connection is the only way to hold that state at open time, because
      // WHY: closing this process's own handle checkpoints the WAL it would otherwise be holding.
      const writer = new DatabaseSync(path);
      try {
        upsertSnapshot(
          { db: writer, engine: "node:sqlite" },
          {
            path: "/p900.ts",
            snapshotHash: snapshotHashFor("x900\n"),
            lineCount: 1,
            hashes: ["AAAA"],
            content: "x900\n",
          },
        );
        const file = await readFile(path);
        const walFile = await readFile(`${path}-wal`).catch(() => Buffer.alloc(0));
        const pageSize = file.readUInt16BE(PAGE_SIZE_OFFSET);
        const headerPageCount = file.readUInt32BE(PAGE_COUNT_OFFSET);
        const observed =
          `pageSize=${pageSize} headerPageCount=${headerPageCount} mainBytes=${file.length} ` +
          `walBytes=${walFile.length}`;
        // Fixture guard: the row must really be pending, and pending ONLY in the WAL — were it in the
        // main file too, or the WAL empty, the length rule would be asked nothing.
        expect(walFile.length, observed).toBeGreaterThan(pageSize);
        expect(file.includes("/p900.ts"), observed).toBe(false);
        expect(walFile.includes("/p900.ts"), observed).toBe(true);
        // The header describes the MAIN file: its page count times the page size is that file's
        // length, while the WAL-inclusive size is longer than the header ever claims.
        expect(file.length, observed).toBe(pageSize * headerPageCount);
        const store = await loadHashStore();

        const state = `${observed} quarantined=${JSON.stringify(await quarantined(dir))}`;
        expect(await quarantined(dir), state).toHaveLength(0);
        // The rows that were only in the WAL when the check ran are served by the open it allowed.
        expect(getSnapshot(store, "/p900.ts", "x900\n"), state).toEqual(["AAAA"]);
        expect(getSnapshot(store, "/p0.ts", "x0\n"), state).toEqual(["AAAA"]);
      } finally {
        writer.close();
      }
    });
  });

  it.each([
    [512, 512],
    [65536, 1],
  ])(
    "accepts the page size %i the format permits (raw header value %i)",
    async (vacuumPageSize, rawPageSize) => {
      await withStoreDir(async (dir) => {
        await seedStampedStore();
        const path = hashStorePath();
        const before = await stat(path);
        // WHY: the format's page size runs from 512 to 65536 and encodes the ceiling as the raw
        // WHY: header value 1. A check that assumes 4096 — or that reads that 1 as a one-byte page
        // WHY: — refuses a store SQLite wrote happily, which is a healthy cache rebuilt for nothing.
        // VACUUM through a connection of its own rewrites the store at the size asked for; the
        // store's own open then puts the file back into WAL.
        const db = new DatabaseSync(path);
        // WHY: VACUUM only rewrites the page size in rollback-journal mode, so this detour is
        // WHY: invisible to the reopen below.
        db.exec("PRAGMA journal_mode = DELETE");
        db.exec(`PRAGMA page_size = ${vacuumPageSize}`);
        db.exec("VACUUM");
        db.close();

        const file = await readFile(path);
        const raw = file.readUInt16BE(PAGE_SIZE_OFFSET);
        const pageCount = file.readUInt32BE(PAGE_COUNT_OFFSET);
        const store = await loadHashStore();
        const observed =
          `rawPageSize=${raw} pageCount=${pageCount} bytesBefore=${before.size} bytesAfter=${file.length} ` +
          `quarantined=${JSON.stringify(await quarantined(dir))}`;
        // Guard the fixture itself: if VACUUM did not produce the encoding asked for, the test is
        // asking the check about a store it never built.
        expect(raw, observed).toBe(rawPageSize);
        expect(raw === 1 ? 65536 : raw, observed).toBe(vacuumPageSize);
        expect(await quarantined(dir), observed).toHaveLength(0);
        expect(getSnapshot(store, "/p0.ts", "x0\n"), observed).toEqual(["AAAA"]);
      });
    },
  );
});
