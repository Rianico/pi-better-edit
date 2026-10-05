import { describe, expect, it, vi } from "vitest";
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
} from "../../src/hashline/index.js";
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

async function plantLegacyRow(absPath: string): Promise<void> {
  // WHY: reproduces a pre-bump store — the old code wrote content-only hashes with
  // WHY: a null key and no generation. `upsertUndo` always stamps the current
  // WHY: generation, so the test downgrades the row through SQL afterwards.
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
      "INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?,?,?,?) ON CONFLICT(session_id,path) DO UPDATE SET hashes=excluded.hashes",
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
      // WHY: the fresh read serves the current generation — never the planted
      // WHY: content-only hashes.
      expect(aRows.map((r) => r.hash)).toEqual(expectedA);
      expect(bRows.map((r) => r.hash)).toEqual(expectedB);
      expect(aRows.map((r) => r.hash)).not.toEqual(contentOnlyHashes(PRE));
      // WHY: explicit disjoint precondition for the refusal below.
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
      ).rejects.toThrow(/E_BAD_PAYLOAD/);
      expect(await anchorsForSnapshotHash(absP, "2:deadbeef")).toBeUndefined();
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      const served = rows(
        getText(await readTool.execute("r1", { file: "p.txt" }, undefined, undefined, ctx)),
      );
      // WHY: the rejected pin left no lineage — the read serves the current
      // WHY: file-scoped derivation.
      expect(served.map((r) => r.hash)).toEqual(await fileHashesFor(absP, PRE));
    });
  });

  it("pre-bump leases are refused cold and after a fresh read", async () => {
    // WHY: probe 3 shipped — a pre-bump lease set plus the served mirror must not
    // WHY: authorize a write, with the store read cold (no prior read) or after a
    // WHY: fresh file-scoped read. The positive control proves the file is not
    // WHY: bricked: its own current anchor still applies.
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
      // WHY: deterministic route — the v2 leases were planted after the open-time
      // WHY: sweep, so the generation-gated lease source skips them while the
      // WHY: session-wide home lookup still finds the a.txt lease: FOREIGN, cold.
      await expect(submit(v2A[1]!)).rejects.toThrow(/E_FOREIGN_ANCHOR/);
      expect(await readFile(absB, "utf-8")).toBe(PRE);
      const servedB = rows(
        getText(await readTool.execute("r2", { file: "b.txt" }, undefined, undefined, ctx)),
      ).map((r) => r.hash);
      expect(servedB).toEqual(await fileHashesFor(absB, PRE));
      // WHY: still FOREIGN after the fresh read — the re-serve retires nothing
      // WHY: (shared line_ids survive) and the v2 rows are still skipped by the
      // WHY: lease gate while homed at a.txt.
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
    // WHY: poison-phase1/2 shipped — a store written by the pre-fix build persists
    // WHY: content-only anchors under a current-generation key. The fixed build must
    // WHY: serve file-scoped anchors anyway, refuse another-file use, and delete the
    // WHY: poisoned row (plus orphan lineage) on the next schema-ensure.
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
      ensureSnapshotTables(store.db);
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
    // WHY: the `"2:…"` 2-part and unknown-generation 3-part misses, at the row level —
    // WHY: middle-component and provenance both refuse, so neither a released-v7 state nor
    // WHY: a poisoned row can be resolved or adopted through these seams.
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
    // WHY: P1 regression — the open-time sweep must never touch the served mirror
    // WHY: (its snapshotId is a load-epoch string, not a file_snapshots id). A real
    // WHY: read plants the production-shaped row; after a restart the mirror row is
    // WHY: present and the edit at the just-served anchors writes.
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
        .prepare("SELECT snapshotId FROM served WHERE path = ?")
        .get(absR) as { snapshotId: string | null } | undefined;
      // WHY: the production shape the broken CAST could not judge — a load-epoch
      // WHY: string, never an integer snapshot id.
      expect(mirrorBefore?.snapshotId).toMatch(/^v2\|/);
      shutdownHashStore();
      await loadHashStore();
      const reopened = await loadHashStore();
      const mirrorAfter = reopened.db
        .prepare("SELECT snapshotId FROM served WHERE path = ?")
        .get(absR) as { snapshotId: string | null } | undefined;
      expect(mirrorAfter?.snapshotId).toBe(mirrorBefore?.snapshotId);
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
    // WHY: P1 regression — the echo guard's only evidence is the served mirror. It
    // WHY: denies in-process; after a restart it must still deny, not go silent.
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
    // WHY: the deterministic swept-row route — leases that died in the open-time
    // WHY: sweep leave no session-wide home behind, so the refusal is UNKNOWN (not
    // WHY: FOREIGN, which needs a surviving lease homed at another file).
    await withTempFile("a.txt", PRE, async ({ cwd }) => {
      const absA = join(cwd, "a.txt");
      const absB = join(cwd, "b.txt");
      await writeFile(absB, PRE, "utf-8");
      const store = await loadHashStore();
      const v2A = plantV2File(store, absA, PRE);
      plantV2File(store, absB, PRE);
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
    // WHY: P2 invariant — one provenance rule as of the sweep point. A mixture of
    // WHY: pre-column (generation 0, current key), foreign-generation (generation 0/2, old key)
    // WHY: and live (generation 1) rows goes through the sweep in place and through a
    // WHY: real reopen; afterwards no lease dangles and no un-retired lease is
    // WHY: lineage-less, while the live read's leases survive. Scoped to the sweep,
    // WHY: not the whole open: the open-hook vacuum runs after and may evict a snapshot
    // WHY: pinned only by a retired-past-grace lease (the next test pins that boundary).
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
      // WHY: same-generation pre-column shape — a current key with no generation
      // WHY: stamped (DEFAULT 0), plus leases an anchor-generation gate alone would keep.
      // WHY: poison content shares no lines with PRE/POST: content-only anchors
      // WHY: derive from line text, so a shared line would reuse the spelling and
      // WHY: collide on the lease primary key.
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
      // WHY: foreign-generation shape — old key, DEFAULT-0 generation, plus an
      // WHY: explicit anchor_generation 2 row for the 0/2/1 mixture.
      plantV2File(store, absI, PRE);
      store.db
        .prepare(
          "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) VALUES (?,?,?,?,1,2)",
        )
        .run(absI, `2:${contentChecksum(OTHER)}`, 3, Date.now());
      const checkInvariant = (db: HashStore["db"]): void => {
        // WHY: path-level provenance — the sweep's orphan rule, not the old hash-level
        // WHY: form: a lease must name a snapshot row for its own path.
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
      ensureSnapshotTables(store.db);
      checkInvariant(store.db);
      // WHY: the live read's leases name the surviving current-generation snapshot.
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
      // WHY: the live read's leases are active, so the open-hook vacuum pins their
      // WHY: snapshot and the end-of-open state still satisfies the sweep-point rule.
      checkInvariant(reopened.db);
    });
  });

  it("a retired-past-grace lease dangles only until the next open's sweep", async () => {
    // WHY: the exact sweep/vacuum boundary the invariant above is scoped to. The vacuum
    // WHY: pin ignores a lease retired past the 1-hour grace even with updated_at inside
    // WHY: the session TTL, so evicting its snapshot strands the lease at end of open
    // WHY: (fail-closed: the generation-gated grant misses) until the next open's sweep
    // WHY: drops it.
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
      // WHY: retire past the pin grace but inside the session TTL — unpinned, not expired.
      const now = Date.now();
      store.db
        .prepare("UPDATE served_leases SET retired_at = ?, updated_at = ? WHERE file_path = ?")
        .run(now - 2 * VACUUM_RETIRED_PIN_MS, now, absH);
      // WHY: undo restore targets pin too, so the boundary run starts with no pin at all.
      store.db.prepare("DELETE FROM file_undo WHERE path = ?").run(absH);
      // WHY: overfill the path past its 10-version retention window — the vacuum must
      // WHY: evict oldest-first, and the retired lease's snapshot is the oldest row.
      const OTHER = "ddd\neee\nfff\n";
      for (let i = 0; i < 14; i++) {
        plantSnapshotRow(store, absH, `3:forged-${i}`, contentOnlyHashes(OTHER));
      }
      vacuumSnapshots(store.db);
      // WHY: the vacuum evicted the snapshot the retired leases name — the grant a live
      // WHY: edit would need now misses, so the stranded state refuses fail-closed.
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
      // WHY: self-healing — the next open's sweep drops the stranded leases.
      ensureSnapshotTables(store.db);
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
    // WHY: the orphan predicate is path-level because the grant lookup is path-scoped.
    // WHY: A synthetic lease homed at ghost.txt names f.txt's live hash: the old
    // WHY: hash-level rule kept it while the grant for its own path missed. Not
    // WHY: production-reachable (current-prefix hashes are stored with the current
    // WHY: generation, so the snapshot sweep cannot delete the row a live lease names).
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
      // WHY: premise — the grant lookup for the lease's own path misses.
      const grantMiss = store.db
        .prepare(
          "SELECT snapshot_id FROM file_snapshots WHERE path = ? AND snapshot_hash = ? " +
            "AND committed = 1 AND anchor_generation = ?",
        )
        .get(ghostAbs, liveKey, ANCHOR_GENERATION) as { snapshot_id: number } | undefined;
      expect(grantMiss).toBeUndefined();
      ensureSnapshotTables(store.db);
      const foreignLeft = (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM served_leases WHERE file_path = ?")
          .get(ghostAbs) as { n: number }
      ).n;
      expect(foreignLeft).toBe(0);
      // WHY: the vacuum pins the legitimate lease's snapshot, so the sweep keeps it.
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
    // WHY: the orphan predicate matches the grant lookup (`path = ? AND snapshot_hash = ?`
    // WHY: `AND committed = 1 AND anchor_generation = ?`): a lease naming a committed = 0 row
    // WHY: cannot grant, so the sweep drops it. Nothing in production writes committed = 0
    // WHY: (every snapshot insert commits), so this is a hardening pin, not a live path.
    await withTempFile("f.txt", PRE, async ({ cwd }) => {
      const absF = join(cwd, "f.txt");
      const ghostAbs = join(cwd, "ghost.txt");
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "f.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      const liveKey = snapshotHashFor(PRE);
      // WHY: premise — a current-generation snapshot row for the ghost path exists but
      // WHY: is uncommitted, so the grant lookup for the ghost lease misses.
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
      ensureSnapshotTables(store.db);
      const ghostLeft = (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM served_leases WHERE file_path = ?")
          .get(ghostAbs) as { n: number }
      ).n;
      expect(ghostLeft).toBe(0);
      // WHY: the legitimate current-generation lease survives the tightened predicate.
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
    // WHY: `BEGIN IMMEDIATE` cannot nest — when the caller already holds the transaction
    // WHY: the sweep runs on it (the `isTransaction` guard) instead of opening its own.
    // WHY: The sweep's deletes are then the caller's to keep or roll back.
    await withTempFile("t.txt", PRE, async ({ cwd }) => {
      const absT = join(cwd, "t.txt");
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "t.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      plantV2File(store, absT, PRE);
      const staleBefore = (
        store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM served_leases WHERE served_snapshot_hash NOT LIKE '%:${ANCHOR_GENERATION}:%'`,
          )
          .get() as { n: number }
      ).n;
      expect(staleBefore).toBeGreaterThan(0);
      store.db.exec("BEGIN IMMEDIATE");
      expect((store.db as unknown as { isTransaction?: boolean }).isTransaction).toBe(true);
      // WHY: no nested-BEGIN throw — the guard takes the caller-transaction branch.
      ensureSnapshotTables(store.db);
      // WHY: the sweep's deletes are present inside the caller's transaction.
      const staleInTxn = (
        store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM served_leases WHERE served_snapshot_hash NOT LIKE '%:${ANCHOR_GENERATION}:%'`,
          )
          .get() as { n: number }
      ).n;
      expect(staleInTxn).toBe(0);
      store.db.exec("ROLLBACK");
      // WHY: the caller owns atomicity — its ROLLBACK restores the swept rows.
      const staleAfter = (
        store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM served_leases WHERE served_snapshot_hash NOT LIKE '%:${ANCHOR_GENERATION}:%'`,
          )
          .get() as { n: number }
      ).n;
      expect(staleAfter).toBe(staleBefore);
      expect((store.db as unknown as { isTransaction?: boolean }).isTransaction).toBe(false);
      // WHY: the rolled-back sweep heals on retry — no wedge left behind.
      ensureSnapshotTables(store.db);
      const staleHealed = (
        store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM served_leases WHERE served_snapshot_hash NOT LIKE '%:${ANCHOR_GENERATION}:%'`,
          )
          .get() as { n: number }
      ).n;
      expect(staleHealed).toBe(0);
    });
  });

  it("a rollback failure preserves the original sweep error", async () => {
    // WHY: best-effort rollback — when ROLLBACK itself fails the original sweep failure
    // WHY: stays authoritative: it is logged, never masked, and rethrown.
    await withTempFile("b.txt", PRE, async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "b.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      const origExec = store.db.exec.bind(store.db);
      const logged: unknown[][] = [];
      const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
      const spy = vi.spyOn(store.db, "exec").mockImplementation((sql: string) => {
        if (sql.includes("DELETE FROM file_snapshots"))
          throw new Error("injected mid-sweep failure");
        if (sql === "ROLLBACK") throw new Error("injected rollback failure");
        origExec(sql);
      });
      try {
        expect(() => ensureSnapshotTables(store.db)).toThrow(/injected mid-sweep failure/);
      } finally {
        spy.mockRestore();
        consoleSpy.mockRestore();
        origExec("ROLLBACK");
      }
      expect(logged.length).toBeGreaterThan(0);
      expect(String(logged[0]![0])).toMatch(/failed to rollback sweep transaction/);
      expect((store.db as unknown as { isTransaction?: boolean }).isTransaction).toBe(false);
    });
  });

  it("a mid-sweep failure rolls back instead of half-sweeping", async () => {
    // WHY: the four sweep deletes are one BEGIN IMMEDIATE unit — when the snapshot
    // WHY: delete fails, the already-executed non-current-lease delete rolls back with it.
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
        expect(() => ensureSnapshotTables(store.db)).toThrow(/injected mid-sweep failure/);
      } finally {
        spy.mockRestore();
      }
      // WHY: rollback — without the transaction the first delete would have persisted.
      expect(
        (store.db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }).n,
      ).toBe(leasesBefore);
      expect(
        (store.db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }).n,
      ).toBe(snapsBefore);
      // WHY: a clean retry still sweeps to the invariant — the failure left no wedge.
      ensureSnapshotTables(store.db);
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
    // WHY: every store open sweeps, so sweeping twice — in place and across a real
    // WHY: reopen — must change nothing the second time while the live leases survive.
    await withTempFile("q.txt", PRE, async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { file: "q.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      ensureSnapshotTables(store.db);
      const leasesFirst = (
        store.db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }
      ).n;
      const snapsFirst = (
        store.db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }
      ).n;
      expect(leasesFirst).toBeGreaterThan(0);
      ensureSnapshotTables(store.db);
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
    // WHY: as the code defines it — buildStore runs inside the open, so a sweep write
    // WHY: failure closes the handle and aborts the open instead of half-sweeping.
    // WHY: Here the sweep runs directly on a read-only handle: it must throw and the
    // WHY: committed rows must read back unchanged on the next read-write open.
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
    // WHY: the axis split (ADR-0031) — the key carries both axes (`CANON:GENERATION:checksum`)
    // WHY: but the generation gate reads the anchor axis only. A canon-only drift keeps its row
    // WHY: through the sweep and its key current; a generation drift loses both. Falsifier: a gate
    // WHY: reading `CANON_VERSION` would sweep the canon-drift row and keep mislabeled state.
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
      // WHY: key-level — the middle component decides, so a canon-only change stays current.
      expect(isCurrentAnchorGeneration(canonDriftKey)).toBe(true);
      expect(isCurrentAnchorGeneration(genDriftKey)).toBe(false);
      expect(isCurrentAnchorGeneration(`2:${cs}`)).toBe(false);
      expect(isCurrentAnchorGeneration(snapshotHashFor(PRE))).toBe(true);
      // WHY: sweep-level — the canon-drift row survives, the generation-drift row goes.
      ensureSnapshotTables(store.db);
      const left = store.db
        .prepare("SELECT snapshot_hash AS h FROM file_snapshots WHERE path = ?")
        .all(absK) as { h: string }[];
      expect(left.map((row) => row.h)).toEqual([canonDriftKey]);
    });
  });

  it("undo rows stamp the anchor generation, not the canon version", async () => {
    // WHY: the undo half of the axis split — `upsertUndo` stamps `ANCHOR_GENERATION`, and the
    // WHY: restore gate compares against it, so a canon-only change never invalidates undo state.
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
    // WHY: ADR-0031 §4 — saveUndo's failure replay writes the previous row back verbatim;
    // WHY: the stamp must come from the payload so a pre-generation row still reads as
    // WHY: generation 0 afterwards and the restore gate re-derives instead of adopting the
    // WHY: foreign anchors. Falsifier: a hard-coded ANCHOR_GENERATION stamp in upsertUndo
    // WHY: re-stamps the replayed row as current and both assertions redden.
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
