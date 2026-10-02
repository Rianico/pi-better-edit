import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, isMutationSuccess, isMutationFailure } from "../../src/mutation-engine/index.js";
import { normReq, assertReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { DomainError } from "../../src/domain-errors.js";
import { lineHashes, initHasher } from "../../src/hashline/index.js";
import {
  withTempFile,
  withTempDir,
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
} from "../support/fixtures.js";

// WHY: these tests pin the ticket-04 wire contract — §3 finite key-set gate semantics: an item is
// WHY: legal only when its key set is EXACTLY one of S1 {anchor_from, anchor_to, text}, S2 = S1 + at,
// WHY: S3 {anchor_from, anchor_to, text_ref}, S4 = S3 + at. Red until the swap lands; HEAD still
// WHY: speaks `replace_with` and tolerates legacy spellings.
const home = useTestHome();

beforeAll(async () => {
  await initHasher();
});

// WHY: the ticket swaps the wire; these tests drive the same admission pair the tool seam uses
// WHY: (normReq + assertReq, src/edit-tool.ts), so they pin the contract, not an implementation choice.
function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

function expectBadPayload(raw: unknown, ...namedKeys: string[]): void {
  let caught: unknown;
  try {
    admit(raw);
  } catch (error) {
    caught = error;
  }
  expect(caught, "admission must reject").toBeInstanceOf(DomainError);
  const de = caught as DomainError;
  expect(de.code).toBe("E_BAD_PAYLOAD");
  for (const key of namedKeys) {
    expect(de.message).toContain(key);
  }
}

function req(edits: unknown[], file = "sample.txt"): unknown {
  return { file, edits };
}

describe("Edit wire contract — admission (finite key-set gate)", () => {
  it("refuses an item carrying an `op` field", () => {
    expectBadPayload(
      req([{ anchor_from: "a1B", anchor_to: "c2D", text: "T", op: "replace" }]),
      "op",
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
      "text",
      "text_ref",
    );
  });

  it("refuses an item with neither text nor text_ref", () => {
    expectBadPayload(req([{ anchor_from: "a1B", anchor_to: "c2D" }]));
  });

  it("refuses an item with an unknown key", () => {
    expectBadPayload(req([{ anchor_from: "a1B", anchor_to: "c2D", text: "T", foo: true }]), "foo");
  });

  it("refuses every legacy spelling — tolerance is gone", () => {
    expectBadPayload(req([{ remove_from: "a1B", remove_to: "c2D", replacement_text: "T" }]));
    expectBadPayload(req([["a1B", "c2D", "T"]]));
    expectBadPayload(
      {
        file_path: "sample.txt",
        edits: [{ anchor_from: "a1B", anchor_to: "c2D", replace_with: "T" }],
      },
      "file_path",
    );
    expectBadPayload(
      {
        path: "sample.txt",
        edits: [{ anchor_from: "a1B", anchor_to: "c2D", replace_with: "T" }],
      },
      "path",
    );
    expectBadPayload(req([{ anchor_from: "a1B", anchor_to: "c2D", replace_with: "T" }]));
  });

  it('refuses at:"in_place" and names the canonical spelling', () => {
    expectBadPayload(
      req([{ anchor_from: "a1B", anchor_to: "c2D", text: "T", at: "in_place" }]),
      "in-place",
    );
  });

  it("refuses an unknown at value", () => {
    expectBadPayload(req([{ anchor_from: "a1B", anchor_to: "c2D", text: "T", at: "bogus" }]));
  });

  it("requires text_ref.mode", () => {
    expectBadPayload(
      req([
        { anchor_from: "a1B", anchor_to: "c2D", text_ref: { anchor_from: "x", anchor_to: "y" } },
      ]),
    );
    expectBadPayload(
      req([
        {
          anchor_from: "a1B",
          anchor_to: "c2D",
          text_ref: { anchor_from: "x", anchor_to: "y", mode: "move" },
        },
      ]),
      "mode",
    );
  });

  it("refuses a foreign-source cut and says foreign-source", () => {
    let caught: unknown;
    try {
      admit({
        file: "target.txt",
        edits: [
          {
            anchor_from: "a1B",
            anchor_to: "c2D",
            text_ref: { anchor_from: "x", anchor_to: "y", file: "other.txt", mode: "cut" },
          },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught, "admission must reject").toBeInstanceOf(DomainError);
    const de = caught as DomainError;
    expect(de.code).toBe("E_BAD_PAYLOAD");
    expect(de.message).toContain("foreign-source");
    expect(de.message).not.toContain("cross-file");
  });
});

describe("Edit wire contract — behavior", () => {
  describe("insertion requires a single-line resolved target", () => {
    it("refuses an insertion whose target anchors bound a multi-line span — bytes unchanged", async () => {
      await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
        const { ctx, readTool } = setupIntegrationTest(cwd);
        const h = await lineHashes("a\nb\nc\n", `${home.testPath}/sample.txt`);
        await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
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
        const h = await lineHashes("a\nb\nb\nc\n", `${home.testPath}/sample.txt`);
        await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
        // WHY: each served occurrence gets its own anchor even when the text is identical.
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
      const h = await lineHashes("a\nb\nc\n", `${home.testPath}/sample.txt`);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nc\n", `${home.testPath}/sample.txt`);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([{ anchor_from: h[1]!, anchor_to: h[1]!, text: "", at: "before" }]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\n");
      expect(result.metrics.classification).toBe("noop");
      expect(result.toolResult.content[0]!.text).toContain("W_NOOP_INSERT");
      expect(result.toolResult.content[0]!.text).toContain("[MODEL]");
    });
  });

  it("an empty-text after insertion is a noop carrying W_NOOP_INSERT for the model", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\n", `${home.testPath}/sample.txt`);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([{ anchor_from: h[1]!, anchor_to: h[1]!, text: "", at: "after" }]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\n");
      expect(result.metrics.classification).toBe("noop");
      expect(result.toolResult.content[0]!.text).toContain("W_NOOP_INSERT");
      expect(result.toolResult.content[0]!.text).toContain("[MODEL]");
    });
  });

  it("a text_ref insertion anchored at before equals the hand-written copy byte-for-byte", async () => {
    const expected = "a\nc\nd\nb\nc\nd\n";
    let viaRef: string | undefined;
    let viaText: string | undefined;
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\n", `${home.testPath}/sample.txt`);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nc\nd\n", `${home.testPath}/sample.txt`);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
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
      await readTool.execute("r1", { path: "target.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { path: "source.txt" }, undefined, undefined, ctx);
      const t = await lineHashes("1\n2\n3\n", `${home.testPath}/target.txt`);
      const s = await lineHashes("x\ny\nz\n", `${home.testPath}/source.txt`);
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
      // WHY: the serve record must name ONLY the target: a foreign read must never earn the
      // WHY: foreign file a row in this call's served-block set.
      const details = result.toolResult.details as {
        servedByPath?: Array<{ path: string }>;
      };
      expect(details.servedByPath).toBeDefined();
      expect(details.servedByPath!.length).toBeGreaterThan(0);
      for (const entry of details.servedByPath!) {
        expect(entry.path).toBe("target.txt");
      }
    });
  });

  it("refuses a foreign reference whose anchors were never served, writing nothing", async () => {
    await withTempDir("wire-contract-unserved-", async (cwd) => {
      await writeFile(join(cwd, "target.txt"), "1\n2\n3\n", "utf-8");
      await writeFile(join(cwd, "source.txt"), "x\ny\nz\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "target.txt" }, undefined, undefined, ctx);
      const t = await lineHashes("1\n2\n3\n", `${home.testPath}/target.txt`);
      const s = await lineHashes("x\ny\nz\n");
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
      expect(result.code).toMatch(/^E_(STALE_ANCHOR|UNKNOWN_ANCHOR|FOREIGN_ANCHOR)$/);
      await expect(readFile(join(cwd, "target.txt"), "utf-8")).resolves.toBe("1\n2\n3\n");
      await expect(readFile(join(cwd, "source.txt"), "utf-8")).resolves.toBe("x\ny\nz\n");
    });
  });

  it("an intra-file cut retires its source span", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\ne\n", `${home.testPath}/sample.txt`);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nc\n", `${home.testPath}/sample.txt`);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nc\n", `${home.testPath}/sample.txt`);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const raw = req([{ anchor_from: h[0]!, anchor_to: h[2]!, text: "X\nY" }]);
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("X\nY\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("X\nY\n");
    });
  });
});
