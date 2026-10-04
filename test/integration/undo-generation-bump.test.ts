import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureSnapshotTables,
  loadHashStore,
  shutdownHashStore,
  type HashStore,
} from "../../src/hash-store.js";
import { upsertUndo } from "../../src/undo-store.js";
import {
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
  adoptPinnedSnapshotFor,
  anchorsForSnapshotHash,
  getSnapshot,
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
    "UPDATE file_undo SET canon_version = 0 WHERE path = '" + absPath.replace(/'/g, "''") + "'",
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

/** Snapshot row as the pre-fix build wrote it: current-generation key, no generation stamped. */
function plantPoisonSnapshot(store: HashStore, absPath: string, content: string): void {
  const hashes = contentOnlyHashes(content);
  store.db
    .prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) VALUES (?,?,?,?,1)",
    )
    .run(absPath, `3:${contentChecksum(content)}`, hashes.length, Date.now());
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
        getText(await readTool.execute("r1", { path: "a.txt" }, undefined, undefined, ctx)),
      );
      const bRows = rows(
        getText(await readTool.execute("r2", { path: "b.txt" }, undefined, undefined, ctx)),
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
        getText(await readTool.execute("r1", { path: "p.txt" }, undefined, undefined, ctx)),
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
        getText(await readTool.execute("r2", { path: "b.txt" }, undefined, undefined, ctx)),
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
      expect(await anchorsForSnapshotHash(absA, `3:${contentChecksum(PRE)}`)).toBeUndefined();
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      const editTool = getTool("edit");
      const servedA = rows(
        getText(await readTool.execute("r1", { path: "a.txt" }, undefined, undefined, ctx)),
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
    // WHY: the `"2:…"` and unknown-generation `"3:…"` misses, at the row level —
    // WHY: prefix and provenance both refuse, so neither a released-v7 state nor
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
        getText(await readTool.execute("r1", { path: "r.txt" }, undefined, undefined, ctx)),
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
        getText(await readTool.execute("r1", { path: "g.txt" }, undefined, undefined, ctx)),
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

  it("after any open every lease names a live snapshot", async () => {
    // WHY: P2 invariant — one provenance rule for the whole sweep. A mixture of
    // WHY: pre-column (canon 0, current key), foreign-generation (canon 0/2, old key)
    // WHY: and live (canon 3) rows goes through the sweep in place and through a
    // WHY: real reopen; afterwards no lease dangles and no un-retired lease is
    // WHY: lineage-less, while the live read's leases survive.
    await withTempFile("i.txt", PRE, async ({ cwd }) => {
      const absI = join(cwd, "i.txt");
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { path: "i.txt" }, undefined, undefined, ctx);
      const store = await loadHashStore();
      const liveBefore = (
        store.db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }
      ).n;
      expect(liveBefore).toBeGreaterThan(0);
      // WHY: same-generation pre-column shape — a current key with no generation
      // WHY: stamped (DEFAULT 0), plus leases a 3:-prefix gate alone would keep.
      // WHY: poison content shares no lines with PRE/POST: content-only anchors
      // WHY: derive from line text, so a shared line would reuse the spelling and
      // WHY: collide on the lease primary key.
      const OTHER = "ddd\neee\nfff\n";
      plantPoisonSnapshot(store, absI, OTHER);
      const poisonKey = `3:${contentChecksum(OTHER)}`;
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
      // WHY: explicit canon_version 2 row for the 0/2/3 mixture.
      plantV2File(store, absI, PRE);
      store.db
        .prepare(
          "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, canon_version) VALUES (?,?,?,?,1,2)",
        )
        .run(absI, `2:${contentChecksum(OTHER)}`, 3, Date.now());
      const checkInvariant = (db: HashStore["db"]): void => {
        const dangling = db
          .prepare(
            "SELECT COUNT(*) AS n FROM served_leases WHERE served_snapshot_hash NOT IN (SELECT snapshot_hash FROM file_snapshots)",
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
      const liveKey = `${CANON_VERSION}:${contentChecksum(PRE)}`;
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
});
