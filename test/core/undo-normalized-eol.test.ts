/**
 * Ordinary undo restores the pre-edit content at the EOL the edit ACTUALLY wrote (ADR-0019 §4):
 * the row records `effective_ending`, the freshness comparison and the restore write both use it,
 * a pre-edit mixture is NOT resurrected, and the response says so. Cut durability stays byte-exact
 * (ADR-0019 §5): a correlated revert and next-run repair write the RAW pre-image bytes back.
 *
 * ## Repro — `test/core/undo-normalized-eol.test.ts`
 * Case 1 `"a\r\nb\nc"` + b→B writes LF (tie -> LF): BEFORE undo refuses with `E_UNDO_STALE` and
 * would restore `"a\r\nb\r\nc"`; AFTER it restores `"a\nb\nc"`. Case 5 (project `eol: "LF"`)
 * over uniform CRLF is the same defect without a mixture: BEFORE refuses, AFTER `"a\nb\n"`.
 */
import { beforeEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execute, isMutationSuccess } from "../../src/mutation-engine/index.js";
import { normReq, assertReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { toLF } from "../../src/edit-diff.js";
import { EOL_ENV_VAR } from "../../src/eol-config.js";
import { CONFIG_SCHEMA_ID, configFilePath } from "../../src/json-config.js";
import { readBytes, resolveTarget } from "../../src/fs-write.js";
import { initHasher, lineHashes } from "../../src/hashline/hash-identity.js";
import { getUndo } from "../../src/edit-undo.js";
import { saveCutIntent, listCutIntentsAsync, writeUndo } from "../../src/undo-store.js";
import {
  getText,
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
  withTempBytes,
  withTempDir,
} from "../support/fixtures.js";

useTestHome();

beforeAll(async () => {
  await initHasher();
});

beforeEach(() => {
  delete process.env[EOL_ENV_VAR];
});

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

/** SAFETY: a project settings file this test wrote moments ago in its own temp dir. */
async function seedProjectEol(cwd: string, value: string): Promise<void> {
  const path = configFilePath("project", cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ $schema: CONFIG_SCHEMA_ID, eol: value }, null, 2),
    "utf-8",
  );
}

async function expectBytes(path: string, expected: string): Promise<void> {
  const actual = await readBytes(path);
  expect(
    actual.equals(Buffer.from(expected, "utf-8")),
    `bytes must be ${JSON.stringify(expected)}, saw ${JSON.stringify(actual.toString("utf-8"))}`,
  ).toBe(true);
}

function mixtureClause(ending: "LF" | "CRLF" | "CR"): string {
  return `Restored at ${ending}; the pre-edit mixture is not restored.`;
}

/** Serve the raw bytes, then replace one line through the pipeline (`execute`). */
async function serveAndEditLine(
  cwd: string,
  raw: string,
  file: string,
  index: number,
  text: string,
): Promise<{ ctx: unknown; undoTool: ReturnType<typeof setupIntegrationTest>["undoTool"] }> {
  const { ctx, readTool, undoTool } = setupIntegrationTest(cwd);
  await readTool.execute("r1", { file }, undefined, undefined, ctx);
  const anchors = await lineHashes(toLF(raw), join(cwd, file));
  const result = await execute(
    admit({
      file,
      edits: [{ anchor_from: anchors[index]!, anchor_to: anchors[index]!, text }],
    }),
    cwd,
    { sessionKey: TEST_SESSION_ID },
  );
  expect(isMutationSuccess(result), "the edit must apply").toBe(true);
  return { ctx, undoTool };
}

describe("ordinary undo restores at the effective EOL (ADR-0019 §4)", () => {
  it("a tie mixture (CRLF first separator) writes LF, so undo restores LF and drops the mixture", async () => {
    const raw = "a\r\nb\nc";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd, path }) => {
      const { ctx, undoTool } = await serveAndEditLine(cwd, raw, "sample.txt", 1, "B");
      await expectBytes(path, "a\nB\nc");

      const result = await undoTool.execute(
        "u1",
        { path: "sample.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.isError, getText(result)).toBeFalsy();
      await expectBytes(path, "a\nb\nc");
      expect(getText(result)).toContain(mixtureClause("LF"));
    });
  });

  it("a CRLF-majority mixture restores at CRLF and discloses the lost mixture", async () => {
    const raw = "a\r\nb\r\nc\n";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd, path }) => {
      const { ctx, undoTool } = await serveAndEditLine(cwd, raw, "sample.txt", 1, "B");
      await expectBytes(path, "a\r\nB\r\nc\r\n");

      const result = await undoTool.execute(
        "u1",
        { path: "sample.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.isError, getText(result)).toBeFalsy();
      await expectBytes(path, "a\r\nb\r\nc\r\n");
      expect(getText(result)).toContain(mixtureClause("CRLF"));
    });
  });

  it("an LF-majority mixture restores at LF and discloses the lost mixture", async () => {
    const raw = "a\nb\nc\r\n";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd, path }) => {
      const { ctx, undoTool } = await serveAndEditLine(cwd, raw, "sample.txt", 1, "B");
      await expectBytes(path, "a\nB\nc\n");

      const result = await undoTool.execute(
        "u1",
        { path: "sample.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.isError, getText(result)).toBeFalsy();
      await expectBytes(path, "a\nb\nc\n");
      expect(getText(result)).toContain(mixtureClause("LF"));
    });
  });

  it("uniform AUTO controls restore the pre-edit bytes and never claim a mixture", async () => {
    const fixtures = ["a\r\nb\r\n", "a\nb\n", "a\rb\r"];
    for (const raw of fixtures) {
      await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd, path }) => {
        const { ctx, undoTool } = await serveAndEditLine(cwd, raw, "sample.txt", 0, "A");
        const result = await undoTool.execute(
          "u1",
          { path: "sample.txt" },
          undefined,
          undefined,
          ctx,
        );
        expect(result.isError, `${JSON.stringify(raw)}: ${getText(result)}`).toBeFalsy();
        await expectBytes(path, raw);
        expect(getText(result)).not.toContain("the pre-edit mixture is not restored");
      });
    }
  });

  it("a forced project eol writes and restores at that EOL, with no mixture clause", async () => {
    const raw = "a\r\nb\r\n";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd, path }) => {
      await seedProjectEol(cwd, "LF");
      const { ctx, undoTool } = await serveAndEditLine(cwd, raw, "sample.txt", 1, "B");
      await expectBytes(path, "a\nB\n");

      const result = await undoTool.execute(
        "u1",
        { path: "sample.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.isError, getText(result)).toBeFalsy();
      await expectBytes(path, "a\nb\n");
      expect(getText(result)).not.toContain("the pre-edit mixture is not restored");
    });
  });

  it("a legacy row without the new fields falls back to `ending` and claims no mixture", async () => {
    const pre = "a\r\nb\r\nc\r\n";
    const post = "a\r\nB\r\nc\r\n";
    await withTempBytes("sample.txt", Buffer.from(post, "utf-8"), async ({ cwd, path }) => {
      const real = await resolveTarget(path);
      await writeUndo(real, {
        content: "a\nb\nc\n",
        bom: "",
        ending: "\r\n",
        hashes: await lineHashes("a\nb\nc\n", real),
        resultContent: "a\nB\nc\n",
      });
      const { ctx, undoTool } = setupIntegrationTest(cwd);

      const result = await undoTool.execute(
        "u1",
        { path: "sample.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.isError, getText(result)).toBeFalsy();
      await expectBytes(path, pre);
      expect(getText(result)).not.toContain("the pre-edit mixture is not restored");
    });
  });

  it("the mixture clause is pinned after the line counts and before the revert summary", async () => {
    const raw = "a\r\nb\r\nc\n";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd }) => {
      const { ctx, undoTool } = await serveAndEditLine(cwd, raw, "sample.txt", 1, "B");
      const result = await undoTool.execute(
        "u1",
        { path: "sample.txt" },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(result)).toBe(
        [
          "Undone last edit on sample.txt.",
          "Removed 1 line(s) that were added and restored 1 line(s) that were removed.",
          mixtureClause("CRLF"),
          "File reverted; diff rows carry fresh anchors for follow-up edits.",
        ].join("\n"),
      );
    });
  });

  it("an outside rewrite of a mixed file still refuses with E_UNDO_STALE and touches no bytes", async () => {
    const raw = "a\r\nb\nc";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd, path }) => {
      const { ctx, undoTool } = await serveAndEditLine(cwd, raw, "sample.txt", 1, "B");
      await writeFile(path, "a\nX\nc", "utf-8");

      const result = await undoTool.execute(
        "u1",
        { path: "sample.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cannot undo on sample.txt: file modified after edit");
      await expectBytes(path, "a\nX\nc");
    });
  });
});

describe("cut durability stays byte-exact on mixed members (ADR-0019 §5)", () => {
  const TARGET_RAW = "a\r\nb\nc\r\n";
  const SOURCE_RAW = "x\r\ny\nz\r\n";

  async function serveCutPair(cwd: string) {
    await writeFile(join(cwd, "target.txt"), TARGET_RAW, "utf-8");
    await writeFile(join(cwd, "source.txt"), SOURCE_RAW, "utf-8");
    const { ctx, readTool, undoTool } = setupIntegrationTest(cwd);
    await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
    await readTool.execute("r2", { file: "source.txt" }, undefined, undefined, ctx);
    const ht = await lineHashes(toLF(TARGET_RAW), join(cwd, "target.txt"));
    const hs = await lineHashes(toLF(SOURCE_RAW), join(cwd, "source.txt"));
    return { ctx, readTool, undoTool, ht, hs };
  }

  function cutRequest(ht: string[], hs: string[]): NormalizedEditRequest {
    return admit({
      file: "target.txt",
      edits: [
        {
          anchor_from: ht[1]!,
          anchor_to: ht[1]!,
          text_ref: { anchor_from: hs[1]!, anchor_to: hs[1]!, file: "source.txt", mode: "cut" },
        },
      ],
    });
  }

  async function triggerRepair(
    cwd: string,
    ctx: unknown,
    readTool: { execute: (...args: any[]) => Promise<unknown> },
  ): Promise<void> {
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

  it("undoing the cut restores BOTH members to their raw pre-cut bytes, mixture intact", async () => {
    await withTempDir("cut-undo-mixed-", async (cwd) => {
      const { ctx, undoTool, ht, hs } = await serveCutPair(cwd);
      const result = await execute(cutRequest(ht, hs), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result), "the cut must apply").toBe(true);

      const row = await getUndo(await resolveTarget(join(cwd, "target.txt")));
      expect(row?.effectiveEnding).toBe("\r\n");
      expect(row?.preImageMixed, "a cut row never claims a lost mixture").toBe(false);

      const undo = await undoTool.execute("u1", { path: "source.txt" }, undefined, undefined, ctx);
      expect(undo.isError, getText(undo)).toBeFalsy();
      await expectBytes(join(cwd, "target.txt"), TARGET_RAW);
      await expectBytes(join(cwd, "source.txt"), SOURCE_RAW);
    });
  });

  it("next-run repair completes a mixed member byte-exactly, at the EOL the cut wrote", async () => {
    const MIXED_SOURCE_RAW = "x\ny\r\nz\r\n";
    const SOURCE_POST = "x\nz\n";
    await withTempDir("cut-repair-mixed-eol-", async (cwd) => {
      await writeFile(join(cwd, "target.txt"), TARGET_RAW, "utf-8");
      await writeFile(join(cwd, "source.txt"), MIXED_SOURCE_RAW, "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "source.txt" }, undefined, undefined, ctx);
      const ht = await lineHashes(toLF(TARGET_RAW), join(cwd, "target.txt"));
      const hs = await lineHashes(toLF(MIXED_SOURCE_RAW), join(cwd, "source.txt"));

      const inWindow: { target: string; source: string }[] = [];
      const cut = await execute(cutRequest(ht, hs), cwd, {
        sessionKey: TEST_SESSION_ID,
        onCutBetweenWrites: async () => {
          inWindow.push({
            target: (await readBytes(join(cwd, "target.txt"))).toString("utf-8"),
            source: (await readBytes(join(cwd, "source.txt"))).toString("utf-8"),
          });
        },
      });
      expect(isMutationSuccess(cut), "the cut must apply").toBe(true);
      expect(inWindow).toHaveLength(1);

      const targetReal = await resolveTarget(join(cwd, "target.txt"));
      const txnId = (await getUndo(targetReal))?.transactionId;
      expect(typeof txnId).toBe("string");
      const targetPost = inWindow[0]!.target;

      await writeFile(join(cwd, "source.txt"), MIXED_SOURCE_RAW, "utf-8");
      await saveCutIntent(txnId!, targetReal);
      expect((await readBytes(join(cwd, "target.txt"))).toString("utf-8")).toBe(targetPost);
      expect((await readBytes(join(cwd, "source.txt"))).toString("utf-8")).toBe(MIXED_SOURCE_RAW);

      await triggerRepair(cwd, ctx, readTool);

      await expectBytes(join(cwd, "source.txt"), SOURCE_POST);
      expect((await readBytes(join(cwd, "target.txt"))).toString("utf-8")).toBe(targetPost);
      expect(
        (await listCutIntentsAsync()).find((intent) => intent.txnId === txnId),
      ).toBeUndefined();
    });
  });
});
