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

  // WHY: (ticket-02b P1-B) the refusal was scoped to replacement placements, so an `after` move
  // WHY: whose insertion point sits strictly inside its retired span wrote corrupt bytes. The
  // WHY: pinned predicate is placement-aware: `after` overlaps when s1 <= T < s2.
  // WHY: (ticket-02b P1-A, Amendment 2) the four legal adjacency spellings are pairs of SPELLING
  // WHY: ALIASES of two insertion positions — `before T=s1` ≡ `after T=s1-1` (immediately above the
  // WHY: span) and `after T=s2` ≡ `before T=s2+1` (immediately below). Equal positions must produce
  // WHY: equal bytes, and both must equal the input (an adjacent degenerate move is a noop). The
  // WHY: shipped test above pinned only the working alias of the first position and omitted the
  // WHY: corrupt mirror of the second, which is why the suite stayed green over P1-A.
  it("all four legal adjacency spellings of a move are honest noops, each alias pair equal", async () => {
    await withTempFile("sample.txt", "a\nb\nX\nY\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const input = "a\nb\nX\nY\nc\n";
      const h = await lineHashes(input, home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const move = async (at: Placement, line: number) => {
        const result = await execute(
          {
            file: "sample.txt",
            edits: [spanRefItem([h[line - 1]!, h[line - 1]!], [h[2]!, h[3]!], true, at)],
          },
          cwd,
          { sessionKey: TEST_SESSION_ID },
        );
        expect(isMutationSuccess(result)).toBe(true);
        if (!isMutationSuccess(result)) return "";
        await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe(input);
        return result.result;
      };
      const aboveBefore = await move("before", 3);
      const aboveAfter = await move("after", 2);
      const belowAfter = await move("after", 4);
      const belowBefore = await move("before", 5);
      expect(aboveBefore).toBe(input);
      expect(aboveAfter).toBe(input);
      expect(belowAfter).toBe(input);
      expect(belowBefore).toBe(input);
      expect(aboveBefore).toBe(aboveAfter);
      expect(belowAfter).toBe(belowBefore);
    });
  });

  it("adjacency at EOF without a trailing newline: every spelling keeps the bytes, newline included", async () => {
    await withTempFile("sample.txt", "a\nb\nX\nY\nc", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const input = "a\nb\nX\nY\nc";
      const h = await lineHashes(input, home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const move = async (at: Placement, line: number) => {
        const result = await execute(
          {
            file: "sample.txt",
            edits: [spanRefItem([h[line - 1]!, h[line - 1]!], [h[2]!, h[3]!], true, at)],
          },
          cwd,
          { sessionKey: TEST_SESSION_ID },
        );
        expect(isMutationSuccess(result)).toBe(true);
        if (!isMutationSuccess(result)) return "";
        await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe(input);
        return result.result;
      };
      expect(await move("before", 3)).toBe(input);
      expect(await move("after", 2)).toBe(input);
      expect(await move("after", 4)).toBe(input);
      expect(await move("before", 5)).toBe(input);
      // Whole-file span: the only legal boundary spellings are `before T = s1` and `after T = s2`.
      const whole = await execute(
        {
          file: "sample.txt",
          edits: [spanRefItem([h[0]!, h[0]!], [h[0]!, h[2]!], true, "before")],
        },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(whole)).toBe(true);
      if (!isMutationSuccess(whole)) return;
      expect(whole.result).toBe(input);
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe(input);
    });
  });

  it("a move onto an equal-text target: metrics honest, only the retirement mutates", async () => {
    await withTempFile("sample.txt", "a\nb\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nb\nc\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        { file: "sample.txt", edits: [spanRefItem([h[2]!, h[2]!], [h[1]!, h[1]!], true)] },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("a\nb\nc\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\n");
      expect(result.metrics.added_lines).toBe(0);
      expect(result.metrics.removed_lines).toBe(1);
    });
  });

  it("refuses an overlapping after-move: insertion point strictly inside the retired span", async () => {
    await withTempFile("sample.txt", "a\nb\nX\nY\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nX\nY\nc\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        { file: "sample.txt", edits: [spanRefItem([h[2]!, h[2]!], [h[2]!, h[3]!], true, "after")] },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationFailure(result)).toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_BAD_PAYLOAD");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nX\nY\nc\n");
    });
  });

  it("refuses an overlapping before-move: insertion point strictly inside the retired span", async () => {
    await withTempFile("sample.txt", "a\nb\nX\nY\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nX\nY\nc\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        {
          file: "sample.txt",
          edits: [spanRefItem([h[3]!, h[3]!], [h[2]!, h[3]!], true, "before")],
        },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationFailure(result)).toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_BAD_PAYLOAD");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nX\nY\nc\n");
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

  it("batch: an item's own target inside its own retired source refuses — bytes unchanged", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\ne\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      // WHY: the pre-mutation gate skips same-index span pairs, deferring an item's own
      // WHY: target/source overlap to `applyEdit` — this asserts the deferral lands on a refusal
      // WHY: that fires for the insertion spelling too, so the skip masks nothing.
      const result = await execute(
        {
          file: "sample.txt",
          edits: [
            spanRefItem([h[1]!, h[1]!], [h[0]!, h[3]!], true, "after"),
            handItem([h[4]!, h[4]!], "Z"),
          ],
        },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationFailure(result)).toBe(true);
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\nd\ne\n");
    });
  });

  it("batch gate: an unresolvable SOURCE anchor aborts before any mutation", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      // WHY: the pre-mutation gate resolves a retired source as its own baseline span; this pins
      // WHY: the source arm's failure path (the recorder + raw rethrow), which the single-item
      // WHY: seam test above never reaches because the gate only runs for batches.
      const result = await execute(
        {
          file: "sample.txt",
          edits: [spanRefItem([h[3]!, h[3]!], ["QQQ", "QQQ"], true), handItem([h[0]!, h[0]!], "A")],
        },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationFailure(result)).toBe(true);
      if (!isMutationFailure(result)) return;
      // WHY: the gate rethrows the RAW diagnostic for a single failing item, so the model sees
      // WHY: the anchor question itself, not only the batch envelope.
      expect(result.code).toBe("E_UNKNOWN_ANCHOR");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\nd\n");
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
