import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, isMutationSuccess, isMutationFailure } from "../../src/mutation-engine/index.js";
import { normReq, assertReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { lineHashes, initHasher } from "../../src/hashline/index.js";
import { resolveTarget } from "../../src/fs-write.js";
import { getUndo } from "../../src/edit-undo.js";
import { saveCutIntent, listCutIntentsAsync } from "../../src/undo-store.js";
import {
  withTempDir,
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
} from "../support/fixtures.js";

// TICKET-04b §2/§3: the honest durability story. NO filesystem atomicity is claimed: two files
// mean two renames with a real window between them. The witnesses here are (1) the ORDER — the
// target insert is durably committed before the destructive source retirement, observed from
// INSIDE the window; (2) the durable intent record, present before the first rename; (3) repair
// on the next run resolving a half-applied window with NO content lost, in either direction.
//
// `onCutBetweenWrites` is the TEST-ONLY fault seam into the window (PipelineOptions): it fires
// after the previous rename is durable. Crafted states reuse only public store APIs (saveUndo /
// saveCutIntent / listCutIntentsAsync) and real bytes from a committed cut — no oracle is
// derived from the implementation under test.
const home = useTestHome();

beforeAll(async () => {
  await initHasher();
});

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

const SOURCE_BEFORE = "a\nb\nc\nd\n";
const TARGET_BEFORE = "1\n2\n3\n";
const TARGET_POST = "b\nc\n2\n3\n";
const SOURCE_POST = "a\nd\n";

async function seedAndServe(cwd: string) {
  await writeFile(join(cwd, "source.txt"), SOURCE_BEFORE, "utf-8");
  await writeFile(join(cwd, "target.txt"), TARGET_BEFORE, "utf-8");
  const { ctx, readTool } = setupIntegrationTest(cwd);
  await readTool.execute("r1", { path: "source.txt" }, undefined, undefined, ctx);
  await readTool.execute("r2", { path: "target.txt" }, undefined, undefined, ctx);
  const hs = await lineHashes(SOURCE_BEFORE, `${home.testPath}/source.txt`);
  const ht = await lineHashes(TARGET_BEFORE, `${home.testPath}/target.txt`);
  return { ctx, readTool, hs, ht };
}

function cutRequest(ht: string[], hs: string[]): NormalizedEditRequest {
  return admit({
    file: "target.txt",
    edits: [
      {
        anchor_from: ht[0]!,
        anchor_to: ht[0]!,
        text_ref: { anchor_from: hs[1]!, anchor_to: hs[2]!, file: "source.txt", mode: "cut" },
      },
    ],
  });
}

/** Drive a small unrelated same-file edit through the REAL entry point: its apply() must repair. */
async function triggerRepair(
  cwd: string,
  ctx: unknown,
  readTool: { execute: (...a: any[]) => Promise<unknown> },
) {
  await writeFile(join(cwd, "misc.txt"), "m\nn\n", "utf-8");
  await readTool.execute("r9", { path: "misc.txt" }, undefined, undefined, ctx);
  const hm = await lineHashes("m\nn\n", `${home.testPath}/misc.txt`);
  const result = await execute(
    admit({ file: "misc.txt", edits: [{ anchor_from: hm[1]!, anchor_to: hm[1]!, text: "N" }] }),
    cwd,
    { sessionKey: TEST_SESSION_ID },
  );
  expect(isMutationSuccess(result), "the repair trigger edit must succeed").toBe(true);
}

describe("foreign-cut durability: window state, intent record, next-run repair (§2/§3)", () => {
  it("inside the window: the target is already committed, the source not yet retired, and the intent is durable", async () => {
    await withTempDir("cut-window-order-", async (cwd) => {
      const { hs, ht } = await seedAndServe(cwd);
      const observations: string[] = [];
      const intentsAtSeam: number[] = [];
      const result = await execute(cutRequest(ht, hs), cwd, {
        sessionKey: TEST_SESSION_ID,
        onCutBetweenWrites: async (committedAbsolutePath) => {
          const targetReal = await resolveTarget(join(cwd, "target.txt"));
          observations.push(committedAbsolutePath === targetReal ? "target-first" : "source-first");
          observations.push(await readFile(join(cwd, "target.txt"), "utf-8"));
          observations.push(await readFile(join(cwd, "source.txt"), "utf-8"));
          intentsAtSeam.push((await listCutIntentsAsync()).length);
        },
      });
      expect(isMutationSuccess(result)).toBe(true);
      // ORDER PROOF (§3 inverse-ordering arm): the seam fires with the TARGET committed and the
      // SOURCE still at its pre-transaction bytes. If the implementation retired the source
      // first, the committed path and both byte reads would differ — data loss, not duplication.
      expect(observations).toEqual(["target-first", TARGET_POST, SOURCE_BEFORE]);
      // The durable intent record exists BEFORE the first rename, so it exists inside the window.
      expect(intentsAtSeam[0]).toBeGreaterThanOrEqual(1);
    });
  });

  it("a throw inside the two-rename window aborts: both files byte-identical to pre, intent retired", async () => {
    await withTempDir("cut-window-abort-", async (cwd) => {
      const { hs, ht } = await seedAndServe(cwd);
      const intentsBefore = (await listCutIntentsAsync()).length;
      const result = await execute(cutRequest(ht, hs), cwd, {
        sessionKey: TEST_SESSION_ID,
        onCutBetweenWrites: () => {
          throw new Error("injected crash between the renames");
        },
      });
      expect(isMutationFailure(result), "the injected crash must surface as a failure").toBe(true);
      // §11(2) rollback row: BOTH files byte-identical to their pre-transaction contents.
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
      // The rollback completed, so the intent it recorded is retired — nothing is left to repair.
      expect((await listCutIntentsAsync()).length).toBe(intentsBefore);
    });
  });

  it("repair on the next run COMPLETES a half-applied window with no content lost", async () => {
    await withTempDir("cut-repair-complete-", async (cwd) => {
      const { ctx, readTool, hs, ht } = await seedAndServe(cwd);
      const result = await execute(cutRequest(ht, hs), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      // Craft the crash window from the committed cut: undo rows + transaction id are real; set
      // the source back to its pre bytes and re-record the intent the crash would have left.
      const targetReal = await resolveTarget(join(cwd, "target.txt"));
      const txnId = (await getUndo(targetReal))?.transactionId;
      expect(typeof txnId).toBe("string");
      await writeFile(join(cwd, "source.txt"), SOURCE_BEFORE, "utf-8");
      await saveCutIntent(txnId!, targetReal);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_POST);

      await triggerRepair(cwd, ctx, readTool);

      // Completed: the retirement that the crash dropped is re-applied from the undo row's own
      // post bytes — no content lost (the copy at the target already landed).
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_POST);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_POST);
      expect((await listCutIntentsAsync()).find((i) => i.txnId === txnId)).toBeUndefined();
    });
  });

  it("repair RESTORES both members when the target never committed (defensive inverse arm)", async () => {
    await withTempDir("cut-repair-restore-", async (cwd) => {
      const { ctx, readTool, hs, ht } = await seedAndServe(cwd);
      const result = await execute(cutRequest(ht, hs), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      const targetReal = await resolveTarget(join(cwd, "target.txt"));
      const txnId = (await getUndo(targetReal))?.transactionId;
      expect(typeof txnId).toBe("string");
      // The unreachable-by-construction state (source retired, target not): repair restores the
      // source from its undo row's pre bytes; the target already sits at pre.
      await writeFile(join(cwd, "target.txt"), TARGET_BEFORE, "utf-8");
      await saveCutIntent(txnId!, targetReal);

      await triggerRepair(cwd, ctx, readTool);

      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
      expect((await listCutIntentsAsync()).find((i) => i.txnId === txnId)).toBeUndefined();
    });
  });

  it("repair touches NOTHING when a member drifted outside and keeps the intent", async () => {
    await withTempDir("cut-repair-outside-", async (cwd) => {
      const { ctx, readTool, hs, ht } = await seedAndServe(cwd);
      const result = await execute(cutRequest(ht, hs), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      const targetReal = await resolveTarget(join(cwd, "target.txt"));
      const txnId = (await getUndo(targetReal))?.transactionId;
      expect(typeof txnId).toBe("string");
      await saveCutIntent(txnId!, targetReal);
      // Neither pre nor post — an outside write owns the source now. Repair must not overwrite it.
      const outside = "totally\noutside\n";
      await writeFile(join(cwd, "source.txt"), outside, "utf-8");

      await triggerRepair(cwd, ctx, readTool);

      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(outside);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_POST);
      // Intent kept: the ambiguous state is never silently erased; a human/next decision can act.
      expect((await listCutIntentsAsync()).find((i) => i.txnId === txnId)).toBeDefined();
    });
  });

  it("repair drops a stale intent when both members already reached post (crash after the last rename)", async () => {
    await withTempDir("cut-repair-allpost-", async (cwd) => {
      const { ctx, readTool, hs, ht } = await seedAndServe(cwd);
      const result = await execute(cutRequest(ht, hs), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      const targetReal = await resolveTarget(join(cwd, "target.txt"));
      const txnId = (await getUndo(targetReal))?.transactionId;
      expect(typeof txnId).toBe("string");
      // Both files are already post; only the intent-drop failed. Repair must retire the intent
      // and keep the correlated undo rows alive (undo of the completed cut still works).
      await saveCutIntent(txnId!, targetReal);

      await triggerRepair(cwd, ctx, readTool);

      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_POST);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_POST);
      expect((await listCutIntentsAsync()).find((i) => i.txnId === txnId)).toBeUndefined();
      expect((await getUndo(targetReal))?.transactionId).toBe(txnId);
    });
  });
});
