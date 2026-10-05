import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { saveUndo, getUndo, clearUndo } from "../../src/edit-undo";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { upsertUndo, getUndoEntry, deleteUndo } from "../../src/undo-store";
import { ANCHOR_GENERATION } from "../../src/hashline";
import { snapshotHashFor } from "../../src/snapshot-store";
import * as hashStoreModule from "../../src/hash-store";
import { hashStorePath } from "../../src/paths";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("undo-store", () => {
  it("round-trips a single entry", async () => {
    await saveUndo(home.testPath, {
      content: "hello\nworld",
      bom: "",
      originalEnding: "\n",
      hashes: ["abcc", "deff"],
      resultContent: "hello\nworld!",
    });
    const entry = await getUndo(home.testPath);
    expect(entry).toBeDefined();
    expect(entry!.content).toBe("hello\nworld");
    expect(entry!.bom).toBe("");
    expect(entry!.originalEnding).toBe("\n");
    expect(entry!.hashes).toEqual(["abcc", "deff"]);
    expect(entry!.resultContent).toBe("hello\nworld!");
  });

  it("pins the restored content's canonical snapshot hash (issue #82)", async () => {
    await saveUndo(home.testPath, {
      content: "hello\nworld",
      bom: "",
      originalEnding: "\n",
      hashes: ["abcc", "deff"],
      resultContent: "hello\nworld!",
    });
    const entry = await getUndo(home.testPath);
    expect(entry!.snapshotHash).toBe(snapshotHashFor("hello\nworld"));
  });

  it("returns undefined for a path with no undo history", async () => {
    expect(await getUndo("/nonexistent.ts")).toBeUndefined();
  });

  it("overwrites previous entry for the same path", async () => {
    await saveUndo(home.testPath, {
      content: "first",
      bom: "",
      originalEnding: "\n",
      hashes: ["aB3"],
      resultContent: "first!",
    });
    await saveUndo(home.testPath, {
      content: "second",
      bom: "\uFEFF",
      originalEnding: "\r\n",
      hashes: ["bC44"],
      resultContent: "second!",
    });
    const entry = await getUndo(home.testPath);
    expect(entry!.content).toBe("second");
    expect(entry!.bom).toBe("\uFEFF");
    expect(entry!.originalEnding).toBe("\r\n");
    expect(entry!.hashes).toEqual(["bC44"]);
  });

  it("clearUndo removes the entry", async () => {
    await saveUndo(home.testPath, {
      content: "data",
      bom: "",
      originalEnding: "\n",
      hashes: ["xY77"],
      resultContent: "data!",
    });
    expect(await getUndo(home.testPath)).toBeDefined();
    await clearUndo(home.testPath);
    expect(await getUndo(home.testPath)).toBeUndefined();
  });

  it("handles multiple independent paths", async () => {
    await saveUndo(home.testPath, {
      content: "aaaa",
      bom: "",
      originalEnding: "\n",
      hashes: ["h1AA"],
      resultContent: "aaa!",
    });
    await saveUndo("/b.ts", {
      content: "bbbb",
      bom: "",
      originalEnding: "\n",
      hashes: ["h2BB"],
      resultContent: "bbb!",
    });
    expect((await getUndo(home.testPath))!.content).toBe("aaaa");
    expect((await getUndo("/b.ts"))!.content).toBe("bbbb");
    await clearUndo(home.testPath);
    expect(await getUndo(home.testPath)).toBeUndefined();
    expect((await getUndo("/b.ts"))!.content).toBe("bbbb");
  });

  it("survives a hash-store shutdown and reopen", async () => {
    await saveUndo(home.testPath, {
      content: "old",
      bom: "\uFEFF",
      originalEnding: "\r",
      hashes: ["abcc", "deff"],
      resultContent: "new",
    });
    shutdownHashStore();
    const entry = await getUndo(home.testPath);
    expect(entry).toBeDefined();
    expect(entry!.content).toBe("old");
    expect(entry!.bom).toBe("\uFEFF");
    expect(entry!.originalEnding).toBe("\r");
    expect(entry!.hashes).toEqual(["abcc", "deff"]);
    expect(entry!.resultContent).toBe("new");
  });

  it("saveUndo reports failure when the hash store cannot be opened", async () => {
    const spy = vi
      .spyOn(hashStoreModule, "loadHashStore")
      .mockRejectedValue(new Error("store down"));
    try {
      const ok = await saveUndo(home.testPath, {
        content: "old",
        bom: "",
        originalEnding: "\n",
        hashes: ["abcc"],
        resultContent: "new",
      });
      expect(ok.persisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("treats a row with an invalid ending as a miss", async () => {
    await saveUndo(home.testPath, {
      content: "old",
      bom: "",
      originalEnding: "\r\n",
      hashes: ["abcc"],
      resultContent: "new",
    });
    const db = new DatabaseSync(hashStorePath(), { defensive: false } as any);
    db.prepare("UPDATE file_undo SET ending = ? WHERE path = ?").run("bogus", home.testPath);
    db.close();
    expect(await getUndo(home.testPath)).toBeUndefined();
    const check = new DatabaseSync(hashStorePath(), {
      defensive: false,
    } as any);
    const remaining = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get(home.testPath) as { n: number };
    check.close();
    expect(remaining.n).toBe(0);
  });
});

describe("undo-store — raw entries", () => {
  it("round-trips an undo entry", async () => {
    const store = await loadHashStore();
    upsertUndo(store, "/a.ts", {
      content: "old",
      bom: "\uFEFF",
      ending: "\r\n",
      hashes: ["abcc", "deff"],
      resultContent: "new",
    });
    const entry = getUndoEntry(store, "/a.ts");
    // (04b section 4) `transactionId: null` is part of the round-trip shape: an ordinary single-file
    // edit row carries no transaction; only a cut's rows share a non-null id.
    // (04b-rem P2-2) `rawPre: null` joins the same shape: only a cut transaction's rows carry the
    // raw pre image; an ordinary row's absence of one is the canonical-fold fallback signal.
    expect(entry).toEqual({
      content: "old",
      bom: "\uFEFF",
      ending: "\r\n",
      hashes: ["abcc", "deff"],
      resultContent: "new",
      snapshotHash: null,
      transactionId: null,
      rawPre: null,
      // P1: every upsert stamps the current anchor generation.
      anchorGeneration: ANCHOR_GENERATION,
    });
  });

  it("returns undefined for a path with no undo entry", async () => {
    const store = await loadHashStore();
    expect(getUndoEntry(store, "/missing.ts")).toBeUndefined();
  });

  it("overwrites the previous entry for the same path", async () => {
    const store = await loadHashStore();
    upsertUndo(store, "/a.ts", {
      content: "first",
      bom: "",
      ending: "\n",
      hashes: ["aB3"],
      resultContent: "first!",
    });
    upsertUndo(store, "/a.ts", {
      content: "second",
      bom: "",
      ending: "\r",
      hashes: ["bC44"],
      resultContent: "second!",
    });
    const entry = getUndoEntry(store, "/a.ts");
    expect(entry!.content).toBe("second");
    expect(entry!.ending).toBe("\r");
    expect(entry!.hashes).toEqual(["bC44"]);
  });

  it("deletes an undo entry", async () => {
    const store = await loadHashStore();
    upsertUndo(store, "/a.ts", {
      content: "old",
      bom: "",
      ending: "\n",
      hashes: ["xY77"],
      resultContent: "new",
    });
    deleteUndo(store, "/a.ts");
    expect(getUndoEntry(store, "/a.ts")).toBeUndefined();
  });

  it("treats a row with unparseable hashes as a miss", async () => {
    const store = await loadHashStore();
    upsertUndo(store, "/a.ts", {
      content: "old",
      bom: "",
      ending: "\n",
      hashes: ["xY77"],
      resultContent: "new",
    });
    const db = new DatabaseSync(hashStorePath(), { defensive: false } as any);
    db.prepare("UPDATE file_undo SET hashes = ? WHERE path = ?").run("{not json", "/a.ts");
    db.close();
    expect(getUndoEntry(store, "/a.ts")).toBeUndefined();
    const check = new DatabaseSync(hashStorePath(), {
      defensive: false,
    } as any);
    const remaining = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get("/a.ts") as { n: number };
    check.close();
    expect(remaining.n).toBe(0);
  });

  it("treats a row with malformed hash strings as a miss", async () => {
    const store = await loadHashStore();
    upsertUndo(store, "/a.ts", {
      content: "old",
      bom: "",
      ending: "\n",
      hashes: ["xY77"],
      resultContent: "new",
    });
    const db = new DatabaseSync(hashStorePath(), { defensive: false } as any);
    db.prepare("UPDATE file_undo SET hashes = ? WHERE path = ?").run('["ZZ", "ZZZZ"]', "/a.ts");
    db.close();
    expect(getUndoEntry(store, "/a.ts")).toBeUndefined();
    const check = new DatabaseSync(hashStorePath(), {
      defensive: false,
    } as any);
    const remaining = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get("/a.ts") as { n: number };
    check.close();
    expect(remaining.n).toBe(0);
  });
});

describe("undo-store — snapshot_hash pin (issue #79)", () => {
  it("round-trips the snapshot_hash restored-target pin", async () => {
    const store = await loadHashStore();
    upsertUndo(store, "/pinned.ts", {
      content: "old",
      bom: "",
      ending: "\n",
      hashes: ["abcc"],
      resultContent: "new",
      snapshotHash: "v1:deadbeef",
    });
    expect(getUndoEntry(store, "/pinned.ts")).toMatchObject({
      content: "old",
      snapshotHash: "v1:deadbeef",
    });
  });

  it("persists undo rows in the file_undo table", async () => {
    const store = await loadHashStore();
    upsertUndo(store, "/isolated.ts", {
      content: "old",
      bom: "",
      ending: "\n",
      hashes: ["abcc"],
      resultContent: "new",
    });
    const row = store.db
      .prepare("SELECT path FROM file_undo WHERE path = ?")
      .get("/isolated.ts") as { path?: string } | undefined;
    expect(row?.path).toBe("/isolated.ts");
  });

  it("never writes v7 undo state into the legacy v6 undo shell", async () => {
    const store = await loadHashStore();
    upsertUndo(store, "/shell-free.ts", {
      content: "old",
      bom: "",
      ending: "\n",
      hashes: ["abcc"],
      resultContent: "new",
    });
    const legacy = store.db.prepare("SELECT COUNT(*) AS n FROM undo").get() as { n: number };
    const v7 = store.db.prepare("SELECT COUNT(*) AS n FROM file_undo").get() as { n: number };
    expect(legacy.n).toBe(0);
    expect(v7.n).toBeGreaterThan(0);
  });
});
