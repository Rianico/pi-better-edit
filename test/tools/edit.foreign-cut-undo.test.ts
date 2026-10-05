import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { lineHashes, initHasher } from "../../src/hashline/index.js";
import { execute, isMutationSuccess } from "../../src/mutation-engine/index.js";
import { normReq, assertReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { getUndo } from "../../src/edit-undo.js";
import { resolveTarget } from "../../src/fs-write.js";
import { listCutIntentsAsync } from "../../src/undo-store.js";
import {
  withTempDir,
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
  getText,
} from "../support/fixtures.js";

// TICKET-04b §4: the correlated undo. Both files of a cut share one `file_undo.transaction_id`;
// undo of EITHER file reverts BOTH, or fails closed with no partial revert. The stale signal is
// the EXISTING `E_UNDO_STALE` code (unchanged registry member, MODEL audience) extended to every
// file of the transaction — the payload names the member that broke freshness.
useTestHome();

beforeAll(async () => {
  await initHasher();
});

const SOURCE_BEFORE = "a\nb\nc\nd\n";
const TARGET_BEFORE = "1\n2\n3\n";

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

async function cutThrough(cwd: string) {
  const { ctx, readTool, editTool, undoTool } = setupIntegrationTest(cwd);
  await writeFile(join(cwd, "source.txt"), SOURCE_BEFORE, "utf-8");
  await writeFile(join(cwd, "target.txt"), TARGET_BEFORE, "utf-8");
  await readTool.execute("r1", { file: "source.txt" }, undefined, undefined, ctx);
  await readTool.execute("r2", { file: "target.txt" }, undefined, undefined, ctx);
  const hs = await lineHashes(SOURCE_BEFORE, join(cwd, "source.txt"));
  const ht = await lineHashes(TARGET_BEFORE, join(cwd, "target.txt"));
  await editTool.execute(
    "e1",
    {
      file: "target.txt",
      edits: [
        {
          anchor_from: ht[0]!,
          anchor_to: ht[0]!,
          text_ref: { anchor_from: hs[1]!, anchor_to: hs[2]!, file: "source.txt", mode: "cut" },
        },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  // Committed cut: target "b\nc\n2\n3\n", source "a\nd\n".
  expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("b\nc\n2\n3\n");
  expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe("a\nd\n");
  return { ctx, undo: undoTool, readTool };
}

describe("correlated undo of a cut transaction (ticket-04b §4)", () => {
  it("undoing the SOURCE reverts BOTH files of the transaction", async () => {
    await withTempDir("cut-undo-source-", async (cwd) => {
      const { ctx, undo } = await cutThrough(cwd);
      const result = await undo.execute("u1", { path: "source.txt" }, undefined, undefined, ctx);
      expect(result.isError, getText(result)).toBeFalsy();
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
    });
  });

  it("undoing the TARGET reverts BOTH files of the transaction", async () => {
    await withTempDir("cut-undo-target-", async (cwd) => {
      const { ctx, undo } = await cutThrough(cwd);
      const result = await undo.execute("u1", { path: "target.txt" }, undefined, undefined, ctx);
      expect(result.isError, getText(result)).toBeFalsy();
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
    });
  });

  it("an outside change to the other member fails undo closed, naming it, with no partial revert", async () => {
    await withTempDir("cut-undo-stale-", async (cwd) => {
      const { ctx, undo } = await cutThrough(cwd);
      await writeFile(join(cwd, "source.txt"), "a\nd\nINJECTED\n", "utf-8");
      const result = await undo.execute("u1", { path: "target.txt" }, undefined, undefined, ctx);
      expect(result.isError, "a stale transaction member must refuse the whole undo").toBe(true);
      const text = getText(result);
      expect(text).toContain("E_UNDO_STALE");
      // The payload names the member that broke freshness, not the requested path.
      expect(text).toContain("source.txt");
      // Fail closed: the requested target is NOT reverted either.
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("b\nc\n2\n3\n");
    });
  });

  it("a deleted member arm: undo fails closed naming the deleted file", async () => {
    await withTempDir("cut-undo-deleted-", async (cwd) => {
      const { ctx, undo } = await cutThrough(cwd);
      await rm(join(cwd, "source.txt"));
      const result = await undo.execute("u1", { path: "target.txt" }, undefined, undefined, ctx);
      expect(result.isError, "a deleted transaction member must refuse the whole undo").toBe(true);
      const text = getText(result);
      expect(text).toContain("E_UNDO_STALE");
      expect(text).toContain("source.txt");
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("b\nc\n2\n3\n");
    });
  });

  // REMEDIATION P2-1 (amended ruling 3): the correlated revert is a DURABLE transaction, not a
  // write ordering. A crash inside the revert window must (a) refuse with a typed [MODEL] code
  // whose registry row selects the retry — never a raw escape, (b) clear NO undo row, (c) leave
  // the revert-intent record so the next run's repair FINISHES the revert with nothing lost.
  // The seam is the undo-side mirror of `onCutBetweenWrites`: test-only, fired from ctx after
  // the first member write. Making the directory read-only defeats the finish-revert write, so
  // the refusal arm is observed with a genuinely half-reverted transaction.
  it("a crash mid-revert: typed refusal, no row cleared, revert intent durable, next run finishes the revert", async () => {
    await withTempDir("cut-undo-crash-", async (cwd) => {
      const { ctx, undo, readTool } = await cutThrough(cwd);
      const targetReal = await resolveTarget(join(cwd, "target.txt"));
      const sourceReal = await resolveTarget(join(cwd, "source.txt"));
      const txnId = (await getUndo(targetReal))?.transactionId;
      expect(typeof txnId).toBe("string");
      let seamFired = false;
      (
        ctx as { onUndoBetweenWrites?: (committedAbsolutePath: string) => void }
      ).onUndoBetweenWrites = () => {
        seamFired = true;
        chmodSync(cwd, 0o500);
        throw new Error("injected P2-1 crash after the first member revert");
      };
      const result = await undo.execute("u1", { path: "target.txt" }, undefined, undefined, ctx);
      chmodSync(cwd, 0o755);

      expect(seamFired, "the undo write seam must fire inside the revert window").toBe(true);
      expect(result.isError, "a defeated revert must refuse, not escape raw").toBe(true);
      const text = getText(result);
      expect(text).toContain("E_UNDO_REVERT_FAILED");
      expect(text, "the code must select the retry: the refusal names the repair").toContain(
        "repair",
      );

      // The half-reverted residue is preserved, NOT hidden by a row clear: source reverted
      // (sorted members are [source.txt, target.txt]), target still at the cut's post bytes.
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("b\nc\n2\n3\n");
      expect((await getUndo(sourceReal))?.transactionId, "no undo row may be cleared").toBe(txnId);
      expect((await getUndo(targetReal))?.transactionId).toBe(txnId);
      const intent = (await listCutIntentsAsync()).find((i) => i.txnId === txnId);
      expect(intent?.direction, "the revert-intent record must be durable").toBe("revert");

      // A retry before the repair is a typed stale refusal (rows survive), never "No undo
      // history" — the residue must not be forgotten just because one member moved.
      const retry = await undo.execute("u2", { path: "target.txt" }, undefined, undefined, ctx);
      expect(getText(retry)).toContain("E_UNDO_STALE");
      expect(getText(retry)).not.toContain("No undo history");

      // THE NEXT RUN REPAIRS: any live edit fires repairCutIntents, which finishes the revert
      // from the rows' pre bytes, then retires the rows and the intent. No content lost.
      await writeFile(join(cwd, "misc.txt"), "m\nn\n", "utf-8");
      await readTool.execute("r9", { file: "misc.txt" }, undefined, undefined, ctx);
      const hm = await lineHashes("m\nn\n", join(cwd, "misc.txt"));
      const trigger = await execute(
        admit({
          file: "misc.txt",
          edits: [{ anchor_from: hm[1]!, anchor_to: hm[1]!, text: "N" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(trigger), "the repair trigger edit must succeed").toBe(true);

      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
      expect(await getUndo(targetReal)).toBeUndefined();
      expect(await getUndo(sourceReal)).toBeUndefined();
      expect((await listCutIntentsAsync()).find((i) => i.txnId === txnId)).toBeUndefined();
    });
  });

  // REMEDIATION-2 R2, revert side: the same write-AHEAD rule observed at the moment of the
  // FIRST revert write — the intent row is present while every member still sits at the cut's
  // post bytes. Mutation refuted: moving `saveCutIntent` after the first revert write (the
  // N8r: the revert-arm mirror of the M2a/N8 forward arm observes ZERO intents here.
  it("the revert intent is durable BEFORE the first revert write", async () => {
    await withTempDir("cut-undo-intent-order-", async (cwd) => {
      const { ctx, undo } = await cutThrough(cwd);
      const observed: { intents: number; target: string; source: string }[] = [];
      (ctx as { onBeforeUndoWrites?: () => void | Promise<void> }).onBeforeUndoWrites =
        async () => {
          observed.push({
            intents: (await listCutIntentsAsync()).length,
            target: await readFile(join(cwd, "target.txt"), "utf-8"),
            source: await readFile(join(cwd, "source.txt"), "utf-8"),
          });
        };
      const result = await undo.execute("u1", { path: "target.txt" }, undefined, undefined, ctx);
      expect(result.isError, getText(result)).toBeFalsy();
      expect(observed).toHaveLength(1);
      expect(observed[0]!.intents).toBeGreaterThanOrEqual(1);
      expect(observed[0]!.target, "no revert byte may have landed when the intent was read").toBe(
        "b\nc\n2\n3\n",
      );
      expect(observed[0]!.source).toBe("a\nd\n");
    });
  });

  // REMEDIATION-2 R3: the E_UNKNOWN wrapper is on a LIVE path — an unexpected filesystem failure
  // (a member replaced by a DIRECTORY: validation's byte read answers EISDIR, a code the typed
  // stale arms do not claim) must surface as the [MODEL] envelope, never a raw escape.
  // Mutation refuted: N7 (delete the wrap and re-throw) escapes EISDIR out of the tool and this
  // witness fails on the raw throw instead of seeing the envelope.
  it("an unexpected failure in the correlated revert surfaces as the [MODEL] E_UNKNOWN envelope", async () => {
    await withTempDir("cut-undo-eisdir-", async (cwd) => {
      const { ctx, undo } = await cutThrough(cwd);
      await rm(join(cwd, "source.txt"));
      await mkdir(join(cwd, "source.txt"));
      const result = await undo.execute("u1", { path: "target.txt" }, undefined, undefined, ctx);
      expect(result.isError, "an unexpected filesystem failure must not escape raw").toBe(true);
      const text = getText(result);
      expect(text).toContain("[MODEL]");
      expect(text).toContain("E_UNKNOWN");
      // Fail closed and durably honest: nothing reverted, the requested member still at post.
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("b\nc\n2\n3\n");
      await expect(readFile(join(cwd, "source.txt"))).rejects.toThrow(/EISDIR/);
    });
  });
});
