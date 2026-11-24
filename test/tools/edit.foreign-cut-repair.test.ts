import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execute, isMutationSuccess, isMutationFailure } from "../../src/mutation-engine/index.js";
import { normReq, assertReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { lineHashes, initHasher } from "../../src/hashline/hash-identity.js";
import { resolveTarget } from "../../src/fs-write.js";
import { getUndo } from "../../src/edit-undo.js";
import { saveCutIntent, listCutIntentsAsync } from "../../src/undo-store.js";
import {
  withTempDir,
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
} from "../support/fixtures.js";

/**
 * The durable cut's honest window (ticket-04b §2/§3, ADR-0017): no filesystem atomicity is claimed —
 * two files mean two renames with a real window between them. Pinned here are the ORDER (the target
 * insert is durably committed before the destructive source retirement, observed from inside the
 * window), the write-ahead intent record, and next-run repair resolving a half-applied window with
 * no content lost, in either direction.
 *
 * `onCutBetweenWrites` and `onBeforeFirstCutWrite` are the TEST-ONLY fault seams into that window
 * (`PipelineOptions`); both fire once the previous write is durable. Crafted crash states reuse only
 * public store APIs (`saveCutIntent`, `listCutIntentsAsync`, `getUndo`) and real bytes from a
 * committed cut, never an oracle derived from the implementation under test.
 */
useTestHome();

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
  const hs = await lineHashes(SOURCE_BEFORE, join(cwd, "source.txt"));
  const ht = await lineHashes(TARGET_BEFORE, join(cwd, "target.txt"));
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

async function triggerRepair(
  cwd: string,
  ctx: unknown,
  readTool: { execute: (...a: any[]) => Promise<unknown> },
) {
  await writeFile(join(cwd, "misc.txt"), "m\nn\n", "utf-8");
  await readTool.execute("r9", { file: "misc.txt" }, undefined, undefined, ctx);
  const hm = await lineHashes("m\nn\n", join(cwd, "misc.txt"));
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
      expect(observations).toEqual(["target-first", TARGET_POST, SOURCE_BEFORE]);
      expect(intentsAtSeam[0]).toBeGreaterThanOrEqual(1);
    });
  });

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
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
      expect((await listCutIntentsAsync()).length).toBe(intentsBefore);
    });
  });

  it("an abort restores the written file's RAW non-canonical bytes (rollback is not a re-serialization)", async () => {
    const TARGET_MIXED_RAW = "1\r\n2\n3\n";
    await withTempDir("cut-rollback-raw-", async (cwd) => {
      await writeFile(join(cwd, "source.txt"), SOURCE_BEFORE, "utf-8");
      await writeFile(join(cwd, "target.txt"), TARGET_MIXED_RAW, "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "source.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "target.txt" }, undefined, undefined, ctx);
      const hs = await lineHashes(SOURCE_BEFORE, join(cwd, "source.txt"));
      const ht = await lineHashes("1\n2\n3\n", join(cwd, "target.txt"));
      const result = await execute(cutRequest(ht, hs), cwd, {
        sessionKey: TEST_SESSION_ID,
        onCutBetweenWrites: () => {
          throw new Error("injected crash between the renames");
        },
      });
      expect(isMutationFailure(result), "the injected crash must surface as a failure").toBe(true);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_MIXED_RAW);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
    });
  });

  it("repair on the next run COMPLETES a half-applied window with no content lost", async () => {
    await withTempDir("cut-repair-complete-", async (cwd) => {
      const { ctx, readTool, hs, ht } = await seedAndServe(cwd);
      const result = await execute(cutRequest(ht, hs), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      const targetReal = await resolveTarget(join(cwd, "target.txt"));
      const txnId = (await getUndo(targetReal))?.transactionId;
      expect(typeof txnId).toBe("string");
      await writeFile(join(cwd, "source.txt"), SOURCE_BEFORE, "utf-8");
      await saveCutIntent(txnId!, targetReal);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_POST);

      await triggerRepair(cwd, ctx, readTool);

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
      const outside = "totally\noutside\n";
      await writeFile(join(cwd, "source.txt"), outside, "utf-8");

      await triggerRepair(cwd, ctx, readTool);

      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(outside);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_POST);
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
      await saveCutIntent(txnId!, targetReal);

      await triggerRepair(cwd, ctx, readTool);

      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_POST);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_POST);
      expect((await listCutIntentsAsync()).find((i) => i.txnId === txnId)).toBeUndefined();
      expect((await getUndo(targetReal))?.transactionId).toBe(txnId);
    });
  });

  const SOURCE_MIXED_RAW = "a\r\nb\nc\nd\n";
  // Ref: docs/adr/0019-eol-rewrite-normalized-undo-and-the-eol-config.md — 3 LF vs 1 CRLF, so the effective ending is LF and this retirement write normalizes.
  const MIXED_CANON_POST = "a\nd\n";

  async function seedMixedSource(cwd: string) {
    await writeFile(join(cwd, "source.txt"), SOURCE_MIXED_RAW, "utf-8");
    await writeFile(join(cwd, "target.txt"), TARGET_BEFORE, "utf-8");
    const { ctx, readTool } = setupIntegrationTest(cwd);
    await readTool.execute("r1", { file: "source.txt" }, undefined, undefined, ctx);
    await readTool.execute("r2", { file: "target.txt" }, undefined, undefined, ctx);
    const hs = await lineHashes(SOURCE_BEFORE, join(cwd, "source.txt"));
    const ht = await lineHashes(TARGET_BEFORE, join(cwd, "target.txt"));
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
      await writeFile(join(cwd, "source.txt"), SOURCE_MIXED_RAW, "utf-8");
      await saveCutIntent(txnId!, targetReal);

      await triggerRepair(cwd, ctx, readTool);

      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(MIXED_CANON_POST);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_POST);
      expect((await listCutIntentsAsync()).find((i) => i.txnId === txnId)).toBeUndefined();
    });
  });

  it("mixed source retirement normalizes to LF and warns once", async () => {
    await withTempDir("cut-mixed-source-eol-", async (cwd) => {
      const { hs, ht } = await seedMixedSource(cwd);
      const result = await execute(cutRequest(ht, hs), cwd, { sessionKey: TEST_SESSION_ID });

      expect(isMutationSuccess(result), "the cut must apply").toBe(true);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(MIXED_CANON_POST);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_POST);
      if (!isMutationSuccess(result)) return;
      const text = result.toolResult.content.map((c) => c.text).join("\n");
      expect(text.split("W_EOL_REWRITTEN"), "one warning, source-attributed").toHaveLength(2);
      expect(text).toContain(
        "[W_EOL_REWRITTEN] EOL normalized to LF (file): 1 terminators changed.",
      );
    });
  });

  it("mixed target normalizes to LF and warns once", async () => {
    const TARGET_MIXED_RAW = "1\r\n2\n3\n";
    await withTempDir("cut-mixed-target-eol-", async (cwd) => {
      await writeFile(join(cwd, "source.txt"), SOURCE_BEFORE, "utf-8");
      await writeFile(join(cwd, "target.txt"), TARGET_MIXED_RAW, "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "source.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "target.txt" }, undefined, undefined, ctx);
      const hs = await lineHashes(SOURCE_BEFORE, join(cwd, "source.txt"));
      const ht = await lineHashes(TARGET_BEFORE, join(cwd, "target.txt"));

      const result = await execute(cutRequest(ht, hs), cwd, { sessionKey: TEST_SESSION_ID });

      expect(isMutationSuccess(result), "the cut must apply").toBe(true);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("b\nc\n2\n3\n");
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe("a\nd\n");
      if (!isMutationSuccess(result)) return;
      const text = result.toolResult.content.map((c) => c.text).join("\n");
      expect(text.split("W_EOL_REWRITTEN"), "one warning, target-attributed").toHaveLength(2);
      expect(text).toContain(
        "[W_EOL_REWRITTEN] EOL normalized to LF (file): 1 terminators changed.",
      );
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
      await writeFile(join(cwd, "target.txt"), TARGET_BEFORE, "utf-8");
      await saveCutIntent(txnId!, targetReal);

      await triggerRepair(cwd, ctx, readTool);

      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_MIXED_RAW);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
      expect((await listCutIntentsAsync()).find((i) => i.txnId === txnId)).toBeUndefined();
    });
  });

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
      const htPost = await lineHashes(TARGET_POST, join(cwd, "target.txt"));
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
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("B\nc\n2\n3\n");
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_POST);
    });
  });
});
