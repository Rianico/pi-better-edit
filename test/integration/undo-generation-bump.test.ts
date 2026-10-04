import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureSnapshotTables, loadHashStore, type HashStore } from "../../src/hash-store.js";
import { upsertUndo } from "../../src/undo-store.js";
import { canonDigest, contentOnlyHashes, fileHashesFor } from "../../src/hashline/index.js";
import { contentChecksum } from "../../src/hashline/hasher.js";
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
      await expect(submit(v2A[1]!)).rejects.toThrow(
        /E_(UNKNOWN_ANCHOR|FOREIGN_ANCHOR|STALE_RANGE)/,
      );
      expect(await readFile(absB, "utf-8")).toBe(PRE);
      const servedB = rows(
        getText(await readTool.execute("r2", { path: "b.txt" }, undefined, undefined, ctx)),
      ).map((r) => r.hash);
      expect(servedB).toEqual(await fileHashesFor(absB, PRE));
      await expect(submit(v2A[1]!)).rejects.toThrow(
        /E_(UNKNOWN_ANCHOR|FOREIGN_ANCHOR|STALE_RANGE)/,
      );
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
});
