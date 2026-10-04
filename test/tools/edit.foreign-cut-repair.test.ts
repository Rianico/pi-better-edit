import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
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
  await readTool.execute("r1", { file: "source.txt" }, undefined, undefined, ctx);
  await readTool.execute("r2", { file: "target.txt" }, undefined, undefined, ctx);
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
  await readTool.execute("r9", { file: "misc.txt" }, undefined, undefined, ctx);
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

  // REMEDIATION-2 R2: the rule is write-AHEAD. The seam above proves existence after rename #1
  // only; this witness observes the store at the moment of the FIRST rename, while no byte of
  // the transaction has landed. Mutations refuted: M2a (intent moved between the two renames)
  // and N8 (intent moved after the window) both observe ZERO intents here.
  it("the intent is durable BEFORE the first rename — observed with no byte landed (M2a/N8)", async () => {
    await withTempDir("cut-intent-write-ahead-", async (cwd) => {
      const { hs, ht } = await seedAndServe(cwd);
      const observations: { intents: number; target: string; source: string }[] = [];
      const result = await execute(cutRequest(ht, hs), cwd, {
        sessionKey: TEST_SESSION_ID,
        onBeforeFirstCutWrite: async () => {
          observations.push({
            intents: (await listCutIntentsAsync()).length,
            target: await readFile(join(cwd, "target.txt"), "utf-8"),
            source: await readFile(join(cwd, "source.txt"), "utf-8"),
          });
        },
      });
      expect(isMutationSuccess(result)).toBe(true);
      expect(observations).toHaveLength(1);
      // ORDER, not existence-after-the-fact: intent present AND nothing mutated yet.
      expect(observations[0]!.intents).toBeGreaterThanOrEqual(1);
      expect(observations[0]!.target).toBe(TARGET_BEFORE);
      expect(observations[0]!.source).toBe(SOURCE_BEFORE);
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

  // REMEDIATION P2-2, rollback arm: the LF-uniform seeds above cannot tell a raw restore from a
  // canonical re-fold (they coincide), so the abort witness needs a target whose RAW bytes are
  // not any canonical serialization. Mutation refuted: rolling back with the canonical fold
  // instead of the captured Buffer reddens this test; the fold above stays green because for
  // uniform-ending files the two spellings are equal.
  it("an abort restores the written file's RAW non-canonical bytes (rollback is not a re-serialization)", async () => {
    const TARGET_MIXED_RAW = "1\r\n2\n3\n";
    await withTempDir("cut-rollback-raw-", async (cwd) => {
      await writeFile(join(cwd, "source.txt"), SOURCE_BEFORE, "utf-8");
      await writeFile(join(cwd, "target.txt"), TARGET_MIXED_RAW, "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "source.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "target.txt" }, undefined, undefined, ctx);
      const hs = await lineHashes(SOURCE_BEFORE, `${home.testPath}/source.txt`);
      const ht = await lineHashes("1\n2\n3\n", `${home.testPath}/target.txt`);
      const result = await execute(cutRequest(ht, hs), cwd, {
        sessionKey: TEST_SESSION_ID,
        onCutBetweenWrites: () => {
          throw new Error("injected crash between the renames");
        },
      });
      expect(isMutationFailure(result), "the injected crash must surface as a failure").toBe(true);
      // The rollback is a byte restore: the stray CRLF on the first line must survive untouched.
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_MIXED_RAW);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
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

  // REMEDIATION P2-2: the repair oracle must compare BYTES, because the crash/abort paths rest
  // members at their RAW (never canonically folded) pre-images. A mixed-ending file resting at
  // its original bytes is a legal fence-row state; if the oracle only knows the canonical
  // serialization, that member reads as "other" and the intent leaks forever.
  const SOURCE_MIXED_RAW = "a\r\nb\nc\nd\n";
  // Same lines, so the served anchors match `SOURCE_BEFORE`; the earliest break decides the
  // file's own ending (CRLF), so its canonical form is NOT the raw bytes on disk.
  const MIXED_CANON_POST = "a\r\nd\r\n";

  async function seedMixedSource(cwd: string) {
    await writeFile(join(cwd, "source.txt"), SOURCE_MIXED_RAW, "utf-8");
    await writeFile(join(cwd, "target.txt"), TARGET_BEFORE, "utf-8");
    const { ctx, readTool } = setupIntegrationTest(cwd);
    await readTool.execute("r1", { file: "source.txt" }, undefined, undefined, ctx);
    await readTool.execute("r2", { file: "target.txt" }, undefined, undefined, ctx);
    const hs = await lineHashes(SOURCE_BEFORE, `${home.testPath}/source.txt`);
    const ht = await lineHashes(TARGET_BEFORE, `${home.testPath}/target.txt`);
    return { ctx, readTool, hs, ht };
  }

  it("repair COMPLETES a window whose source rests at its raw non-canonical bytes (mixed endings)", async () => {
    await withTempDir("cut-repair-mixed-complete-", async (cwd) => {
      const { ctx, readTool, hs, ht } = await seedMixedSource(cwd);
      const result = await execute(cutRequest(ht, hs), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      const targetReal = await resolveTarget(join(cwd, "target.txt"));
      const txnId = (await getUndo(targetReal))?.transactionId;
      expect(typeof txnId).toBe("string");
      // Craft the crash residue: the source sits at its UNTOUCHED RAW bytes — legal, but never
      // equal to any canonical serialization. The intent is what a crash after the first rename
      // would have left.
      await writeFile(join(cwd, "source.txt"), SOURCE_MIXED_RAW, "utf-8");
      await saveCutIntent(txnId!, targetReal);

      await triggerRepair(cwd, ctx, readTool);

      // A byte oracle reads the raw resting bytes as PRE and completes; a canonical-text oracle
      // would call it "other" and leak the intent forever.
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(MIXED_CANON_POST);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_POST);
      expect((await listCutIntentsAsync()).find((i) => i.txnId === txnId)).toBeUndefined();
    });
  });

  it("the RESTORE arm writes the member's RAW pre bytes back, not the canonical fold", async () => {
    await withTempDir("cut-repair-mixed-restore-", async (cwd) => {
      const { ctx, readTool, hs, ht } = await seedMixedSource(cwd);
      const result = await execute(cutRequest(ht, hs), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      const targetReal = await resolveTarget(join(cwd, "target.txt"));
      const txnId = (await getUndo(targetReal))?.transactionId;
      expect(typeof txnId).toBe("string");
      // The inverse arm: target never committed (pre), source already retired (canonical post).
      // Repair restores the source — and a restore is not a re-serialization: the file must come
      // back EXACTLY as it was found, stray line-break spellings included.
      await writeFile(join(cwd, "target.txt"), TARGET_BEFORE, "utf-8");
      await saveCutIntent(txnId!, targetReal);

      await triggerRepair(cwd, ctx, readTool);

      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_MIXED_RAW);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
      expect((await listCutIntentsAsync()).find((i) => i.txnId === txnId)).toBeUndefined();
    });
  });

  // REMEDIATION P3-5: fail-closed arms get negative witnesses THROUGH THE ENTRY POINT (E8) — a
  // direct call would prove the arm exists, not that repair places it. Each witness asserts the
  // files are untouched and states exactly what happens to the intent.
  it("a MISSING member is fail-closed: repair touches nothing and keeps the intent", async () => {
    await withTempDir("cut-repair-missing-member-", async (cwd) => {
      const { ctx, readTool, hs, ht } = await seedAndServe(cwd);
      const result = await execute(cutRequest(ht, hs), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      const targetReal = await resolveTarget(join(cwd, "target.txt"));
      const txnId = (await getUndo(targetReal))?.transactionId;
      expect(typeof txnId).toBe("string");
      await saveCutIntent(txnId!, targetReal);
      await rm(join(cwd, "source.txt"));

      await triggerRepair(cwd, ctx, readTool);

      // No crash escapes repair, nothing is re-created, the question stays open.
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_POST);
      const gone = await readFile(join(cwd, "source.txt"), "utf-8").catch(
        (e: unknown) => (e as NodeJS.ErrnoException).code,
      );
      expect(gone).toBe("ENOENT");
      expect((await listCutIntentsAsync()).find((i) => i.txnId === txnId)).toBeDefined();
    });
  });

  it("an intent whose target undo row was overwritten by a later edit is DROPPED, never leaked", async () => {
    await withTempDir("cut-repair-overwritten-row-", async (cwd) => {
      const { ctx, readTool, hs, ht } = await seedAndServe(cwd);
      const result = await execute(cutRequest(ht, hs), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      const targetReal = await resolveTarget(join(cwd, "target.txt"));
      const txnId = (await getUndo(targetReal))?.transactionId;
      expect(typeof txnId).toBe("string");
      // A later ordinary edit re-anchors the target's file_undo row (its transaction id becomes
      // the ordinary NULL): the cut evidence for the target is GONE and nothing can re-create
      // it — the intent can no longer act, only accumulate. Mirror the `rows.length === 0` arm.
      const htPost = await lineHashes(TARGET_POST, `${home.testPath}/target.txt`);
      const later = await execute(
        admit({
          file: "target.txt",
          edits: [{ anchor_from: htPost[0]!, anchor_to: htPost[0]!, text: "B" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(later)).toBe(true);
      await saveCutIntent(txnId!, targetReal);

      await triggerRepair(cwd, ctx, readTool);

      expect((await listCutIntentsAsync()).find((i) => i.txnId === txnId)).toBeUndefined();
      // Fail-closed on bytes: the drop must not smuggle in a write.
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("B\nc\n2\n3\n");
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_POST);
    });
  });
});
