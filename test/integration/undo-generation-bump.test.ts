import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ensureSnapshotTables,
  hashStorePath,
  loadHashStore,
  shutdownHashStore,
  type HashStore,
} from "../../src/hash-store.js";
import { getUndoEntry, readUndo, upsertUndo } from "../../src/undo-store.js";
import { saveUndo } from "../../src/edit-undo.js";
import {
  ANCHOR_GENERATION,
  CANON_VERSION,
  canonDigest,
  contentOnlyHashes,
  fileHashesFor,
} from "../../src/hashline/hash-identity.js";
import { contentChecksum } from "../../src/hashline/hasher.js";
import { servedHashEchoDenial } from "../../src/write-hook.js";
import { resolveTarget } from "../../src/fs-write.js";
import { toCwd } from "../../src/paths.js";
import {
  VACUUM_RETIRED_PIN_MS,
  adoptPinnedSnapshotFor,
  anchorsForSnapshotHash,
  getSnapshot,
  isCurrentAnchorGeneration,
  snapshotHashFor,
  vacuumSnapshots,
} from "../../src/snapshot-store";
import {
  getText,
  setupIntegrationTest,
  testSessionManager,
  withTempFile,
  clearDiagnostics,
  readDiagnostics,
} from "../support/fixtures";

const PRE = "aaa\nbbb\nccc\n";
const POST = "aaa\nBBB\nccc\n";

function rows(text: string): { hash: string; text: string }[] {
  const out: { hash: string; text: string }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z0-9]{4})│(.*)$/);
    if (m) out.push({ hash: m[1]!, text: m[2]! });
  }
  return out;
}

/**
 * (#87c) Move the store's open stamp the way a real provenance change does, so the NEXT sweep runs.
 * The sweep's trigger is a stamp mismatch now: an open whose stamp already matches swept when it wrote
 * that stamp, so it has nothing left to do and skips it (see the trap-(c) test in
 * `test/core/hash-store-open-stamp.test.ts`). A test cannot bump `ANCHOR_GENERATION`, so it moves the
 * stamp instead — which is exactly what a released pre-stamp build leaves behind.
 */
function moveStoreStamp(db: HashStore["db"]): void {
  db.exec("PRAGMA user_version = 0");
}

/** (#87c) Sweep in place through the schema-ensure seam, with the stamp moved first. */
function sweepNow(db: HashStore["db"]): void {
  moveStoreStamp(db);
  ensureSnapshotTables(db);
}

async function plantLegacyRow(absPath: string): Promise<void> {
  const store = await loadHashStore();
  upsertUndo(store, absPath, {
    content: PRE,
    bom: "",
    ending: "\n",
    hashes: contentOnlyHashes(PRE),
    resultContent: POST,
    snapshotHash: null,
  });
  store.db.exec(
    "UPDATE file_undo SET anchor_generation = 0 WHERE path = '" + absPath.replace(/'/g, "''") + "'",
  );
}

/** Snapshot + lineage + leases + mirror a pre-bump build leaves behind (v2 key, content-only anchors). */
function plantV2File(store: HashStore, absPath: string, content: string): string[] {
  const v2 = contentOnlyHashes(content);
  const v2key = `2:${contentChecksum(content)}`;
  const session = testSessionManager.getSessionId();
  const info = store.db
    .prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) VALUES (?,?,?,?,1)",
    )
    .run(absPath, v2key, v2.length, Date.now());
  const sid = Number((info as { lastInsertRowid: number | bigint }).lastInsertRowid);
  const insLine = store.db.prepare(
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?,?,?,?,?)",
  );
  const insLease = store.db.prepare(
    "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, served_snapshot_hash, served_line_number, updated_at, retired_at) VALUES (?,?,?,?,?,?,?,?,NULL)",
  );
  const lines = content.split("\n");
  for (let i = 0; i < v2.length; i++) {
    insLine.run(sid, i + 1, i + 1, canonDigest(lines[i] ?? ""), v2[i]);
    insLease.run(
      session,
      absPath,
      v2[i],
      i + 1,
      canonDigest(lines[i] ?? ""),
      v2key,
      i + 1,
      Date.now(),
    );
  }
  store.db
    .prepare(
      "INSERT INTO served_session_meta (session_id, file_path, hashes, updated_at) VALUES (?,?,?,?) " +
        "ON CONFLICT(session_id,file_path) DO UPDATE SET hashes=excluded.hashes",
    )
    .run(session, absPath, JSON.stringify(v2), Date.now());
  return v2;
}

/** Snapshot row as the pre-fix build wrote it: current-shaped 3-part key, no generation stamped (DEFAULT 0). */
function plantPoisonSnapshot(store: HashStore, absPath: string, content: string): void {
  const hashes = contentOnlyHashes(content);
  store.db
    .prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) VALUES (?,?,?,?,1)",
    )
    .run(absPath, snapshotHashFor(content), hashes.length, Date.now());
  const sid = store.db
    .prepare(
      "SELECT snapshot_id FROM file_snapshots WHERE path = ? ORDER BY snapshot_id DESC LIMIT 1",
    )
    .get(absPath) as { snapshot_id: number };
  const insLine = store.db.prepare(
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?,?,?,?,?)",
  );
  const lines = content.split("\n");
  for (let i = 0; i < hashes.length; i++) {
    insLine.run(sid.snapshot_id, i + 1, i + 1, canonDigest(lines[i] ?? ""), hashes[i]);
  }
}

/** Snapshot + lineage row under an explicit foreign-generation key. */
function plantSnapshotRow(store: HashStore, absPath: string, key: string, hashes: string[]): void {
  store.db
    .prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) VALUES (?,?,?,?,1)",
    )
    .run(absPath, key, hashes.length, Date.now());
  const sid = store.db
    .prepare(
      "SELECT snapshot_id FROM file_snapshots WHERE path = ? ORDER BY snapshot_id DESC LIMIT 1",
    )
    .get(absPath) as { snapshot_id: number };
  const insLine = store.db.prepare(
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?,?,?,?,?)",
  );
  for (let i = 0; i < hashes.length; i++) {
    insLine.run(sid.snapshot_id, i + 1, i + 1, canonDigest(""), hashes[i]);
  }
}

beforeAll(() => {
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", "");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("generation bump refuses pre-v3 anchors", () => {
  it("a legacy undo row restores file-scoped anchors and refuses use from another file", async () => {
    await withTempFile("a.txt", POST, async ({ cwd }) => {
      const absA = join(cwd, "a.txt");
      const absB = join(cwd, "b.txt");
      await writeFile(absB, POST, "utf-8");
      await plantLegacyRow(absA);
      await plantLegacyRow(absB);
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      const editTool = getTool("edit");
      const undo = getTool("undo_last_edit");

      await undo.execute("u1", { path: "a.txt" }, undefined, undefined, ctx);
      await undo.execute("u2", { path: "b.txt" }, undefined, undefined, ctx);
      expect(await readFile(absA, "utf-8")).toBe(PRE);
      expect(await readFile(absB, "utf-8")).toBe(PRE);

      const aRows = rows(
        getText(await readTool.execute("r1", { file: "a.txt" }, undefined, undefined, ctx)),
      );
      const bRows = rows(
        getText(await readTool.execute("r2", { file: "b.txt" }, undefined, undefined, ctx)),
      );
      const expectedA = await fileHashesFor(absA, PRE);
      const expectedB = await fileHashesFor(absB, PRE);
      expect(aRows.map((r) => r.hash)).toEqual(expectedA);
      expect(bRows.map((r) => r.hash)).toEqual(expectedB);
      expect(aRows.map((r) => r.hash)).not.toEqual(contentOnlyHashes(PRE));
      const inter = new Set(aRows.map((r) => r.hash));
      let overlap = 0;
      for (const r of bRows) if (inter.has(r.hash)) overlap++;
      expect(overlap).toBe(0);
      await expect(
        editTool.execute(
          "e1",
          {
            file: "b.txt",
            edits: [{ anchor_from: aRows[1]!.hash, anchor_to: aRows[1]!.hash, text: "CROSS" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_FOREIGN_ANCHOR/);
      expect(await readFile(absB, "utf-8")).toBe(PRE);
    });
  });

  it("a pinned foreign-generation descriptor is rejected and writes nothing", async () => {
    await withTempFile("p.txt", PRE, async ({ cwd }) => {
      const absP = join(cwd, "p.txt");
      await expect(
        adoptPinnedSnapshotFor({
          path: absP,
          snapshotHash: "2:deadbeef",
          lineCount: 3,
          hashes: contentOnlyHashes(PRE),
          content: PRE,
        }),
      ).rejects.toThrow(/E_INTERNAL_INVARIANT/);
      expect(await anchorsForSnapshotHash(absP, "2:deadbeef")).toBeUndefined();
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      const served = rows(
        getText(await readTool.execute("r1", { file: "p.txt" }, undefined, undefined, ctx)),
      );
      expect(served.map((r) => r.hash)).toEqual(await fileHashesFor(absP, PRE));
    });
  });

  it("pre-bump leases are refused cold and after a fresh read", async () => {
    await withTempFile("a.txt", PRE, async ({ cwd }) => {
      const absA = join(cwd, "a.txt");
      const absB = join(cwd, "b.txt");
      await writeFile(absB, PRE, "utf-8");
      const store = await loadHashStore();
      const v2A = plantV2File(store, absA, PRE);
      plantV2File(store, absB, PRE);
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      const editTool = getTool("edit");
      const submit = (anchor: string): Promise<unknown> =>
        editTool.execute(
          "e1",
          { file: "b.txt", edits: [{ anchor_from: anchor, anchor_to: anchor, text: "REVIVED" }] },
          undefined,
          undefined,
          ctx,
        );
      await expect(submit(v2A[1]!)).rejects.toThrow(/E_FOREIGN_ANCHOR/);
      expect(await readFile(absB, "utf-8")).toBe(PRE);
      const servedB = rows(
        getText(await readTool.execute("r2", { file: "b.txt" }, undefined, undefined, ctx)),
      ).map((r) => r.hash);
      expect(servedB).toEqual(await fileHashesFor(absB, PRE));
      await expect(submit(v2A[1]!)).rejects.toThrow(/E_FOREIGN_ANCHOR/);
      expect(await readFile(absB, "utf-8")).toBe(PRE);
      const ok = (await editTool.execute(
        "e2",
        {
          file: "b.txt",
          edits: [{ anchor_from: servedB[1]!, anchor_to: servedB[1]!, text: "REVIVED" }],
        },
        undefined,
        undefined,
        ctx,
      )) as { isError?: boolean };
      expect(ok.isError).not.toBe(true);
      expect(await readFile(absB, "utf-8")).toBe("aaa\nREVIVED\nccc\n");
    });
  });

  it("a poisoned current-generation snapshot is not served and is swept", async () => {
    await withTempFile("a.txt", PRE, async ({ cwd }) => {
      const absA = join(cwd, "a.txt");
      const absB = join(cwd, "b.txt");
      await writeFile(absB, PRE, "utf-8");
      const store = await loadHashStore();
      plantPoisonSnapshot(store, absA, PRE);
      plantPoisonSnapshot(store, absB, PRE);
      expect(getSnapshot(store, absA, PRE)).toBeUndefined();
      expect(await anchorsForSnapshotHash(absA, snapshotHashFor(PRE))).toBeUndefined();
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      const editTool = getTool("edit");
      const servedA = rows(
        getText(await readTool.execute("r1", { file: "a.txt" }, undefined, undefined, ctx)),
      ).map((r) => r.hash);
      const expectedA = await fileHashesFor(absA, PRE);
      expect(servedA).toEqual(expectedA);
      expect(servedA).not.toEqual(contentOnlyHashes(PRE));
      await expect(
        editTool.execute(
          "e1",
          {
            file: "b.txt",
            edits: [{ anchor_from: servedA[1]!, anchor_to: servedA[1]!, text: "PWNED" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_FOREIGN_ANCHOR/);
      expect(await readFile(absB, "utf-8")).toBe(PRE);
      sweepNow(store.db);
      const left = store.db
        .prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?")
        .get(absA) as { n: number };
      expect(left.n).toBe(1);
      const lineageLeft = store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id NOT IN (SELECT snapshot_id FROM file_snapshots)",
        )
        .get() as { n: number };
      expect(lineageLeft.n).toBe(0);
    });
  });

  it("planted foreign-generation snapshot rows miss the lookups", async () => {
    await withTempFile("m.txt", PRE, async ({ cwd }) => {
      const absM = join(cwd, "m.txt");
      const store = await loadHashStore();
      const v2key = `2:${contentChecksum(PRE)}`;
      plantSnapshotRow(store, absM, v2key, contentOnlyHashes(PRE));
      expect(getSnapshot(store, absM, PRE)).toBeUndefined();
      expect(await anchorsForSnapshotHash(absM, v2key)).toBeUndefined();
    });
  });

  it("a served mirror survives a store reopen and the resumed edit writes", async () => {
    await withTempFile("r.txt", PRE, async ({ cwd }) => {
      const absR = join(cwd, "r.txt");
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      const editTool = getTool("edit");
      const served = rows(
        getText(await readTool.execute("r1", { file: "r.txt" }, undefined, undefined, ctx)),
      );
      const store = await loadHashStore();
      const mirrorBefore = store.db
        .prepare("SELECT epoch_id FROM served_session_meta WHERE file_path = ?")
        .get(absR) as { epoch_id: string | null } | undefined;
      expect(mirrorBefore?.epoch_id).toMatch(/^v2\|/);
      shutdownHashStore();
      await loadHashStore();
      const reopened = await loadHashStore();
      const mirrorAfter = reopened.db
        .prepare("SELECT epoch_id FROM served_session_meta WHERE file_path = ?")
        .get(absR) as { epoch_id: string | null } | undefined;
      expect(mirrorAfter?.epoch_id).toBe(mirrorBefore?.epoch_id);
      const ok = (await editTool.execute(
        "e1",
        {
          file: "r.txt",
          edits: [{ anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, text: "RESUMED" }],
        },
        undefined,
        undefined,
        ctx,
      )) as { isError?: boolean };
      expect(ok.isError).not.toBe(true);
      expect(await readFile(absR, "utf-8")).toBe("aaa\nRESUMED\nccc\n");
    });
  });

  it("the served-hash-echo write guard still refuses across a restart", async () => {
    await withTempFile("g.txt", PRE, async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      const served = rows(
        getText(await readTool.execute("r1", { file: "g.txt" }, undefined, undefined, ctx)),
      );
      const payload = served.map((r) => `${r.hash}│${r.text}`).join("\n") + "\n";
      const io = {
        resolve: async (rawPath: string, cwdPath: string) => resolveTarget(toCwd(rawPath, cwdPath)),
      };
      const sessionKey = testSessionManager.getSessionId();
      const sameProcess = await servedHashEchoDenial(io, "g.txt", payload, cwd, sessionKey);
      expect(sameProcess).toMatch(/E_SUSPICIOUS_TEXT/);
      shutdownHashStore();
      await loadHashStore();
      const afterRestart = await servedHashEchoDenial(io, "g.txt", payload, cwd, sessionKey);
      expect(afterRestart).toMatch(/E_SUSPICIOUS_TEXT/);
    });
  });

  it("a swept pre-bump lease is refused cold as unknown", async () => {
    await withTempFile("a.txt", PRE, async ({ cwd }) => {
      const absA = join(cwd, "a.txt");
      const absB = join(cwd, "b.txt");
      await writeFile(absB, PRE, "utf-8");
      const store = await loadHashStore();
      const v2A = plantV2File(store, absA, PRE);
      plantV2File(store, absB, PRE);
      moveStoreStamp(store.db);
      shutdownHashStore();
      await loadHashStore();
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("edit");
      await expect(
        editTool.execute(
          "e1",
          {
            file: "b.txt",
            edits: [{ anchor_from: v2A[1]!, anchor_to: v2A[1]!, text: "REVIVED" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_UNKNOWN_ANCHOR/);
      expect(await readFile(absB, "utf-8")).toBe(PRE);
    });
  });

  it("the open-time sweep leaves no lease naming a missing snapshot", async () => {
    await withTempFile("i.txt", PRE, async ({ cwd }) => {
      const absI = join(cwd, "i.txt");
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "i.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      const liveBefore = (
        store.db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }
      ).n;
      expect(liveBefore).toBeGreaterThan(0);
      const OTHER = "ddd\neee\nfff\n";
      plantPoisonSnapshot(store, absI, OTHER);
      const poisonKey = snapshotHashFor(OTHER);
      const poisonAnchors = contentOnlyHashes(OTHER);
      const session = testSessionManager.getSessionId();
      const insPoisonLease = store.db.prepare(
        "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, served_snapshot_hash, served_line_number, updated_at, retired_at) VALUES (?,?,?,?,?,?,?,?,NULL)",
      );
      const postLines = OTHER.split("\n");
      for (let i = 0; i < poisonAnchors.length; i++) {
        insPoisonLease.run(
          session,
          absI,
          poisonAnchors[i],
          100 + i,
          canonDigest(postLines[i] ?? ""),
          poisonKey,
          i + 1,
          Date.now(),
        );
      }
      plantV2File(store, absI, PRE);
      store.db
        .prepare(
          "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) VALUES (?,?,?,?,1,2)",
        )
        .run(absI, `2:${contentChecksum(OTHER)}`, 3, Date.now());
      const checkInvariant = (db: HashStore["db"]): void => {
        const dangling = db
          .prepare(
            "SELECT COUNT(*) AS n FROM served_leases sl WHERE NOT EXISTS " +
              "(SELECT 1 FROM file_snapshots fs WHERE fs.path = sl.file_path " +
              "AND fs.snapshot_hash = sl.served_snapshot_hash)",
          )
          .get() as { n: number };
        expect(dangling.n).toBe(0);
        const unretiredLineless = db
          .prepare(
            "SELECT COUNT(*) AS n FROM served_leases sl WHERE sl.retired_at IS NULL AND NOT EXISTS " +
              "(SELECT 1 FROM file_snapshots fs JOIN line_lineage ll ON ll.snapshot_id = fs.snapshot_id " +
              "AND ll.anchor = sl.anchor WHERE fs.snapshot_hash = sl.served_snapshot_hash)",
          )
          .get() as { n: number };
        expect(unretiredLineless.n).toBe(0);
      };
      sweepNow(store.db);
      checkInvariant(store.db);
      const liveKey = snapshotHashFor(PRE);
      const liveSurvivors = (
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM served_leases WHERE served_snapshot_hash = ? AND retired_at IS NULL",
          )
          .get(liveKey) as { n: number }
      ).n;
      expect(liveSurvivors).toBeGreaterThan(0);
      shutdownHashStore();
      await loadHashStore();
      const reopened = await loadHashStore();
      checkInvariant(reopened.db);
    });
  });

  it("a retired-past-grace lease dangles only until the next open's sweep", async () => {
    await withTempFile("h.txt", PRE, async ({ cwd }) => {
      const absH = join(cwd, "h.txt");
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "h.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      const liveKey = snapshotHashFor(PRE);
      const liveLeases = (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM served_leases WHERE served_snapshot_hash = ?")
          .get(liveKey) as { n: number }
      ).n;
      expect(liveLeases).toBeGreaterThan(0);
      const now = Date.now();
      store.db
        .prepare("UPDATE served_leases SET retired_at = ?, updated_at = ? WHERE file_path = ?")
        .run(now - 2 * VACUUM_RETIRED_PIN_MS, now, absH);
      store.db.prepare("DELETE FROM file_undo WHERE path = ?").run(absH);
      const OTHER = "ddd\neee\nfff\n";
      for (let i = 0; i < 14; i++) {
        plantSnapshotRow(store, absH, `3:forged-${i}`, contentOnlyHashes(OTHER));
      }
      vacuumSnapshots(store.db);
      const liveRows = (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE snapshot_hash = ?")
          .get(liveKey) as { n: number }
      ).n;
      expect(liveRows).toBe(0);
      const grantMiss = store.db
        .prepare(
          "SELECT snapshot_id FROM file_snapshots WHERE path = ? AND snapshot_hash = ? " +
            "AND committed = 1 AND anchor_generation = ?",
        )
        .get(absH, liveKey, ANCHOR_GENERATION) as { snapshot_id: number } | undefined;
      expect(grantMiss).toBeUndefined();
      const stranded = (
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM served_leases sl WHERE NOT EXISTS " +
              "(SELECT 1 FROM file_snapshots fs WHERE fs.path = sl.file_path " +
              "AND fs.snapshot_hash = sl.served_snapshot_hash)",
          )
          .get() as { n: number }
      ).n;
      expect(stranded).toBe(liveLeases);
      sweepNow(store.db);
      const healed = (
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM served_leases sl WHERE NOT EXISTS " +
              "(SELECT 1 FROM file_snapshots fs WHERE fs.path = sl.file_path " +
              "AND fs.snapshot_hash = sl.served_snapshot_hash)",
          )
          .get() as { n: number }
      ).n;
      expect(healed).toBe(0);
    });
  });

  it("a lease naming a hash that survives only in a foreign path's row is swept", async () => {
    await withTempFile("f.txt", PRE, async ({ cwd }) => {
      const absF = join(cwd, "f.txt");
      const ghostAbs = join(cwd, "ghost.txt");
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "f.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      const liveKey = snapshotHashFor(PRE);
      const ghostRows = (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?")
          .get(ghostAbs) as { n: number }
      ).n;
      expect(ghostRows).toBe(0);
      const session = testSessionManager.getSessionId();
      store.db
        .prepare(
          "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, " +
            "served_snapshot_hash, served_line_number, updated_at, retired_at) " +
            "VALUES (?,?,?,?,?,?,?,?,NULL)",
        )
        .run(session, ghostAbs, "prB3", 999, canonDigest("zzz"), liveKey, 1, Date.now());
      const grantMiss = store.db
        .prepare(
          "SELECT snapshot_id FROM file_snapshots WHERE path = ? AND snapshot_hash = ? " +
            "AND committed = 1 AND anchor_generation = ?",
        )
        .get(ghostAbs, liveKey, ANCHOR_GENERATION) as { snapshot_id: number } | undefined;
      expect(grantMiss).toBeUndefined();
      sweepNow(store.db);
      const foreignLeft = (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM served_leases WHERE file_path = ?")
          .get(ghostAbs) as { n: number }
      ).n;
      expect(foreignLeft).toBe(0);
      const legitKept = (
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM served_leases WHERE file_path = ? " +
              "AND served_snapshot_hash = ? AND retired_at IS NULL",
          )
          .get(absF, liveKey) as { n: number }
      ).n;
      expect(legitKept).toBeGreaterThan(0);
    });
  });

  it("a lease naming only an uncommitted snapshot row is swept while the live lease is kept", async () => {
    await withTempFile("f.txt", PRE, async ({ cwd }) => {
      const absF = join(cwd, "f.txt");
      const ghostAbs = join(cwd, "ghost.txt");
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "f.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      const liveKey = snapshotHashFor(PRE);
      store.db
        .prepare(
          "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) " +
            "VALUES (?,?,?,?,?,?)",
        )
        .run(ghostAbs, liveKey, 4, Date.now(), 0, ANCHOR_GENERATION);
      const session = testSessionManager.getSessionId();
      store.db
        .prepare(
          "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, " +
            "served_snapshot_hash, served_line_number, updated_at, retired_at) " +
            "VALUES (?,?,?,?,?,?,?,?,NULL)",
        )
        .run(session, ghostAbs, "unC0", 999, canonDigest("zzz"), liveKey, 1, Date.now());
      const grantMiss = store.db
        .prepare(
          "SELECT snapshot_id FROM file_snapshots WHERE path = ? AND snapshot_hash = ? " +
            "AND committed = 1 AND anchor_generation = ?",
        )
        .get(ghostAbs, liveKey, ANCHOR_GENERATION) as { snapshot_id: number } | undefined;
      expect(grantMiss).toBeUndefined();
      sweepNow(store.db);
      const ghostLeft = (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM served_leases WHERE file_path = ?")
          .get(ghostAbs) as { n: number }
      ).n;
      expect(ghostLeft).toBe(0);
      const legitKept = (
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM served_leases WHERE file_path = ? " +
              "AND served_snapshot_hash = ? AND retired_at IS NULL",
          )
          .get(absF, liveKey) as { n: number }
      ).n;
      expect(legitKept).toBeGreaterThan(0);
    });
  });

  it("the sweep joins a caller-owned transaction instead of nesting", async () => {
    await withTempFile("t.txt", PRE, async ({ cwd }) => {
      const absT = join(cwd, "t.txt");
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "t.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      plantV2File(store, absT, PRE);
      const staleBefore = (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM served_leases WHERE served_snapshot_hash NOT LIKE ?")
          .get(`%:${ANCHOR_GENERATION}:%`) as { n: number }
      ).n;
      expect(staleBefore).toBeGreaterThan(0);
      store.db.exec("BEGIN IMMEDIATE");
      expect((store.db as unknown as { isTransaction?: boolean }).isTransaction).toBe(true);
      sweepNow(store.db);
      const staleInTxn = (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM served_leases WHERE served_snapshot_hash NOT LIKE ?")
          .get(`%:${ANCHOR_GENERATION}:%`) as { n: number }
      ).n;
      expect(staleInTxn).toBe(0);
      store.db.exec("ROLLBACK");
      const staleAfter = (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM served_leases WHERE served_snapshot_hash NOT LIKE ?")
          .get(`%:${ANCHOR_GENERATION}:%`) as { n: number }
      ).n;
      expect(staleAfter).toBe(staleBefore);
      expect((store.db as unknown as { isTransaction?: boolean }).isTransaction).toBe(false);
      sweepNow(store.db);
      const staleHealed = (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM served_leases WHERE served_snapshot_hash NOT LIKE ?")
          .get(`%:${ANCHOR_GENERATION}:%`) as { n: number }
      ).n;
      expect(staleHealed).toBe(0);
    });
  });

  it("a rollback failure preserves the original sweep error", async () => {
    await withTempFile("b.txt", PRE, async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "b.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      const origExec = store.db.exec.bind(store.db);
      clearDiagnostics();
      const spy = vi.spyOn(store.db, "exec").mockImplementation((sql: string) => {
        if (sql.includes("DELETE FROM file_snapshots"))
          throw new Error("injected mid-sweep failure");
        if (sql === "ROLLBACK") throw new Error("injected rollback failure");
        origExec(sql);
      });
      try {
        expect(() => sweepNow(store.db)).toThrow(/injected mid-sweep failure/);
      } finally {
        spy.mockRestore();
        origExec("ROLLBACK");
      }
      const trace = readDiagnostics()
        .map((record) => record.message)
        .join("\n");
      expect(trace).toMatch(/failed to rollback sweep transaction/);
      expect((store.db as unknown as { isTransaction?: boolean }).isTransaction).toBe(false);
    });
  });

  it("a mid-sweep failure rolls back instead of half-sweeping", async () => {
    await withTempFile("s.txt", PRE, async ({ cwd }) => {
      const absS = join(cwd, "s.txt");
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "s.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      plantV2File(store, absS, PRE);
      const leasesBefore = (
        store.db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }
      ).n;
      const snapsBefore = (
        store.db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }
      ).n;
      expect(leasesBefore).toBeGreaterThan(0);
      const origExec = store.db.exec.bind(store.db);
      const spy = vi.spyOn(store.db, "exec").mockImplementation((sql: string) => {
        if (sql.includes("DELETE FROM file_snapshots"))
          throw new Error("injected mid-sweep failure");
        origExec(sql);
      });
      try {
        expect(() => sweepNow(store.db)).toThrow(/injected mid-sweep failure/);
      } finally {
        spy.mockRestore();
      }
      expect(
        (store.db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }).n,
      ).toBe(leasesBefore);
      expect(
        (store.db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }).n,
      ).toBe(snapsBefore);
      sweepNow(store.db);
      const dangling = (
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM served_leases sl WHERE NOT EXISTS " +
              "(SELECT 1 FROM file_snapshots fs WHERE fs.path = sl.file_path " +
              "AND fs.snapshot_hash = sl.served_snapshot_hash)",
          )
          .get() as { n: number }
      ).n;
      expect(dangling).toBe(0);
    });
  });

  it("a repeated sweep across reopens is idempotent", async () => {
    await withTempFile("q.txt", PRE, async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "q.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      sweepNow(store.db);
      const leasesFirst = (
        store.db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }
      ).n;
      const snapsFirst = (
        store.db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }
      ).n;
      expect(leasesFirst).toBeGreaterThan(0);
      sweepNow(store.db);
      expect(
        (store.db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }).n,
      ).toBe(leasesFirst);
      expect(
        (store.db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }).n,
      ).toBe(snapsFirst);
      shutdownHashStore();
      await loadHashStore();
      const reopened = await loadHashStore();
      expect(
        (reopened.db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }).n,
      ).toBe(leasesFirst);
      expect(
        (reopened.db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }).n,
      ).toBe(snapsFirst);
      const dangling = (
        reopened.db
          .prepare(
            "SELECT COUNT(*) AS n FROM served_leases sl WHERE NOT EXISTS " +
              "(SELECT 1 FROM file_snapshots fs WHERE fs.path = sl.file_path " +
              "AND fs.snapshot_hash = sl.served_snapshot_hash)",
          )
          .get() as { n: number }
      ).n;
      expect(dangling).toBe(0);
    });
  });

  it("a read-only store aborts the sweep with committed state intact", async () => {
    await withTempFile("w.txt", PRE, async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "w.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      const leasesBefore = (
        store.db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }
      ).n;
      const snapsBefore = (
        store.db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }
      ).n;
      expect(leasesBefore).toBeGreaterThan(0);
      const storePath = hashStorePath();
      moveStoreStamp(store.db);
      shutdownHashStore();
      const readOnly = new DatabaseSync(storePath, { readOnly: true });
      try {
        expect(() => ensureSnapshotTables(readOnly)).toThrow();
      } finally {
        readOnly.close();
      }
      const reopened = await loadHashStore();
      expect(
        (reopened.db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }).n,
      ).toBe(leasesBefore);
      expect(
        (reopened.db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }).n,
      ).toBe(snapsBefore);
    });
  });

  it("a canon-only change keeps anchor state while a generation change invalidates it", async () => {
    // Ref: docs/.archive_adrs/0031-file-scoped-anchors-residual-and-generation-discipline.md
    await withTempFile("k.txt", PRE, async ({ cwd }) => {
      const absK = join(cwd, "k.txt");
      const store = await loadHashStore();
      const cs = contentChecksum(PRE);
      const canonDriftKey = `999:${ANCHOR_GENERATION}:${cs}`;
      const genDriftKey = `${CANON_VERSION}:999:${cs}`;
      store.db
        .prepare(
          "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) " +
            "VALUES (?,?,?,?,1,?)",
        )
        .run(absK, canonDriftKey, 4, Date.now(), ANCHOR_GENERATION);
      store.db
        .prepare(
          "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) " +
            "VALUES (?,?,?,?,1,?)",
        )
        .run(absK, genDriftKey, 4, Date.now(), 999);
      expect(isCurrentAnchorGeneration(canonDriftKey)).toBe(true);
      expect(isCurrentAnchorGeneration(genDriftKey)).toBe(false);
      expect(isCurrentAnchorGeneration(`2:${cs}`)).toBe(false);
      expect(isCurrentAnchorGeneration(snapshotHashFor(PRE))).toBe(true);
      sweepNow(store.db);
      const left = store.db
        .prepare("SELECT snapshot_hash AS h FROM file_snapshots WHERE path = ?")
        .all(absK) as { h: string }[];
      expect(left.map((row) => row.h)).toEqual([canonDriftKey]);
    });
  });

  it("undo rows stamp the anchor generation, not the canon version", async () => {
    await withTempFile("u.txt", POST, async ({ cwd }) => {
      const absU = join(cwd, "u.txt");
      const store = await loadHashStore();
      upsertUndo(store, absU, {
        content: PRE,
        bom: "",
        ending: "\n",
        hashes: contentOnlyHashes(PRE),
        resultContent: POST,
      });
      expect(getUndoEntry(store, absU)?.anchorGeneration).toBe(ANCHOR_GENERATION);
    });
  });

  it("a failed write replays the pre-generation row without laundering its generation", async () => {
    // Ref: docs/.archive_adrs/0031-file-scoped-anchors-residual-and-generation-discipline.md
    await withTempFile("r.txt", POST, async ({ cwd }) => {
      const absR = join(cwd, "r.txt");
      await plantLegacyRow(absR);
      const legacyHashes = contentOnlyHashes(PRE);
      const handle = await saveUndo(absR, {
        content: POST,
        bom: "",
        originalEnding: "\n",
        hashes: await fileHashesFor(absR, POST),
        resultContent: `${POST}x\n`,
      });
      expect(handle.persisted).toBe(true);
      await handle.restore();
      const replayed = await readUndo(absR);
      expect(replayed?.anchorGeneration).toBe(0);
      expect(replayed?.hashes).toEqual(legacyHashes);
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const undo = getTool("undo_last_edit");
      const readTool = getTool("read");
      await undo.execute("u1", { path: "r.txt" }, undefined, undefined, ctx);
      expect(await readFile(absR, "utf-8")).toBe(PRE);
      const served = rows(
        getText(await readTool.execute("r1", { file: "r.txt" }, undefined, undefined, ctx)),
      ).map((r) => r.hash);
      expect(served).toEqual(await fileHashesFor(absR, PRE));
      expect(served).not.toEqual(legacyHashes);
    });
  });
});
