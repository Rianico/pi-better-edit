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
import {
  lineHashes,
  contentOnlyHashes,
  initHasher,
  resEdit,
  type HTEdit,
} from "../../src/hashline/index.js";
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

// WHY: these tests pin the ticket-04 wire contract — §3 finite key-set gate semantics: an item is
// WHY: legal only when its key set is EXACTLY one of S1 {anchor_from, anchor_to, text}, S2 = S1 + at,
// WHY: S3 {anchor_from, anchor_to, text_ref}, S4 = S3 + at. The swap landed in this commit: HEAD
// WHY: speaks the new wire (`replace_with` and the legacy spellings are refused), and these
// WHY: assertions are the fence that keeps it that way — not a red plan for a future swap.
useTestHome();

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

// WHY: (sweep (b), §9.7) `describeReceived` appends the submitted JSON to every item-level
// WHY: refusal, so a bare `toContain(key)` is echo-satisfied — it cannot fail even when the
// WHY: refusal names nothing. Stripping the echo leaves only the refusal clauses, and the
// WHY: assertions below match refusal CLAUSES (`unsupported field(s) "op"`), never bare keys.
function refusalText(message: string): string {
  const echo = message.indexOf("Received:");
  return echo === -1 ? message : message.slice(0, echo);
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
  const refusal = refusalText(de.message);
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
    // WHY: (ticket-04 item (iv) → ticket-04b §1) this test used to PIN the refusal
    // WHY: ("A foreign-source reference supports mode: … copy today"): item (iv) had no recovery
    // WHY: story — retiring the source before the copy lands turns a mid-transaction crash into
    // WHY: data loss, so the guard existed until the correlated multi-file transaction
    // WHY: (`runCutTransaction`, ADR-0028) supplied the missing half: durable intent record before
    // WHY: the first rename, the target insert committed BEFORE the destructive source
    // WHY: retirement, and next-run repair for the window between. The refusal is deleted as an
    // WHY: intentional act, in the same commit as the behaviour it enables; this test witnesses
    // WHY: both halves — the refusal no longer fires, and the cut lands on BOTH files.
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
      // the deleted copy-only refusal must never surface again at this seam
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
      // WHY: (sweep (b), §6) `toContain("[MODEL]")` cannot fail independently of the code —
      // WHY: the tier prefix is guaranteed by `formatWarning`'s construction. Pin the RENDERED
      // WHY: clause and its payload (ref, both anchors, the observation and the remedy) instead.
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
      // WHY: (sweep (b), §9.8) the `servedByPath` detail section is built from the applied target
      // WHY: files only (`edit-response.ts`), so asserting against it was tautological. Assert the
      // WHY: foreign path's STORE ROWS instead: after a foreign copy its served mirror and its
      // WHY: leases are exactly what `r2` served — the copy grants nothing, retires nothing,
      // WHY: re-stamps nothing on the file it only read.
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
      // WHY: anchors come from the served read — re-deriving would need the
      // WHY: loader's symlink-resolved path, so served rows agree by construction.
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
      // WHY: (item (ii)) the old alternation `toMatch(/^E_(STALE_ANCHOR|UNKNOWN_ANCHOR|
      // WHY: FOREIGN_ANCHOR)$/)` passed silently when the code regressed into the
      // WHY: `foreignRejection` E_STALE_ANCHOR fallback. These anchors are derived
      // WHY: content-only and leased under NO file, so the §0 pass-through must surface
      // WHY: E_UNKNOWN_ANCHOR — PIN (green at HEAD — falsification owed by mutation phase: removing
      // WHY: the pass-through at pipeline.ts:441-447 flips this to E_STALE_ANCHOR and turns RED).
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
      // WHY: the anchors are served under `other.txt` — identical content, identical anchors.
      await readTool.execute("r2", { file: "other.txt" }, undefined, undefined, ctx);
      const t = await lineHashes("1\n2\n3\n", join(cwd, "target.txt"));
      const s = await lineHashes("x\ny\nz\n", join(cwd, "other.txt"));
      const raw = {
        file: "target.txt",
        edits: [
          {
            anchor_from: t[1]!,
            anchor_to: t[1]!,
            // WHY: the reference names `source.txt` — never served — but its anchors hold a
            // WHY: lease under `other.txt`: lease precedence (lease-resolve.ts) says a lease for
            // WHY: another file wins over holding no lease anywhere → E_FOREIGN_ANCHOR.
            text_ref: { anchor_from: s[0]!, anchor_to: s[1]!, file: "source.txt", mode: "copy" },
          },
        ],
      };
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationFailure(result)).toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_FOREIGN_ANCHOR");
      // WHY: the rendered message must distinguish this branch from `E_UNKNOWN_ANCHOR`: the
      // WHY: anchors are inconsistent WITH the named file and the refusal names their homes.
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

// WHY: (item (i), the blank-line P1 fence) the invariant: the SAME span copied from another
// WHY: served file must produce BYTE-IDENTICAL output to the same span replaced within one file.
// WHY: The comparison IS the oracle — the intra-file arm resolves through `content_lines` with no
// WHY: `text` round-trip (apply.ts), so no expected string is hand-written here. At HEAD the
// WHY: foreign collapse `fileLines.slice(l1-1, l2).join("\n")` inverts `parseText` wrong: every
// WHY: all-blank span of >= 2 lines loses exactly one blank line, and a single blank line
// WHY: collapses to "" and is refused by the literal arm's min-line guard.
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
  // TICKET-04b §11 mandatory re-run: the matrix now covers every shape the dispatch names —
  // empty (blank line at the head of the file), trailing-blank, no-trailing-newline, CRLF and
  // mixed endings — for BOTH the foreign copy and the foreign cut arm.
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

// WHY: (ticket-04b §11 byte fence, mandatory re-run over the full matrix) three claims per row,
// WHY: each with the comparison itself as the oracle — no hand-written expected bytes:
// WHY:   (1) the foreign CUT's target output is byte-identical to the intra-file equivalent
// WHY:       (the intra-file copy of the same span — a cut's insert arm must be exactly a copy);
// WHY:   (2) after a fault-injected abort INSIDE the two-rename window, target AND source are
// WHY:       byte-identical to the pre-transaction contents;
// WHY:   (3) the retirement write goes through the SAME canonical serialization as every other
// WHY:       write — `bom + restoreEndings(result, originalEnding)` with `originalEnding` decided
// WHY:       by the earliest line break in the file — which the independent re-fold below
// WHY:       restates with plain string operations (no module import), so agreement is evidence,
// WHY:       not tautology. One convention, no third path.
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
          // The row whose retirement would EMPTY the source: the same per-file guard the
          // intra-file path enforces (`E_EMPTY_RANGE`, "use `write`") refuses the source plan
          // in-memory, BEFORE the intent record and any rename — so this row's fence claim is
          // the refusal itself: both files byte-identical to the seeds, nothing half-written.
          // A zero-line source cannot be served at all, so no other row reaches this arm.
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
        // Claim (1): the insert is byte-identical to the intra-file equivalent.
        await expect(readFile(join(cwd, "target.txt"), "utf-8")).resolves.toBe(intraCopyBytes);
        // Claim (3): the retirement shares the canonical serializer — restated independently.
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
    // WHY: the guard is the ONLY fail-closed check on the internal placement value — every other
    // WHY: consumer falls through to the in-place path, which REMOVES the target span. It must
    // WHY: stay a refusal (E_BAD_PAYLOAD), and as a MODEL-tier rejection it must name the field
    // WHY: the retrying party can act on: the wire says `at`, not the internal `placement`.
    expect(caught, "the guard must stay fail-closed").toBeInstanceOf(DomainError);
    const de = caught as DomainError;
    expect(de.code).toBe("E_BAD_PAYLOAD");
    expect(de.message).toContain('"at"');
    expect(de.message).toContain("Nothing was written");
    // PIN (remediation-2 B2 — green at HEAD; falsification owed by mutation phase: the M5
    // mutation that rewords `placementSpellings()` must fail HERE, not only on the field name).
    expect(de.message).toContain('"in-place", "before" or "after"');
  });
});

describe("Edit wire contract — admission names the field (§9.2, §9.3)", () => {
  it('refuses text_ref.file "" at admission and names the "file" field', () => {
    // WHY: (§9.2) an empty `file` string is admitted today and only fails later as
    // WHY: `[E_UNSUPPORTED_FILE] Path is a directory: .` — the refusal belongs at admission,
    // WHY: naming the field (echo-stripped clause, so the naming is real).
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
    // WHY: (§9.3) the missing-key path today renders `has unsupported field(s)  (...)` with a
    // WHY: BLANK list — the illegal key set is also missing a REQUIRED key, and the refusal must
    // WHY: name it. The echoed JSON contains `"anchor_to"` too, so the clause is checked after
    // WHY: stripping — at HEAD nothing in the refusal itself names it.
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
      // WHY: (§9.4) foreign-vs-same-file is decided by RAW STRING equality today, so this legal
      // WHY: intra-file cut is refused as a foreign-source cut. It must resolve to the same
      // WHY: contract as the unaliased intra-file cut pinned above ("c\nd\na\nb\n", source
      // WHY: retired) — at HEAD `admit` throws and the test is red.
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
    // WHY: (§9.4) the aliased spelling is classified FOREIGN today (raw-string equality) and
    // WHY: collapses to a literal payload. The witness is a single blank line: the literal path
    // WHY: cannot carry it (the empty text trips the literal guard), while the reference arm
    // WHY: writes the blank line verbatim. A copy routed through the reference machinery must
    // WHY: behave exactly like the plain same-file copy — the plain arm is the oracle, no
    // WHY: hand-written expected bytes. At HEAD the aliased arm is refused where the plain arm
    // WHY: succeeds, so this is red.
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
    // RED at `ad80222`: admission compares LEXICALY normalized spellings, so the absolute alias
    // differs from `sample.txt`, is classified foreign, and the cut is refused — two definitions
    // of "same file". With the one realpath rule the engine already uses, this must behave
    // byte-identically to the unaliased intra-file cut (source retired, "c\nd\na\nb\n").
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

// WHY: (ticket-67) strict structured-output harnesses spell "absent" as an explicit null
// WHY: (every property required). The four optional slots (`text`, `text_ref`, `at`, root
// WHY: `mode`) read null/undefined as absent at admission — one predicate, so the gate, the
// WHY: validators and the normalizers cannot disagree. The XOR contract stands: two genuine
// WHY: payloads are still refused, and a null on both sides is still no payload.
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

// WHY: (ticket-75) the #67 fold stopped at the item's own slots: `text_ref.file` is optional one
// WHY: level down, and a strict structured-output harness spells an omitted optional property as an
// WHY: explicit null, so the refusal named a rule the harness could not obey. The fold reaches it
// WHY: now, while the REQUIRED nested slots (`mode`, both anchors) keep refusing — this block pins
// WHY: both halves of that distinction, so neither can drift into the other silently.
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
    // The fold deletes the key: a null left on the span would be read as a file named "null".
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

// WHY: (binary-selection-remediation Option C, ADR-0036) the served schema must agree with
// WHY: admission: every optional slot admits `null` (which `foldAbsentSlots` reads as absent) and
// WHY: every required slot refuses it. The predicate mirrors pi's `schemaAllowsNull`
// WHY: (`@earendil-works/pi-ai` `api/constrained-sampling.js`): null is spelled as its own
// WHY: `type`, or as a variant inside `anyOf`/`enum`/`const`. FALSIFIABILITY: before this change
// WHY: every optional property was a bare `Type.Optional(...)`, so `schemaAllowsNull` returned
// WHY: false and the positive loop below failed on its first entry (`edits[].text`).
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
