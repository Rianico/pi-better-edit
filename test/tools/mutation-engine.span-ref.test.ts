import { describe, expect, it, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { execute, isMutationSuccess, isMutationFailure } from "../../src/mutation-engine/index.js";
import {
  withTempFile,
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
} from "../support/fixtures.js";
import { lineHashes, initHasher } from "../../src/hashline/index.js";
import type { NormalizedEditRequest, Placement } from "../../src/payload-contract.js";

const home = useTestHome();

beforeAll(async () => {
  await initHasher();
});

// WHY: the span-ref arm is unreachable from the wire (ticket-04 opens that); these tests drive the
// WHY: engine seam with directly-constructed admission-typed requests, exactly the shape the
// WHY: pipeline's exhaustive `payload.kind` switch consumes.
function spanRefItem(
  target: [string, string],
  source: [string, string],
  retire: boolean,
  at: Placement = "replace",
): NormalizedEditRequest["edits"][number] {
  return {
    target: { anchor_from: target[0], anchor_to: target[1] },
    at,
    payload: {
      kind: "span-ref",
      span: { anchor_from: source[0], anchor_to: source[1] },
      retireSource: retire,
    },
  };
}

function handItem(
  target: [string, string],
  text: string,
  at: Placement = "replace",
): NormalizedEditRequest["edits"][number] {
  return {
    target: { anchor_from: target[0], anchor_to: target[1] },
    at,
    payload: { kind: "hand-written", text },
  };
}

describe("MutationEngine — span-ref move", () => {
  it("moves a multi-line span: source retired, target replaced, metrics honest", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\ne\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        { file: "sample.txt", edits: [spanRefItem([h[4]!, h[4]!], [h[0]!, h[1]!], true)] },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("c\nd\na\nb\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("c\nd\na\nb\n");
      expect(result.metrics.added_lines).toBe(2);
      expect(result.metrics.removed_lines).toBe(3);
      // WHY: invariant 7 — retired source hashes join the removed union alongside the target's.
      expect(result.raw.removedHashes.has(h[0]!)).toBe(true);
      expect(result.raw.removedHashes.has(h[1]!)).toBe(true);
      expect(result.raw.removedHashes.has(h[4]!)).toBe(true);
    });
  });

  it("the degenerate adjacent move rides the noop path — no write, no double-apply", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        { file: "sample.txt", edits: [spanRefItem([h[0]!, h[0]!], [h[1]!, h[2]!], true, "after")] },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("a\nb\nc\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\n");
      expect(result.raw.appliedCount).toBe(0);
      expect(result.raw.noopCount).toBe(1);
      expect(result.metrics.classification).toBe("noop");
    });
  });

  it("refuses a retired source that overlaps its own target — E_BAD_PAYLOAD, bytes unchanged", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        { file: "sample.txt", edits: [spanRefItem([h[1]!, h[2]!], [h[2]!, h[3]!], true)] },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationFailure(result)).toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_BAD_PAYLOAD");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\nd\n");
    });
  });

  it("an unresolvable source anchor fails through the range-family rejection — bytes unchanged", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        { file: "sample.txt", edits: [spanRefItem([h[2]!, h[2]!], ["QQQ", "QQQ"], true)] },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationFailure(result)).toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toMatch(/^E_(UNKNOWN_ANCHOR|STALE_ANCHOR|TARGET_LOST)$/);
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\n");
    });
  });
});

describe("MutationEngine — span-ref copy", () => {
  it("copies a multi-line span: source survives, metrics count only the target removal", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\ne\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        { file: "sample.txt", edits: [spanRefItem([h[4]!, h[4]!], [h[0]!, h[1]!], false)] },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("a\nb\nc\nd\na\nb\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\nd\na\nb\n");
      expect(result.metrics.added_lines).toBe(2);
      expect(result.metrics.removed_lines).toBe(1);
      expect(result.raw.removedHashes.has(h[0]!)).toBe(false);
      expect(result.raw.removedHashes.has(h[1]!)).toBe(false);
    });
  });

  it("copies with an insertion placement — added lines, zero removed", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        {
          file: "sample.txt",
          edits: [spanRefItem([h[1]!, h[1]!], [h[2]!, h[3]!], false, "before")],
        },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("a\nc\nd\nb\nc\nd\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nc\nd\nb\nc\nd\n");
      expect(result.metrics.added_lines).toBe(2);
      expect(result.metrics.removed_lines).toBe(0);
    });
  });
});

describe("MutationEngine — span-ref in batches", () => {
  it("a source span is a batch span: another item overlapping it aborts the batch", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\ne\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      // edit[0] moves lines 2..3 away; edit[1] tries to rewrite line 3 — the SAME baseline line.
      const result = await execute(
        {
          file: "sample.txt",
          edits: [spanRefItem([h[4]!, h[4]!], [h[1]!, h[2]!], true), handItem([h[2]!, h[3]!], "Z")],
        },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationFailure(result)).toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_BATCH_ABORT");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\nd\ne\n");
    });
  });

  it("a copy's non-retired source is not a mutated span: another item may target it", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\ne\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      // edit[0] copies lines 1..2 onto line 5; edit[1] rewrites line 2 — legal because the copy
      // retires nothing, and both splices resolved against the same pre-batch buffer.
      const result = await execute(
        {
          file: "sample.txt",
          edits: [
            spanRefItem([h[4]!, h[4]!], [h[0]!, h[1]!], false),
            handItem([h[1]!, h[1]!], "B"),
          ],
        },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("a\nB\nc\nd\na\nb\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nB\nc\nd\na\nb\n");
    });
  });

  it("batch identity: a retired source does not blind a later item's anchors (invariant 6)", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        {
          file: "sample.txt",
          edits: [spanRefItem([h[3]!, h[3]!], [h[0]!, h[0]!], true), handItem([h[2]!, h[2]!], "C")],
        },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      // edit[0] moves line 1 onto line 4 (replace: `d` gives its place to `a`, source retired)
      // → "b\nc\na\n"; edit[1]'s `c` anchor resolves by identity at its shifted line → "b\nC\na\n".
      expect(result.result).toBe("b\nC\na\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("b\nC\na\n");
    });
  });
});
