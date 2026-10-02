import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, isMutationSuccess, isMutationFailure } from "../../src/mutation-engine/index.js";
import { normReq, assertReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { DomainError } from "../../src/domain-errors.js";
import { lineHashes, initHasher, resEdit, type HTEdit } from "../../src/hashline/index.js";
import { loadHashStore } from "../../src/hash-store.js";
import { getServed, loadLeases } from "../../src/served-session/session.js";
import { readNormFile } from "../../src/file-reader.js";
import {
  withTempFile,
  withTempDir,
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
} from "../support/fixtures.js";

// WHY: these tests pin the ticket-04 wire contract — §3 finite key-set gate semantics: an item is
// WHY: legal only when its key set is EXACTLY one of S1 {anchor_from, anchor_to, text}, S2 = S1 + at,
// WHY: S3 {anchor_from, anchor_to, text_ref}, S4 = S3 + at. The swap landed in this commit: HEAD
// WHY: speaks the new wire (`replace_with` and the legacy spellings are refused), and these
// WHY: assertions are the fence that keeps it that way — not a red plan for a future swap.
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
    );
  });

  it("refuses an item with neither text nor text_ref", () => {
    expectBadPayload(
      req([{ anchor_from: "a1B", anchor_to: "c2D" }]),
      "carries no payload: exactly one payload per item",
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

  it("refuses a foreign-source cut at the engine seam and says foreign-source (remediation-2 B3, E8)", async () => {
    // WHY: (B3, one definition of "same file") admission no longer classifies paths — the engine's
    // WHY: realpath pre-pass owns foreign classification — so the refusal is witnessed THROUGH the
    // WHY: entry point that reaches it: the same seam pair the tool uses (admit, then `execute`).
    // WHY: At `ad80222` this is RED at `admit` (the lexical admission refusal throws there).
    await withTempDir("foreign-cut-entry-", async (cwd) => {
      await writeFile(join(cwd, "sample.txt"), "a\nb\nc\n", "utf-8");
      await writeFile(join(cwd, "other.txt"), "x\ny\nz\n", "utf-8");
      const raw = {
        file: "sample.txt",
        edits: [
          {
            anchor_from: "a1B",
            anchor_to: "c2D",
            text_ref: { anchor_from: "x", anchor_to: "y", file: "other.txt", mode: "cut" },
          },
        ],
      };
      const result = await execute(admit(raw), cwd, { sessionKey: TEST_SESSION_ID });
      expect(isMutationFailure(result), "the engine pre-pass must refuse").toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_BAD_PAYLOAD");
      // WHY: (sweep (b)) positive vocabulary pins replace the old `not.toContain` of the retired
      // WHY: synonym — the repo-wide term guard (test/arch) owns its zero-tolerance check.
      expect(result.message).toContain("A foreign-source reference supports mode:");
      expect(result.message).toContain('mode: "copy" today');
      await expect(readFile(join(cwd, "sample.txt"), "utf-8")).resolves.toBe("a\nb\nc\n");
      await expect(readFile(join(cwd, "other.txt"), "utf-8")).resolves.toBe("x\ny\nz\n");
    });
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
      // WHY: (sweep (b), §6) `toContain("[MODEL]")` cannot fail independently of the code —
      // WHY: the tier prefix is guaranteed by `formatWarning`'s construction. Pin the RENDERED
      // WHY: clause and its payload (ref, both anchors, the observation and the remedy) instead.
      const text = result.toolResult.content[0]!.text;
      expect(text).toContain("[W_NOOP_INSERT]");
      expect(text).toContain(`empty insertion edit[0] (sample.txt) (${h[1]} → ${h[1]}):`);
      expect(text).toContain('text "" writes nothing and the file stayed byte-identical');
      expect(text).toContain("Provide text or drop the empty item");
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
      const text = result.toolResult.content[0]!.text;
      expect(text).toContain("[W_NOOP_INSERT]");
      expect(text).toContain(`empty insertion edit[0] (sample.txt) (${h[1]} → ${h[1]}):`);
      expect(text).toContain('text "" writes nothing and the file stayed byte-identical');
      expect(text).toContain("Provide text or drop the empty item");
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
      // WHY: (item (ii)) the old alternation `toMatch(/^E_(STALE_ANCHOR|UNKNOWN_ANCHOR|
      // WHY: FOREIGN_ANCHOR)$/)` passed silently when the code regressed into the
      // WHY: `foreignRejection` E_STALE_ANCHOR fallback. These anchors are hashed WITHOUT a path
      // WHY: and leased under NO file, so the §0 pass-through must surface the raw
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
      await readTool.execute("r1", { path: "target.txt" }, undefined, undefined, ctx);
      // WHY: the anchors are served under `other.txt` — identical content, identical anchors.
      await readTool.execute("r2", { path: "other.txt" }, undefined, undefined, ctx);
      const t = await lineHashes("1\n2\n3\n", `${home.testPath}/target.txt`);
      const s = await lineHashes("x\ny\nz\n", `${home.testPath}/other.txt`);
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
      expect(result.message).toContain("inconsistent with source.txt");
      expect(result.message).toContain("served for");
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
    const h = await lineHashes(tc.controlContent, `${home.testPath}/target.txt`);
    await readTool.execute("r1", { path: "target.txt" }, undefined, undefined, ctx);
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
    await readTool.execute("r1", { path: "target.txt" }, undefined, undefined, ctx);
    await readTool.execute("r2", { path: "source.txt" }, undefined, undefined, ctx);
    const h = await lineHashes(tc.controlContent, `${home.testPath}/target.txt`);
    const s = await lineHashes(tc.foreignContent, `${home.testPath}/source.txt`);
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
];

describe("Edit wire contract — paired blank-line control (item (i) fence)", () => {
  for (const tc of COPY_PAIR_CASES) {
    it(`copying the ${tc.name} from a foreign served file is byte-identical to the intra-file copy`, async () => {
      const { viaFile, viaForeign } = await runCopyPair(tc);
      expect(viaForeign).toBe(viaFile);
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
      const h = await lineHashes("a\nb\nc\nd\ne\n", `${home.testPath}/sample.txt`);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\n\nb\nc\nd\n", `${home.testPath}/sample.txt`);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\n\nb\nc\nd\n", `${home.testPath}/sample.txt`);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nc\nd\ne\n", `${home.testPath}/sample.txt`);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
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
