import { describe, expect, it, beforeAll } from "vitest";
import { loadHashStore, shutdownHashStore, type HashStore } from "../../src/hash-store";
import {
  upsertUndo,
  getUndoEntry,
  writeCutIntent,
  listCutIntents,
  deleteCutIntent,
  deleteUndoTransaction,
} from "../../src/undo-store";
import { useTestHome } from "../support/fixtures";

// REMEDIATION store-domain witnesses (P2-1 row clear, P2-2 raw pre-image, P3-6 index):
// the durability contract lives in the store schema, so it is pinned here directly.
useTestHome();

beforeAll(async () => {
  await loadHashStore();
});

describe("undo-store remediation: durability schema", () => {
  it("ensureFileUndoSchema creates idx_file_undo_transaction_id (P3-6: indexed, not waived)", async () => {
    const store: HashStore = await loadHashStore();
    const row = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_file_undo_transaction_id") as { name?: string } | undefined;
    expect(row?.name, "the correlated-undo read path must be index-backed").toBe(
      "idx_file_undo_transaction_id",
    );
  });

  it("raw_pre round-trips through the undo row and defaults to NULL (P2-2 byte oracle)", async () => {
    const store: HashStore = await loadHashStore();
    upsertUndo(store, "/raw-pre.ts", {
      content: "a\nb\n",
      bom: "",
      ending: "\n",
      hashes: ["abcc"],
      resultContent: "a\n",
      rawPre: "a\r\nb\r\n",
    });
    expect(getUndoEntry(store, "/raw-pre.ts")?.rawPre).toBe("a\r\nb\r\n");
    upsertUndo(store, "/plain-pre.ts", {
      content: "x",
      bom: "",
      ending: "\n",
      hashes: ["dEfff"],
      resultContent: "y",
    });
    expect(getUndoEntry(store, "/plain-pre.ts")?.rawPre ?? null).toBeNull();
  });

  it("cut intents carry a direction; deleteUndoTransaction clears exactly one transaction's rows", async () => {
    const store: HashStore = await loadHashStore();
    upsertUndo(store, "/txn-a.ts", {
      content: "a",
      bom: "",
      ending: "\n",
      hashes: ["aA11"],
      resultContent: "b",
      transactionId: "txn-rem-1",
    });
    upsertUndo(store, "/txn-b.ts", {
      content: "c",
      bom: "",
      ending: "\n",
      hashes: ["bB22"],
      resultContent: "d",
      transactionId: "txn-rem-1",
    });
    upsertUndo(store, "/txn-c.ts", {
      content: "e",
      bom: "",
      ending: "\n",
      hashes: ["cC33"],
      resultContent: "f",
      transactionId: "txn-rem-2",
    });
    writeCutIntent(store, "txn-rem-1", "/txn-a.ts", "revert");
    const listed = listCutIntents(store).find((i) => i.txnId === "txn-rem-1");
    expect(listed?.direction, "the revert arm needs its durable marker").toBe("revert");
    const untouched = listCutIntents(store).find((i) => i.txnId !== "txn-rem-1");
    if (untouched) expect(untouched.direction ?? "forward").not.toBe("revert");

    deleteUndoTransaction(store, "txn-rem-1");
    expect(getUndoEntry(store, "/txn-a.ts")).toBeUndefined();
    expect(getUndoEntry(store, "/txn-b.ts")).toBeUndefined();
    expect(
      getUndoEntry(store, "/txn-c.ts"),
      "one clear must not touch another transaction",
    ).toBeDefined();
    deleteCutIntent(store, "txn-rem-1");
    deleteUndoTransaction(store, "txn-rem-2");
  });

  it("shutdown keeps the new columns durable across reopen", async () => {
    const store: HashStore = await loadHashStore();
    upsertUndo(store, "/reopen.ts", {
      content: "p",
      bom: "",
      ending: "\r\n",
      hashes: ["rE11"],
      resultContent: "q",
      transactionId: "txn-rem-3",
      rawPre: "p\r\n",
    });
    writeCutIntent(store, "txn-rem-3", "/reopen.ts", "revert");
    shutdownHashStore();
    const reopened: HashStore = await loadHashStore();
    expect(getUndoEntry(reopened, "/reopen.ts")?.rawPre).toBe("p\r\n");
    expect(listCutIntents(reopened).find((i) => i.txnId === "txn-rem-3")?.direction).toBe("revert");
    deleteCutIntent(reopened, "txn-rem-3");
    deleteUndoTransaction(reopened, "txn-rem-3");
  });
});
