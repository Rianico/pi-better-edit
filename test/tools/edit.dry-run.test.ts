/**
 * (ticket #336) `dry_run` — the edit answers with the would-be diff and touches nothing else. No byte
 * write, no undo row, no snapshot/lineage/lease upsert, no served rows, and no noop-loop tally: the
 * run is `noPersist` plus one more rule, that the hypothetical diff serves no anchor. Added rows
 * therefore print the empty 4-space gutter (a dry run commits nothing a later call could honour)
 * while context rows keep the anchors the session already holds. Failures stay the live failures:
 * a dry run is never more permissive than the write it predicts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, isMutationFailure, isMutationSuccess } from "../../src/mutation-engine/index.js";
import { assertReq, normReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { initHasher, lineHashes } from "../../src/hashline/hash-identity.js";
import { loadHashStore } from "../../src/hash-store.js";
import { getServed, loadLeases } from "../../src/served-session/session.js";
import { resolveTarget } from "../../src/fs-write.js";
import { createEditTool } from "../../src/edit-tool.js";
import { NOOP_LOOP_THRESHOLD } from "../../src/constants.js";
import {
  TEST_SESSION_ID,
  getText,
  setupIntegrationTest,
  useTestHome,
  withTempFile,
} from "../support/fixtures.js";

useTestHome();

beforeAll(async () => {
  await initHasher();
});

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

/** The ledger a dry run must not touch: undo rows, the session's served mirror, and its leases. */
async function ledgerDigest(
  absolutePath: string,
): Promise<{ undo: number; served: string; leases: string }> {
  const store = await loadHashStore();
  const row = store.db.prepare("SELECT COUNT(*) AS n FROM file_undo").get() as { n: number };
  return {
    undo: row.n,
    served: JSON.stringify(getServed(store, TEST_SESSION_ID, absolutePath)),
    leases: JSON.stringify(loadLeases(store, TEST_SESSION_ID, absolutePath)),
  };
}

/**
 * Runs one scenario with the same setup twice, `dry_run: true` then `false`, and returns each run's
 * failure code plus the bytes left on disk. Two separate temp files keep the fixtures identical, so
 * a code difference can only come from the dry-run wiring.
 */
async function failureParity(input: {
  name: string;
  content: string;
  /** A path the scenario is expected NOT to create, read after each run. */
  probe?: string;
  build: (args: { cwd: string; path: string }) => Promise<Record<string, unknown>>;
}): Promise<{
  dry: { code: string; bytes: string | null; probe: string | null };
  live: { code: string; bytes: string | null; probe: string | null };
}> {
  const run = async (dryRun: boolean) => {
    let captured: { code: string; bytes: string | null; probe: string | null } | undefined;
    await withTempFile(input.name, input.content, async ({ cwd, path }) => {
      const raw = await input.build({ cwd, path });
      const request = admit({ ...raw, dry_run: dryRun });
      const result = await execute(request, cwd, { sessionKey: TEST_SESSION_ID });
      const bytes = await readFile(path, "utf-8").catch(() => null);
      const probe =
        input.probe === undefined
          ? null
          : await readFile(join(cwd, input.probe), "utf-8").catch(() => null);
      captured = {
        code: isMutationFailure(result) ? result.code : "success",
        bytes,
        probe,
      };
    });
    return captured!;
  };
  return { dry: await run(true), live: await run(false) };
}

describe("edit dry_run — zero persistence", () => {
  it("leaves bytes, mtime, undo rows, served rows and leases untouched and answers with the diff", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const absolutePath = await resolveTarget(path);
      const hashes = await lineHashes(content, absolutePath);

      const before = {
        bytes: await readFile(path, "utf-8"),
        mtimeMs: (await stat(path)).mtimeMs,
        ledger: await ledgerDigest(absolutePath),
      };
      expect(before.ledger.served, "the serve must have recorded rows to protect").not.toBe("[]");

      const tool = createEditTool();
      const result = await tool.execute(
        {
          file: "sample.txt",
          dry_run: true,
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "B" }],
        },
        undefined,
        ctx,
      );

      const after = {
        bytes: await readFile(path, "utf-8"),
        mtimeMs: (await stat(path)).mtimeMs,
        ledger: await ledgerDigest(absolutePath),
      };
      expect(after.bytes, "dry run must not write bytes").toBe(content);
      expect(after.mtimeMs, "dry run must not touch the file").toBe(before.mtimeMs);
      expect(after.ledger.undo, "dry run must not append an undo row").toBe(before.ledger.undo);
      expect(after.ledger.served, "dry run must not record served rows").toBe(before.ledger.served);
      expect(after.ledger.leases, "dry run must not retire or extend a lease").toBe(
        before.ledger.leases,
      );

      const text = getText(result);
      expect(text, "the would-be diff must be answered").toContain("B");
      expect(text, "a removed row keeps the old anchor").toMatch(/^-[A-Za-z0-9]{4}│b$/m);
    });
  });

  it("prints added rows with the empty gutter while context rows keep their anchors", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const absolutePath = await resolveTarget(path);
      const hashes = await lineHashes(content, absolutePath);

      const result = await createEditTool().execute(
        {
          file: "sample.txt",
          dry_run: true,
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "a\nNEW" }],
        },
        undefined,
        ctx,
      );

      const text = getText(result);
      expect(text, "an added row renders the empty 4-space gutter").toMatch(/^\+ {4}│NEW$/m);
      expect(text, "a dry run serves no added anchor").not.toMatch(/^\+[A-Za-z0-9]{4}│/m);
      expect(text, "a context row the session already holds keeps its anchor").toMatch(
        /^ [A-Za-z0-9]{4}│/m,
      );
      expect(await readFile(path, "utf-8")).toBe(content);
    });
  });

  it("publishes no served rows and no content hash for the hypothetical result", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const absolutePath = await resolveTarget(path);
      const hashes = await lineHashes(content, absolutePath);

      const result = await createEditTool().execute(
        {
          file: "sample.txt",
          dry_run: true,
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "B" }],
        },
        undefined,
        ctx,
      );

      const details = result.details as {
        servedRows?: unknown[];
        servedByPath?: unknown[];
        contentHash?: string;
      };
      expect(details.servedRows, "no hypothetical anchor may be published").toEqual([]);
      expect(details.servedByPath, "no hypothetical file entry may be published").toEqual([]);
      expect("contentHash" in details, "a dry run publishes no content identity").toBe(false);
      expect(getText(result), "the would-be diff is still answered").toContain("B");
    });
  });

  it("the live path still publishes served rows and a content hash", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const absolutePath = await resolveTarget(path);
      const hashes = await lineHashes(content, absolutePath);

      const result = await createEditTool().execute(
        {
          file: "sample.txt",
          dry_run: false,
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "B" }],
        },
        undefined,
        ctx,
      );

      const details = result.details as {
        servedRows?: unknown[];
        servedByPath?: unknown[];
        contentHash?: string;
      };
      expect(details.servedByPath?.length, "a live edit still serves its rows").toBeGreaterThan(0);
      expect(details.servedRows?.length, "a live edit still publishes its anchors").toBeGreaterThan(
        0,
      );
      expect("contentHash" in details, "a live edit still publishes its content identity").toBe(
        true,
      );
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\n");
    });
  });
});

describe("edit dry_run — fail-closed parity with the live path", () => {
  it("a stale anchor fails with the same code and writes nothing in both modes", async () => {
    const { dry, live } = await failureParity({
      name: "sample.txt",
      content: "a\nb\nc\n",
      build: async ({ cwd, path }) => {
        const { ctx, readTool } = setupIntegrationTest(cwd);
        await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
        const absolutePath = await resolveTarget(path);
        const hashes = await lineHashes("a\nb\nc\n", absolutePath);
        await writeFile(path, "a\nDRIFTED\nc\n", "utf-8");
        return {
          file: "sample.txt",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BB" }],
        };
      },
    });
    expect(dry.code).not.toBe("success");
    expect(dry.code).toBe(live.code);
    expect(dry.bytes).toBe("a\nDRIFTED\nc\n");
    expect(live.bytes).toBe("a\nDRIFTED\nc\n");
  });

  it("a never-served anchor fails with the same code and writes nothing in both modes", async () => {
    const { dry, live } = await failureParity({
      name: "sample.txt",
      content: "a\nb\nc\n",
      build: async ({ path }) => {
        const absolutePath = await resolveTarget(path);
        const hashes = await lineHashes("a\nb\nc\n", absolutePath);
        return {
          file: "sample.txt",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "B" }],
        };
      },
    });
    expect(dry.code).not.toBe("success");
    expect(dry.code).toBe(live.code);
    expect(dry.bytes).toBe("a\nb\nc\n");
    expect(live.bytes).toBe("a\nb\nc\n");
  });

  it("a missing file fails with the same code and creates nothing in both modes", async () => {
    const { dry, live } = await failureParity({
      name: "sample.txt",
      content: "a\nb\nc\n",
      probe: "ghost.txt",
      build: async () => ({
        file: "ghost.txt",
        edits: [{ anchor_from: "aaaa", anchor_to: "aaaa", text: "B" }],
      }),
    });
    expect(dry.code).toBe("E_NOT_FOUND");
    expect(dry.code).toBe(live.code);
    expect(dry.probe, "dry run must not create the missing file").toBeNull();
    expect(live.probe).toBeNull();
    expect(dry.bytes).toBe("a\nb\nc\n");
    expect(live.bytes).toBe("a\nb\nc\n");
  });
});

describe("edit dry_run — noop loop", () => {
  it("never advances the noop-loop counter and leaves the live path usable", async () => {
    const content = "aaa\nbbb\nccc\n";
    await withTempFile("sample.ts", content, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const absolutePath = await resolveTarget(path);
      const hashes = await lineHashes(content, absolutePath);
      const tool = createEditTool();
      const noop = {
        file: "sample.ts",
        dry_run: true,
        edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" }],
      };

      let last: { content: Array<{ text?: string }>; details: unknown } | undefined;
      for (let attempt = 0; attempt < NOOP_LOOP_THRESHOLD + 2; attempt++) {
        last = await tool.execute(noop, undefined, ctx);
        const details = last.details as { classification?: string };
        expect(details.classification, `attempt ${attempt + 1} stays a noop`).toBe("noop");
      }

      const text = getText(last!);
      expect(text, "a dry-run noop never trips the loop guard").not.toContain("[E_NOOP_LOOP]");
      expect(text, "a dry-run noop never emits the loop warning").not.toContain("[W_NOOP]");
      expect(await readFile(path, "utf-8")).toBe(content);

      const live = await tool.execute(
        {
          file: "sample.ts",
          dry_run: false,
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "AAA" }],
        },
        undefined,
        ctx,
      );
      expect(getText(live)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("AAA\nbbb\nccc\n");
    });
  });
});

describe("edit dry_run — engine and tool seams", () => {
  it("the engine derives no-persist from request.dry_run without a noPersist option", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const absolutePath = await resolveTarget(path);
      const hashes = await lineHashes(content, absolutePath);

      const request = admit({
        file: "sample.txt",
        dry_run: true,
        edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "B" }],
      });
      const result = await execute(request, cwd, { sessionKey: TEST_SESSION_ID });

      expect(isMutationFailure(result) ? `${result.code}: ${result.message}` : "committed").toBe(
        "committed",
      );
      expect(await readFile(path, "utf-8"), "engine.execute must not write").toBe(content);
      if (isMutationSuccess(result)) expect(result.diff).toContain("B");
    });
  });

  it("dry_run: false stays a live edit", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const absolutePath = await resolveTarget(path);
      const hashes = await lineHashes(content, absolutePath);

      const result = await createEditTool().execute(
        {
          file: "sample.txt",
          dry_run: false,
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "B" }],
        },
        undefined,
        ctx,
      );

      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\n");
    });
  });
});

describe("edit dry_run — response header (T3)", () => {
  it("answers a dry run with the [DRY RUN] header while the metrics keep the applied vocabulary", async () => {
    const content = "one\ntwo\nthree\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const absolutePath = await resolveTarget(path);
      const hashes = await lineHashes(content, absolutePath);

      const result = await createEditTool().execute(
        {
          file: "sample.txt",
          dry_run: true,
          edits: [
            { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "ONE" },
            { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "TWO" },
          ],
        },
        undefined,
        ctx,
      );

      const details = result.details as {
        dryRun?: boolean;
        metrics?: { classification?: string };
      };
      expect(getText(result)).toContain(
        "[DRY RUN] Validated 1 file(s) — 2 of 2 edit(s) would be applied. Added 2 line(s), removed 2 line(s).",
      );
      expect(details.dryRun, "the payload marks the run as hypothetical").toBe(true);
      expect(
        details.metrics?.classification,
        "classification still names the outcome the bytes would have",
      ).toBe("applied");
      expect(await readFile(path, "utf-8"), "a dry run writes nothing").toBe(content);
    });
  });

  it("answers a dry-run noop with its own header while classifying it noop", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const absolutePath = await resolveTarget(path);
      const hashes = await lineHashes(content, absolutePath);

      const result = await createEditTool().execute(
        {
          file: "sample.txt",
          dry_run: true,
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "b" }],
        },
        undefined,
        ctx,
      );

      const details = result.details as {
        dryRun?: boolean;
        metrics?: { classification?: string };
      };
      expect(getText(result)).toContain(
        "[DRY RUN] No changes would be made. All 1 edit(s) in the call produce identical content.",
      );
      expect(details.dryRun).toBe(true);
      expect(details.metrics?.classification).toBe("noop");
      expect(await readFile(path, "utf-8")).toBe(content);
    });
  });

  it("leaves the live success and noop text byte-identical", async () => {
    const content = "one\ntwo\nthree\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const absolutePath = await resolveTarget(path);
      const hashes = await lineHashes(content, absolutePath);
      const tool = createEditTool();

      const live = await tool.execute(
        {
          file: "sample.txt",
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "ONE" }],
        },
        undefined,
        ctx,
      );
      const liveDetails = live.details as { dryRun?: boolean };
      const liveText = getText(live);
      expect(liveText.startsWith("Successfully edited"), liveText).toBe(true);
      expect(liveText).not.toContain("[DRY RUN]");
      expect("dryRun" in liveDetails, "a live success publishes no dryRun marker").toBe(false);

      const noop = await tool.execute(
        {
          file: "sample.txt",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "two" }],
        },
        undefined,
        ctx,
      );
      const noopText = getText(noop);
      expect(noopText.startsWith("No changes made."), noopText).toBe(true);
      expect(noopText).not.toContain("[DRY RUN]");
      expect(await readFile(path, "utf-8")).toBe("ONE\ntwo\nthree\n");
    });
  });
});
