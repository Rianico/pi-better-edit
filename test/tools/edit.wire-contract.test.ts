import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, isMutationSuccess, isMutationFailure } from "../../src/mutation-engine/index.js";
import {
  normReq,
  assertReq,
  editToolSchema,
  type NormalizedEditRequest,
} from "../../src/payload-contract.js";
import { DomainError } from "../../src/domain-errors.js";
import { toLF } from "../../src/edit-diff.js";
import { lineHashes, contentOnlyHashes, initHasher } from "../../src/hashline/hash-identity.js";
import { resEdit, type HTEdit } from "../../src/hashline/resolve.js";
import { loadHashStore } from "../../src/hash-store.js";
import { getServed, loadLeases } from "../../src/served-session/session.js";
import { readNormFile } from "../../src/file-reader.js";
import {
  withTempFile,
  withTempDir,
  setupIntegrationTest,
  TEST_SESSION_ID,
  getText,
  extractHash,
  useTestHome,
} from "../support/fixtures.js";

/**
 * The edit wire contract: an item is legal only when its key set is exactly S1 {anchor_from,
 * anchor_to, text}, S2 = S1 + at, S3 {anchor_from, anchor_to, text_ref}, or S4 = S3 + at. The
 * swap has landed — `replace_with` and the legacy spellings are refused — so these assertions
 * are the fence that keeps it that way, not a plan for a future swap.
 *
 * Two oracles carry most of the file: a foreign copy or cut must be BYTE-IDENTICAL to the
 * intra-file equivalent (the comparison, never a hand-written expected string), and the served
 * schema must agree with admission about `null` on optional slots, which the local
 * `schemaAllowsNull` mirrors from pi's `api/constrained-sampling.js`.
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

function expectBadPayload(raw: unknown, ...clauses: string[]): void {
  let caught: unknown;
  try {
    admit(raw);
  } catch (error) {
    caught = error;
  }
  expect(caught, "admission must reject").toBeInstanceOf(DomainError);
  const de = caught as DomainError;
  expect(de.code).toBe("E_BAD_PAYLOAD");
  const refusal = de.message;
  for (const clause of clauses) {
    expect(refusal, `refusal must contain clause: ${clause}`).toContain(clause);
  }
}

function req(edits: unknown[], file = "sample.txt"): unknown {
  return { file, edits };
}

describe("Edit wire contract — admission (finite key-set gate)", () => {
  it("refuses an item carrying an `op` field", () => {
    expectBadPayload(
      req([{ anchor_from: "a1B", anchor_to: "c2D", text: "T", op: "replace" }]),
      'unsupported field(s) "op"',
    );
  });

  it("refuses an item carrying both text and text_ref", () => {
    expectBadPayload(
      req([
        {
          anchor_from: "a1B",
          anchor_to: "c2D",
          text: "T",
          text_ref: { anchor_from: "x", anchor_to: "y", mode: "copy" },
        },
      ]),
      'carries both "text" and "text_ref"',
      'Keep "text" and delete "text_ref"',
      'keep "text_ref" and delete "text"',
    );
  });

  it("refuses an item with neither text nor text_ref", () => {
    expectBadPayload(
      req([{ anchor_from: "a1B", anchor_to: "c2D" }]),
      'carries no payload (neither "text" nor "text_ref" fields)',
    );
  });

  it("refuses an item with an unknown key", () => {
    expectBadPayload(
      req([{ anchor_from: "a1B", anchor_to: "c2D", text: "T", foo: true }]),
      'unsupported field(s) "foo"',
    );
  });

  it("refuses every legacy spelling — tolerance is gone", () => {
    expectBadPayload(
      req([{ remove_from: "a1B", remove_to: "c2D", replacement_text: "T" }]),
      'unsupported field(s) "remove_from", "remove_to", "replacement_text"',
    );
    expectBadPayload(req([["a1B", "c2D", "T"]]), "must be an object");
    expectBadPayload(
      {
        file_path: "sample.txt",
        edits: [{ anchor_from: "a1B", anchor_to: "c2D", replace_with: "T" }],
      },
      'unsupported field(s) "file_path"',
    );
    expectBadPayload(
      {
        path: "sample.txt",
        edits: [{ anchor_from: "a1B", anchor_to: "c2D", replace_with: "T" }],
      },
      'unsupported field(s) "path"',
    );
    expectBadPayload(
      req([{ anchor_from: "a1B", anchor_to: "c2D", replace_with: "T" }]),
      'unsupported field(s) "replace_with"',
    );
  });

  it('refuses at:"in_place" and names the canonical spelling', () => {
    expectBadPayload(
      req([{ anchor_from: "a1B", anchor_to: "c2D", text: "T", at: "in_place" }]),
      'canonical spelling is "in-place"',
    );
  });

  it("refuses an unknown at value", () => {
    expectBadPayload(
      req([{ anchor_from: "a1B", anchor_to: "c2D", text: "T", at: "bogus" }]),
      '"at" must be "in-place", "before" or "after"',
    );
  });

  it("requires text_ref.mode", () => {
    expectBadPayload(
      req([
        { anchor_from: "a1B", anchor_to: "c2D", text_ref: { anchor_from: "x", anchor_to: "y" } },
      ]),
      '"text_ref" requires "mode"',
    );
    expectBadPayload(
      req([
        {
          anchor_from: "a1B",
          anchor_to: "c2D",
          text_ref: { anchor_from: "x", anchor_to: "y", mode: "move" },
        },
      ]),
      '"mode" must be "copy" or "cut"',
    );
  });

  it("a foreign-source cut commits at the engine seam as one two-file transaction — the item-(iv) refusal is deleted deliberately (04b)", async () => {
    await withTempDir("foreign-cut-entry-", async (cwd) => {
      await writeFile(join(cwd, "sample.txt"), "a\nb\nc\n", "utf-8");
      await writeFile(join(cwd, "other.txt"), "x\ny\nz\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "other.txt" }, undefined, undefined, ctx);
      const hs = await lineHashes("x\ny\nz\n", join(cwd, "other.txt"));
      const ht = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
      const raw = {
        file: "sample.txt",
        edits: [
          {
            anchor_from: ht[1]!,
            anchor_to: ht[1]!,
            text_ref: { anchor_from: hs[0]!, anchor_to: hs[1]!, file: "other.txt", mode: "cut" },
          },
        ],
      };
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result), "the foreign-source cut must now commit").toBe(true);
      if (!isMutationSuccess(result)) return;
      await expect(readFile(join(cwd, "sample.txt"), "utf-8")).resolves.toBe("a\nx\ny\nc\n");
      await expect(readFile(join(cwd, "other.txt"), "utf-8")).resolves.toBe("z\n");
      expect(result.diff).not.toContain("supports mode:");
    });
  });
});

describe("Edit wire contract — behavior", () => {
  describe("insertion requires a single-line resolved target", () => {
    it("refuses an insertion whose target anchors bound a multi-line span — bytes unchanged", async () => {
      await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
        const { ctx, readTool } = setupIntegrationTest(cwd);
        const h = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
        await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
        const raw = req([{ anchor_from: h[0]!, anchor_to: h[2]!, text: "Z", at: "before" }]);
        const request = admit(raw);
        const result = await execute(request, cwd, { sessionKey: TEST_SESSION_ID });
        expect(isMutationFailure(result)).toBe(true);
        if (!isMutationFailure(result)) return;
        expect(result.code).toBe("E_BAD_PAYLOAD");
        await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\n");
      });
    });

    it("refuses an insertion across two identical served lines — bytes unchanged", async () => {
      await withTempFile("sample.txt", "a\nb\nb\nc\n", async ({ cwd }) => {
        const { ctx, readTool } = setupIntegrationTest(cwd);
        const h = await lineHashes("a\nb\nb\nc\n", join(cwd, "sample.txt"));
        await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
        expect(h[1]).not.toBe(h[2]);
        const raw = req([{ anchor_from: h[1]!, anchor_to: h[2]!, text: "Z", at: "before" }]);
        const request = admit(raw);
        const result = await execute(request, cwd, { sessionKey: TEST_SESSION_ID });
        expect(isMutationFailure(result)).toBe(true);
        if (!isMutationFailure(result)) return;
        expect(result.code).toBe("E_BAD_PAYLOAD");
        await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nb\nc\n");
      });
    });
  });

  it('text:"" in-place deletes the span', async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([{ anchor_from: h[1]!, anchor_to: h[1]!, text: "" }]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("a\nc\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nc\n");
      expect(result.metrics.classification).toBe("applied");
    });
  });

  it("an empty-text before insertion is a noop carrying W_NOOP_INSERT for the model", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([{ anchor_from: h[1]!, anchor_to: h[1]!, text: "", at: "before" }]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\n");
      expect(result.metrics.classification).toBe("noop");
      const text = result.toolResult.content[0]!.text;
      expect(text).toContain("[W_NOOP_INSERT]");
      expect(text).toContain(
        `Empty insertion edit[0] (sample.txt) (${h[1]} → ${h[1]}) with "before"/"after" and text "" writes nothing.`,
      );
      expect(text).toContain("Provide text or drop the item");
    });
  });

  it("an empty-text after insertion is a noop carrying W_NOOP_INSERT for the model", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([{ anchor_from: h[1]!, anchor_to: h[1]!, text: "", at: "after" }]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\n");
      expect(result.metrics.classification).toBe("noop");
      const text = result.toolResult.content[0]!.text;
      expect(text).toContain("[W_NOOP_INSERT]");
      expect(text).toContain(
        `Empty insertion edit[0] (sample.txt) (${h[1]} → ${h[1]}) with "before"/"after" and text "" writes nothing.`,
      );
      expect(text).toContain("Provide text or drop the item");
    });
  });

  it("a text_ref insertion anchored at before equals the hand-written copy byte-for-byte", async () => {
    const expected = "a\nc\nd\nb\nc\nd\n";
    let viaRef: string | undefined;
    let viaText: string | undefined;
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([
        {
          anchor_from: h[1]!,
          anchor_to: h[1]!,
          at: "before",
          text_ref: { anchor_from: h[2]!, anchor_to: h[3]!, mode: "copy" },
        },
      ]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      viaRef = result.result;
    });
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([{ anchor_from: h[1]!, anchor_to: h[1]!, at: "before", text: "c\nd" }]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      viaText = result.result;
    });
    expect(viaRef).toBe(expected);
    expect(viaText).toBe(expected);
  });

  it("copies from a foreign served file and never writes it", async () => {
    await withTempDir("wire-contract-foreign-", async (cwd) => {
      await writeFile(join(cwd, "target.txt"), "1\n2\n3\n", "utf-8");
      await writeFile(join(cwd, "source.txt"), "x\ny\nz\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "source.txt" }, undefined, undefined, ctx);
      const t = await lineHashes("1\n2\n3\n", join(cwd, "target.txt"));
      const s = await lineHashes("x\ny\nz\n", join(cwd, "source.txt"));
      const raw = {
        file: "target.txt",
        edits: [
          {
            anchor_from: t[1]!,
            anchor_to: t[1]!,
            text_ref: { anchor_from: s[0]!, anchor_to: s[1]!, file: "source.txt", mode: "copy" },
          },
        ],
      };
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("1\nx\ny\n3\n");
      await expect(readFile(join(cwd, "target.txt"), "utf-8")).resolves.toBe("1\nx\ny\n3\n");
      await expect(readFile(join(cwd, "source.txt"), "utf-8")).resolves.toBe("x\ny\nz\n");
      const store = await loadHashStore();
      const foreignAbs = (await readNormFile("source.txt", cwd, { store, noPersist: true }))
        .absolutePath;
      expect(getServed(store, TEST_SESSION_ID, foreignAbs)).toEqual([s[0]!, s[1]!, s[2]!]);
      const foreignLeases = loadLeases(store, TEST_SESSION_ID, foreignAbs);
      expect(foreignLeases.map((lease) => lease.anchor).sort()).toEqual(
        [s[0]!, s[1]!, s[2]!].sort(),
      );
      expect(foreignLeases.every((lease) => lease.retired_at === null)).toBe(true);
    });
  });

  it("refuses a foreign reference whose anchors were never served, writing nothing", async () => {
    await withTempDir("wire-contract-unserved-", async (cwd) => {
      await writeFile(join(cwd, "target.txt"), "1\n2\n3\n", "utf-8");
      await writeFile(join(cwd, "source.txt"), "x\ny\nz\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
      const t = getText(r1)
        .split("\n")
        .filter((line) => line.includes("│"))
        .map((line) => extractHash(line));
      const s = await contentOnlyHashes("x\ny\nz\n");
      const raw = {
        file: "target.txt",
        edits: [
          {
            anchor_from: t[1]!,
            anchor_to: t[1]!,
            text_ref: { anchor_from: s[0]!, anchor_to: s[1]!, file: "source.txt", mode: "copy" },
          },
        ],
      };
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationFailure(result)).toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_UNKNOWN_ANCHOR");
      expect(result.message).toContain("source.txt");
      expect(result.message).toContain("has not served");
      await expect(readFile(join(cwd, "target.txt"), "utf-8")).resolves.toBe("1\n2\n3\n");
      await expect(readFile(join(cwd, "source.txt"), "utf-8")).resolves.toBe("x\ny\nz\n");
    });
  });

  it("refuses a foreign reference whose anchors are leased under ANOTHER file — E_FOREIGN_ANCHOR", async () => {
    await withTempDir("wire-contract-foreign-anchor-", async (cwd) => {
      await writeFile(join(cwd, "target.txt"), "1\n2\n3\n", "utf-8");
      await writeFile(join(cwd, "other.txt"), "x\ny\nz\n", "utf-8");
      await writeFile(join(cwd, "source.txt"), "x\ny\nz\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "other.txt" }, undefined, undefined, ctx);
      const t = await lineHashes("1\n2\n3\n", join(cwd, "target.txt"));
      const s = await lineHashes("x\ny\nz\n", join(cwd, "other.txt"));
      const raw = {
        file: "target.txt",
        edits: [
          {
            anchor_from: t[1]!,
            anchor_to: t[1]!,
            text_ref: { anchor_from: s[0]!, anchor_to: s[1]!, file: "source.txt", mode: "copy" },
          },
        ],
      };
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationFailure(result)).toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_FOREIGN_ANCHOR");
      expect(result.message).toContain("not for source.txt");
      expect(result.message).toContain("served for");
      await expect(readFile(join(cwd, "target.txt"), "utf-8")).resolves.toBe("1\n2\n3\n");
      await expect(readFile(join(cwd, "source.txt"), "utf-8")).resolves.toBe("x\ny\nz\n");
    });
  });

  it("an intra-file cut retires its source span", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([
        {
          anchor_from: h[4]!,
          anchor_to: h[4]!,
          text_ref: { anchor_from: h[0]!, anchor_to: h[1]!, mode: "cut" },
        },
      ]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("c\nd\na\nb\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("c\nd\na\nb\n");
      expect(result.raw.removedHashes.has(h[0]!)).toBe(true);
      expect(result.raw.removedHashes.has(h[1]!)).toBe(true);
    });
  });

  it("an in-place single-line target works on the new wire", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([{ anchor_from: h[1]!, anchor_to: h[1]!, text: "B" }]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("a\nB\nc\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nB\nc\n");
    });
  });

  it("an in-place multi-line target works on the new wire", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([{ anchor_from: h[0]!, anchor_to: h[2]!, text: "X\nY" }]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("X\nY\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("X\nY\n");
    });
  });
});

type CopyPairCase = {
  name: string;
  controlContent: string;
  controlSpan: [number, number];
  targetLine: number;
  foreignContent: string;
  foreignSpan: [number, number];
};

async function runCopyPair(tc: CopyPairCase): Promise<{ viaFile: string; viaForeign: string }> {
  let viaFile = "";
  let viaForeign = "";
  await withTempFile("target.txt", tc.controlContent, async ({ cwd }) => {
    const { ctx, readTool } = setupIntegrationTest(cwd);
    const h = await lineHashes(toLF(tc.controlContent), join(cwd, "target.txt"));
    await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
    const [l1, l2] = tc.controlSpan;
    const raw = req(
      [
        {
          anchor_from: h[tc.targetLine - 1]!,
          anchor_to: h[tc.targetLine - 1]!,
          text_ref: { anchor_from: h[l1 - 1]!, anchor_to: h[l2 - 1]!, mode: "copy" },
        },
      ],
      "target.txt",
    );
    const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
    expect(
      isMutationSuccess(result),
      isMutationFailure(result)
        ? `intra-file control arm must succeed (${tc.name}): ${result.code} ${result.message}`
        : `intra-file control arm must succeed (${tc.name})`,
    ).toBe(true);
    if (!isMutationSuccess(result)) return;
    viaFile = result.result;
  });
  await withTempDir("paired-control-foreign-", async (cwd) => {
    await writeFile(join(cwd, "target.txt"), tc.controlContent, "utf-8");
    await writeFile(join(cwd, "source.txt"), tc.foreignContent, "utf-8");
    const { ctx, readTool } = setupIntegrationTest(cwd);
    await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
    await readTool.execute("r2", { file: "source.txt" }, undefined, undefined, ctx);
    const h = await lineHashes(toLF(tc.controlContent), join(cwd, "target.txt"));
    const s = await lineHashes(toLF(tc.foreignContent), join(cwd, "source.txt"));
    const [f1, f2] = tc.foreignSpan;
    const raw = {
      file: "target.txt",
      edits: [
        {
          anchor_from: h[tc.targetLine - 1]!,
          anchor_to: h[tc.targetLine - 1]!,
          text_ref: {
            anchor_from: s[f1 - 1]!,
            anchor_to: s[f2 - 1]!,
            file: "source.txt",
            mode: "copy" as const,
          },
        },
      ],
    };
    const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
    expect(
      isMutationSuccess(result),
      isMutationFailure(result)
        ? `foreign arm must succeed (${tc.name}): ${result.code} ${result.message}`
        : `foreign arm must succeed (${tc.name})`,
    ).toBe(true);
    if (!isMutationSuccess(result)) return;
    viaForeign = result.result;
    await expect(readFile(join(cwd, "source.txt"), "utf-8")).resolves.toBe(tc.foreignContent);
  });
  return { viaFile, viaForeign };
}

const COPY_PAIR_CASES: CopyPairCase[] = [
  {
    name: "two-blank-line span",
    controlContent: "a\n\n\nb\nc\n",
    controlSpan: [2, 3],
    targetLine: 4,
    foreignContent: "p\n\n\nq\n",
    foreignSpan: [2, 3],
  },
  {
    name: "single-blank-line span",
    controlContent: "a\n\nb\nc\n",
    controlSpan: [2, 2],
    targetLine: 3,
    foreignContent: "p\n\nq\n",
    foreignSpan: [2, 2],
  },
  {
    name: "all-blank span at the end of the file",
    controlContent: "a\nb\n\n\n",
    controlSpan: [3, 4],
    targetLine: 1,
    foreignContent: "p\n\n\n",
    foreignSpan: [2, 3],
  },
  {
    name: "all-blank file as source",
    controlContent: "a\n\n\n\nb\n",
    controlSpan: [2, 4],
    targetLine: 5,
    foreignContent: "\n\n\n",
    foreignSpan: [1, 3],
  },
  {
    name: "empty line at the head of the file",
    controlContent: "\nb\nc\n",
    controlSpan: [1, 1],
    targetLine: 3,
    foreignContent: "\nq\n",
    foreignSpan: [1, 1],
  },
  {
    name: "single trailing blank line",
    controlContent: "a\nb\n\n",
    controlSpan: [3, 3],
    targetLine: 1,
    foreignContent: "p\nq\n\n",
    foreignSpan: [3, 3],
  },
  {
    name: "no trailing newline",
    controlContent: "a\n\nb",
    controlSpan: [2, 2],
    targetLine: 3,
    foreignContent: "p\n\nq",
    foreignSpan: [2, 2],
  },
  {
    name: "CRLF file",
    controlContent: "a\r\n\r\nb\r\nc\r\n",
    controlSpan: [2, 2],
    targetLine: 3,
    foreignContent: "p\r\n\r\nq\r\n",
    foreignSpan: [2, 2],
  },
  {
    name: "mixed endings (one stray CRLF inside an LF file)",
    controlContent: "a\n\r\nb\nc\n",
    controlSpan: [2, 2],
    targetLine: 3,
    foreignContent: "p\n\r\nq\n",
    foreignSpan: [2, 2],
  },
];

describe("Edit wire contract — paired blank-line control (item (i) fence)", () => {
  for (const tc of COPY_PAIR_CASES) {
    it(`copying the ${tc.name} from a foreign served file is byte-identical to the intra-file copy`, async () => {
      const { viaFile, viaForeign } = await runCopyPair(tc);
      expect(viaForeign).toBe(viaFile);
    });
  }
});

function expectedRetirement(raw: string, l1: number, l2: number): string {
  const idxLF = raw.indexOf("\n");
  const idxCRLF = raw.indexOf("\r\n");
  const ending =
    idxLF === -1
      ? raw.indexOf("\r") >= 0
        ? "\r"
        : "\n"
      : idxCRLF !== -1 && idxCRLF < idxLF
        ? "\r\n"
        : "\n";
  const lf = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trailing = lf.endsWith("\n");
  const lines = trailing ? lf.slice(0, -1).split("\n") : lf.split("\n");
  const kept = lines.filter((_, i) => i < l1 - 1 || i > l2 - 1);
  return kept.join(ending) + (trailing && kept.length > 0 ? ending : "");
}

async function seedForeign(cwd: string, tc: CopyPairCase) {
  await writeFile(join(cwd, "target.txt"), tc.controlContent, "utf-8");
  await writeFile(join(cwd, "source.txt"), tc.foreignContent, "utf-8");
  const { ctx, readTool } = setupIntegrationTest(cwd);
  await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
  await readTool.execute("r2", { file: "source.txt" }, undefined, undefined, ctx);
  const h = await lineHashes(toLF(tc.controlContent), join(cwd, "target.txt"));
  const s = await lineHashes(toLF(tc.foreignContent), join(cwd, "source.txt"));
  return { ctx, h, s };
}

function foreignCutReq(tc: CopyPairCase, h: string[], s: string[]): unknown {
  const [f1, f2] = tc.foreignSpan;
  return {
    file: "target.txt",
    edits: [
      {
        anchor_from: h[tc.targetLine - 1]!,
        anchor_to: h[tc.targetLine - 1]!,
        text_ref: {
          anchor_from: s[f1 - 1]!,
          anchor_to: s[f2 - 1]!,
          file: "source.txt",
          mode: "cut" as const,
        },
      },
    ],
  };
}

describe("Edit wire contract — §11 byte fence: foreign cut mirrors the intra-file arm", () => {
  for (const tc of COPY_PAIR_CASES) {
    it(`the ${tc.name}: foreign-cut target is byte-identical to the intra-file copy AND the retirement re-folds through the canonical serializer`, async () => {
      let intraCopyBytes = "";
      await withTempDir("fence-intra-copy-", async (cwd) => {
        await writeFile(join(cwd, "target.txt"), tc.controlContent, "utf-8");
        const { ctx, readTool } = setupIntegrationTest(cwd);
        const h = await lineHashes(toLF(tc.controlContent), join(cwd, "target.txt"));
        await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
        const [l1, l2] = tc.controlSpan;
        const raw = req(
          [
            {
              anchor_from: h[tc.targetLine - 1]!,
              anchor_to: h[tc.targetLine - 1]!,
              text_ref: { anchor_from: h[l1 - 1]!, anchor_to: h[l2 - 1]!, mode: "copy" },
            },
          ],
          "target.txt",
        );
        const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
        expect(
          isMutationSuccess(result),
          isMutationFailure(result)
            ? `intra-file copy arm must succeed (${tc.name}): ${result.code} ${result.message}`
            : `intra-file copy arm must succeed (${tc.name})`,
        ).toBe(true);
        intraCopyBytes = await readFile(join(cwd, "target.txt"), "utf-8");
      });

      await withTempDir("fence-foreign-cut-", async (cwd) => {
        const { h, s } = await seedForeign(cwd, tc);
        const [f1, f2] = tc.foreignSpan;
        const expectedSource = expectedRetirement(tc.foreignContent, f1, f2);
        const result = await execute(admit(foreignCutReq(tc, h, s)), cwd, {
          sessionKey: TEST_SESSION_ID,
        });
        if (expectedSource === "") {
          expect(
            isMutationFailure(result) && result.code === "E_EMPTY_RANGE",
            `cutting the whole of an all-blank source must refuse with E_EMPTY_RANGE (${tc.name})`,
          ).toBe(true);
          await expect(readFile(join(cwd, "target.txt"), "utf-8")).resolves.toBe(tc.controlContent);
          await expect(readFile(join(cwd, "source.txt"), "utf-8")).resolves.toBe(tc.foreignContent);
          return;
        }
        expect(
          isMutationSuccess(result),
          isMutationFailure(result)
            ? `foreign cut arm must succeed (${tc.name}): ${result.code} ${result.message}`
            : `foreign cut arm must succeed (${tc.name})`,
        ).toBe(true);
        if (!isMutationSuccess(result)) return;
        await expect(readFile(join(cwd, "target.txt"), "utf-8")).resolves.toBe(intraCopyBytes);
        await expect(readFile(join(cwd, "source.txt"), "utf-8")).resolves.toBe(expectedSource);
      });
    });

    it(`the ${tc.name}: a fault-injected abort inside the two-rename window leaves BOTH files byte-identical to the pre-transaction contents`, async () => {
      await withTempDir("fence-foreign-abort-", async (cwd) => {
        const { h, s } = await seedForeign(cwd, tc);
        const result = await execute(admit(foreignCutReq(tc, h, s)), cwd, {
          sessionKey: TEST_SESSION_ID,
          onCutBetweenWrites: () => {
            throw new Error("injected §11 fault: after the first rename");
          },
        });
        expect(isMutationFailure(result), `the injected fault must abort (${tc.name})`).toBe(true);
        await expect(readFile(join(cwd, "target.txt"), "utf-8")).resolves.toBe(tc.controlContent);
        await expect(readFile(join(cwd, "source.txt"), "utf-8")).resolves.toBe(tc.foreignContent);
      });
    });
  }
});

describe("Edit wire contract — fail-closed placement guard on the published seam (item (iii))", () => {
  it("refuses an unrecognized internal placement at resEdit and names the wire field `at`", () => {
    let caught: unknown;
    try {
      resEdit({
        text: "T",
        anchor_from: "a1B",
        anchor_to: "c2D",
        placement: "sideways",
      } as unknown as HTEdit);
    } catch (error) {
      caught = error;
    }
    expect(caught, "the guard must stay fail-closed").toBeInstanceOf(DomainError);
    const de = caught as DomainError;
    expect(de.code).toBe("E_BAD_PAYLOAD");
    expect(de.message).toContain('"at"');
    expect(de.message).toContain("Nothing was written");
    expect(de.message).toContain('"in-place", "before" or "after"');
  });
});

describe("Edit wire contract — admission names the field (§9.2, §9.3)", () => {
  it('refuses text_ref.file "" at admission and names the "file" field', () => {
    expectBadPayload(
      req([
        {
          anchor_from: "a1B",
          anchor_to: "c2D",
          text_ref: { anchor_from: "x", anchor_to: "y", file: "", mode: "copy" },
        },
      ]),
      '"file"',
    );
  });

  it("names the MISSING required key when an item's key set lacks one", () => {
    expectBadPayload(req([{ anchor_from: "a1B", text: "T", at: "after" }]), '"anchor_to"');
  });
});

describe("Edit wire contract — resolved-path aliasing of the same file (§9.4)", () => {
  it('a same-file cut spelled "./sample.txt" is SAME-FILE: the cut is allowed and retires', async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([
        {
          anchor_from: h[4]!,
          anchor_to: h[4]!,
          text_ref: { anchor_from: h[0]!, anchor_to: h[1]!, file: "./sample.txt", mode: "cut" },
        },
      ]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("c\nd\na\nb\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("c\nd\na\nb\n");
      expect(result.raw.removedHashes.has(h[0]!)).toBe(true);
      expect(result.raw.removedHashes.has(h[1]!)).toBe(true);
    });
  });

  it('a same-file copy spelled "./sample.txt" takes the reference machinery, not the literal path', async () => {
    let plainResult = "";
    await withTempFile("sample.txt", "a\n\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\n\nb\nc\nd\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([
        {
          anchor_from: h[4]!,
          anchor_to: h[4]!,
          text_ref: { anchor_from: h[1]!, anchor_to: h[1]!, mode: "copy" },
        },
      ]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result), "plain intra-file blank-line copy must succeed").toBe(true);
      if (!isMutationSuccess(result)) return;
      plainResult = result.result;
    });
    await withTempFile("sample.txt", "a\n\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\n\nb\nc\nd\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([
        {
          anchor_from: h[4]!,
          anchor_to: h[4]!,
          text_ref: { anchor_from: h[1]!, anchor_to: h[1]!, file: "./sample.txt", mode: "copy" },
        },
      ]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(
        isMutationSuccess(result),
        isMutationFailure(result)
          ? `aliased same-file copy must take the reference machinery: ${result.code} ${result.message}`
          : "aliased same-file copy must take the reference machinery",
      ).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe(plainResult);
    });
  });

  it("a same-file cut spelled with an ABSOLUTE alias is the same SAME-FILE cut (remediation-2 B3)", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([
        {
          anchor_from: h[4]!,
          anchor_to: h[4]!,
          text_ref: {
            anchor_from: h[0]!,
            anchor_to: h[1]!,
            file: join(cwd, "sample.txt"),
            mode: "cut",
          },
        },
      ]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(
        isMutationSuccess(result),
        isMutationFailure(result)
          ? `absolute-alias same-file cut must take the intra-file path: ${result.code} ${result.message}`
          : "absolute-alias same-file cut must take the intra-file path",
      ).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("c\nd\na\nb\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("c\nd\na\nb\n");
      expect(result.raw.removedHashes.has(h[0]!)).toBe(true);
      expect(result.raw.removedHashes.has(h[1]!)).toBe(true);
    });
  });
});

describe("Edit wire contract — null reads as absent (ticket-67)", () => {
  it('admits { text: "T", text_ref: null } as a literal and normalizes to the text', () => {
    const admitted = admit(
      req([{ anchor_from: "a1B", anchor_to: "c2D", text: "T", text_ref: null }]),
    );
    expect(admitted.edits).toHaveLength(1);
    expect(admitted.edits[0]).toMatchObject({
      target: { anchor_from: "a1B", anchor_to: "c2D" },
      at: "in-place",
      payload: { kind: "literal", text: "T" },
    });
  });

  it("admits { text: null, text_ref: { … } } as a reference", () => {
    const admitted = admit(
      req([
        {
          anchor_from: "a1B",
          anchor_to: "c2D",
          text: null,
          text_ref: { anchor_from: "x", anchor_to: "y", mode: "copy" },
        },
      ]),
    );
    expect(admitted.edits).toHaveLength(1);
    expect(admitted.edits[0]!.payload).toMatchObject({ kind: "reference", mode: "copy" });
  });

  it('admits { text: "T", text_ref: undefined } as a literal', () => {
    const admitted = admit(
      req([{ anchor_from: "a1B", anchor_to: "c2D", text: "T", text_ref: undefined }]),
    );
    expect(admitted.edits[0]!.payload).toMatchObject({ kind: "literal", text: "T" });
  });

  it('admits { text: "T", at: null } with the default placement', () => {
    const admitted = admit(req([{ anchor_from: "a1B", anchor_to: "c2D", text: "T", at: null }]));
    expect(admitted.edits[0]).toMatchObject({
      at: "in-place",
      payload: { kind: "literal", text: "T" },
    });
  });

  it("admits a root mode: null as absent with no mode key on the normalized request", () => {
    const admitted = admit({
      file: "sample.txt",
      mode: null,
      edits: [{ anchor_from: "a1B", anchor_to: "c2D", text: "T" }],
    });
    expect("mode" in admitted).toBe(false);
    expect(admitted.edits[0]!.payload).toMatchObject({ kind: "literal", text: "T" });
  });

  it("still refuses { text: null } alone as carrying no payload", () => {
    expectBadPayload(
      req([{ anchor_from: "a1B", anchor_to: "c2D", text: null }]),
      'carries no payload (neither "text" nor "text_ref" fields)',
    );
  });

  it("a text edit carrying text_ref: null performs the write", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([{ anchor_from: h[1]!, anchor_to: h[1]!, text: "B", text_ref: null }]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("a\nB\nc\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nB\nc\n");
    });
  });
});

describe("Edit wire contract — nested text_ref nulls (ticket-75)", () => {
  it("admits text_ref.file: null as absent and drops the key rather than carrying null", () => {
    const admitted = admit(
      req([
        {
          anchor_from: "a1B",
          anchor_to: "c2D",
          text_ref: { anchor_from: "x", anchor_to: "y", mode: "copy", file: null },
        },
      ]),
    );
    expect(admitted.edits).toHaveLength(1);
    const payload = admitted.edits[0]!.payload;
    if (payload.kind !== "reference") throw new Error("expected a reference payload");
    expect(payload).toMatchObject({ kind: "reference", mode: "copy" });
    expect(payload.span).not.toHaveProperty("file");
  });

  it("admits text_ref.file: undefined as absent", () => {
    const admitted = admit(
      req([
        {
          anchor_from: "a1B",
          anchor_to: "c2D",
          text_ref: { anchor_from: "x", anchor_to: "y", mode: "copy", file: undefined },
        },
      ]),
    );
    const payload = admitted.edits[0]!.payload;
    if (payload.kind !== "reference") throw new Error("expected a reference payload");
    expect(payload.span).not.toHaveProperty("file");
  });

  it("still refuses text_ref.mode: null — a required slot has no absent form", () => {
    expectBadPayload(
      req([
        {
          anchor_from: "a1B",
          anchor_to: "c2D",
          text_ref: { anchor_from: "x", anchor_to: "y", mode: null },
        },
      ]),
      '"mode" is required, so null is not a value here',
    );
  });

  it("still refuses a null text_ref anchor", () => {
    expectBadPayload(
      req([
        {
          anchor_from: "a1B",
          anchor_to: "c2D",
          text_ref: { anchor_from: null, anchor_to: "y", mode: "copy" },
        },
      ]),
      "both anchors are required, so null is not a value here",
    );
  });

  it("refuses a wrong-typed text_ref.file and names the escape hatch", () => {
    expectBadPayload(
      req([
        {
          anchor_from: "a1B",
          anchor_to: "c2D",
          text_ref: { anchor_from: "x", anchor_to: "y", mode: "copy", file: 42 },
        },
      ]),
      'omit "file" to reference this file',
    );
  });
});

/**
 * Mirrors pi's `schemaAllowsNull` (`@earendil-works/pi-ai` `api/constrained-sampling.js`): null
 * is spelled as its own `type`, or as a variant inside `anyOf`/`enum`/`const`. The served schema
 * must agree with admission — every optional slot admits `null` (read as absent by
 * `foldAbsentSlots`) and every required slot refuses it.
 */
type NullProbe = { type?: unknown; const?: unknown; enum?: unknown; anyOf?: unknown };

function schemaAllowsNull(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  const s = schema as NullProbe;
  if (s.type === "null") return true;
  if (Array.isArray(s.type) && s.type.includes("null")) return true;
  if (s.const === null) return true;
  if (Array.isArray(s.enum) && s.enum.includes(null)) return true;
  return Array.isArray(s.anyOf) && s.anyOf.some((variant) => schemaAllowsNull(variant));
}

describe("Edit wire contract — served schema declares optional null (ADR-0036)", () => {
  type Node = { properties?: Record<string, Node>; items?: Node; anyOf?: Node[] };
  const root = editToolSchema as unknown as Node;
  const item = root.properties!.edits!.items!;
  const itemProps = item.properties!;
  const refProps = itemProps.text_ref!.anyOf![0]!.properties!;

  it("admits null in each of the five optional fields", () => {
    const optional: Record<string, unknown> = {
      "edits[].text": itemProps.text,
      "edits[].text_ref": itemProps.text_ref,
      "edits[].at": itemProps.at,
      mode: root.properties!.mode,
      "edits[].text_ref.file": refProps.file,
    };
    for (const [name, property] of Object.entries(optional)) {
      expect(schemaAllowsNull(property), `${name} must admit null`).toBe(true);
    }
  });

  it("refuses null in every required field", () => {
    const required: Record<string, unknown> = {
      file: root.properties!.file,
      edits: root.properties!.edits,
      "edits[].anchor_from": itemProps.anchor_from,
      "edits[].anchor_to": itemProps.anchor_to,
      "edits[].text_ref.anchor_from": refProps.anchor_from,
      "edits[].text_ref.anchor_to": refProps.anchor_to,
      "edits[].text_ref.mode": refProps.mode,
    };
    for (const [name, property] of Object.entries(required)) {
      expect(schemaAllowsNull(property), `${name} must refuse null`).toBe(false);
    }
  });

  it("serialises a widened scalar field as anyOf with a null variant", () => {
    expect(itemProps.text).toEqual({
      anyOf: [
        { type: "string", description: 'Bare file content for the range; use "" to delete' },
        { type: "null" },
      ],
    });
  });
});
