/**
 * #87c — the fast path's integrity check: a read-only SQLite header smoke check instead of the
 * full `PRAGMA quick_check`, which walks every page of a DISPOSABLE cache whose remedy for damage is
 * quarantine-and-rebuild.
 *
 * The tests pin the replacement (a stamp-matching open prepares no `quick_check`, the slow path
 * still does), that damage is still refused, that healthy stores keep their rows, and that every
 * store file the FORMAT permits opens — refusing one would silently rebuild a healthy cache. The
 * header's magic and page-size fields are a second line of defence: SQLite has already refused the
 * files those fields guard, so the verdicts live at this file's seams are the length rule's and the
 * page-count rule's.
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
      const slow = await countQuickChecks(async () => {
        await loadHashStore();
      });
      shutdownHashStore();
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
      const observed =
        `pageSize=${pageSize} pageCount=${pageCount} bytes=${file.length} walBytes=${walBytes} ` +
        `quarantined=${JSON.stringify(await quarantined(dir))}`;
      expect(file.length, observed).toBe(pageSize * pageCount);
      expect(walBytes, observed).toBeGreaterThan(0);

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

describe("the smoke check's verdicts on the store files the format permits (#87c)", () => {
  it("refuses a zero page count, the format's derive-from-the-file signal, that SQLite reads cleanly", async () => {
    await withStoreDir(async (dir) => {
      await seedStampedStore();
      await damageHeader((header, file) => {
        header.writeUInt32BE(0, PAGE_COUNT_OFFSET);
        return Buffer.concat([header, file.subarray(HEADER_BYTES)]);
      });
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
      expect(engine?.derivedPageCount, observed).toBeGreaterThan(0);
      expect(engine?.stamp, observed).toBeTruthy();
      expect((await quarantined(dir)).length, observed).toBeGreaterThan(0);
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
        expect(walFile.length, observed).toBeGreaterThan(pageSize);
        expect(file.includes("/p900.ts"), observed).toBe(false);
        expect(walFile.includes("/p900.ts"), observed).toBe(true);
        expect(file.length, observed).toBe(pageSize * headerPageCount);
        const store = await loadHashStore();

        const state = `${observed} quarantined=${JSON.stringify(await quarantined(dir))}`;
        expect(await quarantined(dir), state).toHaveLength(0);
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
        const db = new DatabaseSync(path);
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
        expect(raw, observed).toBe(rawPageSize);
        expect(raw === 1 ? 65536 : raw, observed).toBe(vacuumPageSize);
        expect(await quarantined(dir), observed).toHaveLength(0);
        expect(getSnapshot(store, "/p0.ts", "x0\n"), observed).toEqual(["AAAA"]);
      });
    },
  );
});
