import { beforeAll, describe, expect, it } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "path";
import { DomainError, formatWarning } from "../../src/domain-errors.js";
import { batchAbort, finalizeResult } from "../../src/edit-response.js";
import { readEnvelope } from "../../src/error-envelope.js";
import { EDIT_DESCRIPTION, EDIT_GUIDELINES } from "../../src/payload-contract.js";
import { createEditTool } from "../../src/edit-tool.js";

import { getServed, loadLeases } from "../../src/served-session/index.js";
import { loadHashStore } from "../../src/hash-store";
import { getSnapshot } from "../../src/snapshot-store";
import { initHasher } from "../../src/hashline/hash-identity.js";
import {
  anchorRows,
  extractHash,
  getText,
  setupIntegrationTest,
  TEST_SESSION_ID,
  withTempDir,
} from "../support/fixtures";
/**
 * T3 (#328): the served edit prompts name the shapes the code emits.
 *
 * Each case renders its shape from the real code path (registry format,
 * batch wrapper, warning renderer) and asserts the served constants —
 * read from the registered constants, never from copies — name it.
 * The lease cases drive REAL rejections through `editTool.execute` (the
 * model seam) and read the leases back through the real store, so text
 * and behaviour stay pinned together.
 */
beforeAll(async () => {
  await initHasher();
});

async function fails(execute: Promise<unknown>): Promise<Error> {
  try {
    await execute;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the edit to be rejected");
}

const FIVE_LINE_CONTENT = "alpha\nbravo\ncharlie\ndelta\necho\n";

/**
 * Shared partial-read fixture (findings 1+2): a 5-line file read ONLY at
 * lines 1, 2 and 5, so the session leases h0, h1, h4 while h2, h3 keep
 * committed lineage (the read snapshot carries every line) but NO lease.
 * A granting recorder would grow the lease set, so `after == before` is red.
 */
async function setupPartialFiveLine(cwd: string) {
  const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
  const name = "p.txt";
  const absPath = join(cwd, name);
  await writeFile(absPath, FIVE_LINE_CONTENT, "utf-8");
  const text = getText(
    await readTool.execute(
      "r1",
      {
        file: name,
        windows: [
          { offset: 1, limit: 2 },
          { offset: 5, limit: 1 },
        ],
      },
      undefined,
      undefined,
      ctx,
    ),
  );
  const served = anchorRows(text);
  expect(served).toHaveLength(3);
  const store = await loadHashStore();
  const snapshot = getSnapshot(store, absPath, FIVE_LINE_CONTENT);
  expect(snapshot).toHaveLength(5);
  const [h0, h1, h2, h3, h4] = snapshot! as [string, string, string, string, string];
  expect(served.map(extractHash)).toEqual([h0, h1, h4]);
  const leased = loadLeases(store, TEST_SESSION_ID, absPath).map((lease) => lease.anchor);
  expect(leased).toEqual([h0, h1, h4]);
  expect(leased).not.toContain(h2);
  expect(leased).not.toContain(h3);
  return {
    ctx,
    editTool,
    absPath,
    store,
    name,
    hashes: { h0, h1, h2, h3, h4 },
    before: leased,
  };
}

describe("served edit prompts name the emitted shapes (T3 #328)", () => {
  const guidelines = EDIT_GUIDELINES.join("\n");

  it("names the fresh-read heading the range family renders", () => {
    const rejection = new DomainError("E_STALE_RANGE", {
      headline: "line 2 in s.txt no longer resolves to the line identity it was served with.",
      servedRows: [{ position: 1, hash: "cD4y" }],
      servedBlock: "cD4y│beta",
      cause: "served-range staleness",
    });
    expect(rejection.message).toContain("Current range (fresh read):");
    expect(guidelines).toContain("Current range (fresh read):");
    expect(EDIT_DESCRIPTION).not.toContain("Current range (fresh read):");
  });

  it("names the Current range heading the anchor tier renders", () => {
    const rejection = new DomainError("E_STALE_ANCHOR", {
      headline: "anchor gone",
      servedRows: [{ position: 0, hash: "abcd" }],
      servedBlock: "abcd│alpha",
      cause: "never-served",
    });
    expect(rejection.message).toContain("Current range:");
    expect(rejection.message).not.toContain("fresh read");
    expect(guidelines).toContain("Current range:");
    expect(EDIT_DESCRIPTION).not.toContain("Current range:");
  });

  it("describes the batch bullet as a code token with the line it opens", () => {
    const inner = new DomainError("E_STALE_ANCHOR", {
      headline: "anchor gone",
      servedRows: [{ position: 0, hash: "abcd" }],
      servedBlock: "abcd│alpha",
      cause: "never-served",
    });
    const rejection = batchAbort({
      failures: [{ error: inner, index: 1 }],
      total: 2,
      path: "s.txt",
    });
    expect(rejection.message).toMatch(/- edit\[1\] \(s\.txt\) \[E_STALE_ANCHOR\]:/);
    expect(EDIT_DESCRIPTION).toContain(
      "An `[E_*]` token and the line it opens are your retry instruction",
    );
    expect(EDIT_DESCRIPTION).not.toMatch(/\[MODEL\][^\n]*\[E_\*\]/);
    expect(guidelines).not.toMatch(/\[MODEL\][^\n]*\[E_\*\]/);
    expect(guidelines).toContain("retry instruction or a rejection");
    expect(guidelines).toContain(
      "in a batch, the verdict line names the audience and `K of N`, and each `- edit[i] (path) [E_*]:` bullet opens that item's instruction.",
    );
  });

  it("states that [USER] lines appear in content and are informational, not refusals", () => {
    const warning = formatWarning("W_NOOP", {
      ref: "edit[1] (s.txt)",
      removeFrom: "abcd",
      removeTo: "efgh",
      batch: false,
      count: 1,
    });
    expect(warning.startsWith("[USER] [W_NOOP]")).toBe(true);
    const text = finalizeResult({
      summary: "No changes made to s.txt",
      diff: "abcd│alpha",
      warnings: [warning],
    });
    expect(text).toContain("[USER] [W_NOOP]");
    expect(EDIT_DESCRIPTION).toContain("[USER]");
    expect(EDIT_DESCRIPTION).toContain("informational, not refusals");
    expect(guidelines).toContain("[USER]");
    expect(guidelines).toContain("not a refusal");
  });

  it("lets the guideline own the lease rule the description deleted (Finding 1)", () => {
    expect(EDIT_DESCRIPTION).not.toContain("recorded as served");
    expect(guidelines).toContain("recorded as served when shown");
    expect(guidelines).toContain("shows no rows grants none");
  });

  it("leases the anchors a fresh-read rejection serves, through the tool seam", async () => {
    await withTempDir("served-stale-range-", async (cwd) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const name = "s.txt";
      const absPath = join(cwd, name);
      await writeFile(absPath, "alpha\nbravo\ncharlie\ndelta\n", "utf-8");
      const rows = anchorRows(
        getText(await readTool.execute("r1", { file: name }, undefined, undefined, ctx)),
      );
      expect(rows).toHaveLength(4);
      const fromHash = extractHash(rows[0]!);
      const toHash = extractHash(rows[2]!);
      await writeFile(absPath, "alpha\nbravo\nINSERTED\ncharlie\ndelta\n", "utf-8");
      const error = await fails(
        editTool.execute(
          "e1",
          { file: name, edits: [{ anchor_from: fromHash, anchor_to: toHash, text: "REPLACED" }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(error.message).toContain("[E_STALE_RANGE]");
      expect(error.message).toContain("Current range (fresh read):");
      const envelope = readEnvelope(error);
      const servedRows = envelope?.servedRows ?? [];
      expect(servedRows.length).toBeGreaterThan(0);
      expect(envelope?.servedBlock).toBeDefined();
      expect(error.message).toContain(envelope?.servedBlock ?? "");
      const leases = loadLeases(await loadHashStore(), TEST_SESSION_ID, absPath).map(
        (lease) => lease.anchor,
      );
      for (const row of servedRows) expect(leases).toContain(row.hash);
      expect(guidelines).toContain("Current range (fresh read):");
      expect(guidelines).toContain("recorded as served when shown");
      expect(EDIT_DESCRIPTION).not.toContain("Current range (fresh read):");
    });
  });

  it("leases the anchors a batch overlap fold serves, through the tool seam", async () => {
    await withTempDir("served-overlap-", async (cwd) => {
      const { ctx, editTool, absPath, store, name, hashes, before } =
        await setupPartialFiveLine(cwd);
      const { h1, h2, h3, h4 } = hashes;
      const error = await fails(
        editTool.execute(
          "e1",
          {
            file: name,
            edits: [
              { anchor_from: h1, anchor_to: h1, text: "X" },
              { anchor_from: h1, anchor_to: h4, text: "Y" },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(error.message).toContain("[E_BATCH_ABORT]");
      expect(error.message).toContain("overlaps");
      expect(error.message).toContain("Current range:");
      const envelope = readEnvelope(error);
      const servedRows = envelope?.servedRows ?? [];
      expect(servedRows.length).toBeGreaterThan(0);
      const blockHashes = (envelope?.servedBlock ?? "")
        .split("\n")
        .filter((line) => line.includes("│"))
        .map((line) => line.split("│")[0]);
      expect(blockHashes).toContain(h2);
      expect(blockHashes).toContain(h3);
      expect(before).not.toContain(h2);
      expect(before).not.toContain(h3);
      expect(blockHashes.some((hash) => !before.includes(hash!))).toBe(true);
      const after = loadLeases(store, TEST_SESSION_ID, absPath).map((lease) => lease.anchor);
      for (const hash of blockHashes) expect(after).toContain(hash);
      expect(after).toContain(h2);
      expect(after).toContain(h3);
      expect(guidelines).not.toContain("a batch overlap shows the anchors it compared");
      expect(EDIT_DESCRIPTION).not.toContain("recorded as served");
    });
  });

  it("accepts a retry that reuses an overlap-shown anchor with no intervening read", async () => {
    await withTempDir("served-overlap-retry-", async (cwd) => {
      const { ctx, editTool, absPath, name, hashes, before } = await setupPartialFiveLine(cwd);
      const { h1, h2, h4 } = hashes;
      const refusal = await fails(
        editTool.execute(
          "e1",
          {
            file: name,
            edits: [
              { anchor_from: h1, anchor_to: h1, text: "X" },
              { anchor_from: h1, anchor_to: h4, text: "Y" },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(refusal.message).toContain("[E_BATCH_ABORT]");
      const servedRows = readEnvelope(refusal)?.servedRows ?? [];
      expect(servedRows.length).toBeGreaterThan(0);
      expect(servedRows.map((row) => row.hash)).toContain(h2);
      expect(before).not.toContain(h2);
      const ok = await editTool.execute(
        "e2",
        { file: name, edits: [{ anchor_from: h2, anchor_to: h2, text: "CHARLIE!" }] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(ok)).toContain("Successfully edited");
      expect(await readFile(absPath, "utf-8")).toContain("CHARLIE!");
    });
  });

  it("grants nothing durable when the same overlap rejection runs as a preview", async () => {
    await withTempDir("served-overlap-preview-", async (cwd) => {
      const { ctx, absPath, store, name, hashes, before } = await setupPartialFiveLine(cwd);
      const { h1, h4 } = hashes;
      const servedBefore = getServed(store, TEST_SESSION_ID, absPath);
      const result = await createEditTool().preview(
        {
          file: name,
          edits: [
            { anchor_from: h1, anchor_to: h1, text: "X" },
            { anchor_from: h1, anchor_to: h4, text: "Y" },
          ],
        },
        cwd,
        ctx,
      );
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("[E_BATCH_ABORT]");
        expect(result.error).toContain("overlaps");
      }
      const servedAfter = getServed(store, TEST_SESSION_ID, absPath);
      expect(servedAfter).toEqual(servedBefore);
      const after = loadLeases(store, TEST_SESSION_ID, absPath).map((lease) => lease.anchor);
      expect(after).toEqual(before);
      expect(await readFile(absPath, "utf-8")).toBe(FIVE_LINE_CONTENT);
    });
  });

  it("grants nothing for a rowless rejection, through the tool seam", async () => {
    await withTempDir("served-rowless-", async (cwd) => {
      const { ctx, editTool, absPath, store, name, hashes, before } =
        await setupPartialFiveLine(cwd);
      const { h2 } = hashes;
      const error = await fails(
        editTool.execute(
          "e1",
          { file: name, edits: [{ anchor_from: h2, anchor_to: h2, text: "X" }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(error.message).toContain("[E_UNKNOWN_ANCHOR]");
      expect(error.message).toContain(`"${h2}"`);
      const envelope = readEnvelope(error);
      expect(envelope?.servedRows ?? []).toEqual([]);
      expect(envelope?.servedBlock ?? "").toBe("");
      const leases = loadLeases(store, TEST_SESSION_ID, absPath).map((lease) => lease.anchor);
      expect(leases).toEqual(before);
      expect(leases).not.toContain(h2);
      expect(guidelines).toContain("a rejection that shows no rows grants none");
      expect(EDIT_DESCRIPTION).not.toContain("recorded as served");
    });
  });
});
