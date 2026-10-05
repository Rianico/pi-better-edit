import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, isMutationSuccess, isMutationFailure } from "../../src/mutation-engine/index.js";
import {
  withTempFile,
  withTempDir,
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
} from "../support/fixtures.js";
import { lineHashes, initHasher } from "../../src/hashline/index.js";
import { loadHashStore, type HashStore } from "../../src/hash-store.js";
import { readNormFile } from "../../src/file-reader.js";
import type { NormalizedEditRequest, Placement } from "../../src/payload-contract.js";

useTestHome();

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
  at: Placement = "in-place",
): NormalizedEditRequest["edits"][number] {
  return {
    target: { anchor_from: target[0], anchor_to: target[1] },
    at,
    payload: {
      kind: "reference",
      span: {
        anchor_from: source[0],
        anchor_to: source[1],
        mode: retire ? ("cut" as const) : ("copy" as const),
      },
      mode: retire ? "cut" : "copy",
    },
  };
}

function handItem(
  target: [string, string],
  text: string,
  at: Placement = "in-place",
): NormalizedEditRequest["edits"][number] {
  return {
    target: { anchor_from: target[0], anchor_to: target[1] },
    at,
    payload: { kind: "literal", text },
  };
}

// WHY: (ticket-04 rework item iv → 04b) admission now admits a foreign `cut`, but this helper
// WHY: still builds the shape directly at the engine seam — the payload the pre-pass consumes,
// WHY: without the `text_ref` admission sugar.
function foreignRefItem(
  target: [string, string],
  source: [string, string],
  file: string,
  mode: "copy" | "cut",
): NormalizedEditRequest["edits"][number] {
  return {
    target: { anchor_from: target[0], anchor_to: target[1] },
    at: "in-place",
    payload: {
      kind: "reference",
      span: { anchor_from: source[0], anchor_to: source[1], file, mode },
      mode,
    },
  };
}

// WHY: (keel F3) the normalized `reference` payload carries the mode TWICE — `payload.mode` and
// `span.mode` (admission copies `text_ref` verbatim into `span`, payload-contract.ts:441). This
// builds the disagreement; only engine-side validation can see it.
function modeMismatchItem(
  target: [string, string],
  source: [string, string],
  spanMode: "copy" | "cut",
  payloadMode: "copy" | "cut",
): NormalizedEditRequest["edits"][number] {
  return {
    target: { anchor_from: target[0], anchor_to: target[1] },
    at: "in-place",
    payload: {
      kind: "reference",
      span: { anchor_from: source[0], anchor_to: source[1], mode: spanMode },
      mode: payloadMode,
    },
  };
}

type RecordedQuery = { sql: string; params: unknown[] };

// WHY: (§10) counts served-table SELECTs that flow THROUGH the injected store without touching
// src: the Proxy delegates every call to the real store and records each executed statement.
function countingStore(real: HashStore): { store: HashStore; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const db = new Proxy(real.db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (...args: unknown[]) => {
          const sql = args[0] as string;
          // SAFETY: sqlite StatementSync is duck-typed here — only all/get/run are wrapped and
          // SAFETY: every call delegates to the original statement, so behavior is unchanged.
          const stmt = (target.prepare as (sql: string, ...rest: unknown[]) => unknown).call(
            target,
            ...(args as [string, ...unknown[]]),
          ) as Record<string, unknown>;
          return new Proxy(stmt, {
            get(t, p, r) {
              if (p === "all" || p === "get" || p === "run") {
                return (...params: unknown[]) => {
                  queries.push({ sql, params });
                  return (t[p] as (...a: unknown[]) => unknown).apply(t, params);
                };
              }
              return Reflect.get(t, p, r);
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      // SAFETY: bind native methods to the real db so the sqlite handle's internal slot stays valid.
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { store: { db, engine: "node:sqlite" }, queries };
}

// WHY: the served mirror row read is the unit §10 memoizes (read + load + lease per resolved
// absolute path); `served_leases`/`DELETE FROM served` statements and target-path reads are not
// foreign-source reads and stay out of the count.
function foreignServedReads(queries: RecordedQuery[], foreignAbs: string): number {
  return queries.filter(
    (q) => /^\s*SELECT .*FROM served WHERE/.test(q.sql) && q.params.some((p) => p === foreignAbs),
  ).length;
}

describe("MutationEngine — span-ref move", () => {
  it("moves a multi-line span: source retired, target replaced, metrics honest", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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

  // WHY: (ticket-02d P1) `splitLines("")` is one empty line, so a legal degenerate move
  // WHY: (source [1,1], retire, target [1,1]) assembles to [""] and the terminator clause-2
  // WHY: misfired on it: the head commit wrote "\n" to disk where its parent was an honest
  // WHY: noop. Assert the disk bytes before AND after — a noop that throws nothing while
  // WHY: writing "\n" IS the P1.
  it("the empty file's touching move stays an honest noop — disk bytes unchanged", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("", join(cwd, "empty.txt"));
      await readTool.execute("r1", { file: "empty.txt" }, undefined, undefined, ctx);
      await expect(readFile(`${cwd}/empty.txt`, "utf-8")).resolves.toBe("");
      for (const at of ["before", "after"] as const) {
        const result = await execute(
          {
            file: "empty.txt",
            edits: [spanRefItem([h[0]!, h[0]!], [h[0]!, h[0]!], true, at)],
          },
          cwd,
          { sessionKey: TEST_SESSION_ID },
        );
        expect(isMutationSuccess(result)).toBe(true);
        if (!isMutationSuccess(result)) return;
        expect(result.result).toBe("");
        await expect(readFile(`${cwd}/empty.txt`, "utf-8")).resolves.toBe("");
        expect(result.metrics.classification).toBe("noop");
      }
    });
  });

  it("refuses a retired source that overlaps its own target — E_BAD_PAYLOAD, bytes unchanged", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes(input, join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes(input, join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nb\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nX\nY\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nX\nY\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nc\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        { file: "sample.txt", edits: [spanRefItem([h[2]!, h[2]!], ["QQQQ", "QQQQ"], true)] },
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
      const h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nc\nd\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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
      const h = await lineHashes("a\nb\nc\nd\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      // WHY: the pre-mutation gate resolves a retired source as its own baseline span; this pins
      // WHY: the source arm's failure path (the recorder + raw rethrow), which the single-item
      // WHY: seam test above never reaches because the gate only runs for batches.
      const result = await execute(
        {
          file: "sample.txt",
          edits: [
            spanRefItem([h[3]!, h[3]!], ["QQQQ", "QQQQ"], true),
            handItem([h[0]!, h[0]!], "A"),
          ],
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
      const h = await lineHashes("a\nb\nc\nd\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
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

describe("MutationEngine — reference payloads at the engine seam (ticket-04 rework)", () => {
  it('commits a directly-constructed foreign mode:"cut" as one two-file transaction (04b supersedes item iv)', async () => {
    // WHY: (ticket-04 rework item iv → ticket-04b §1) this test used to PIN a loud refusal: the
    // WHY: pre-pass collapsed every foreign reference to a literal COPY before `parseEdits`, so a
    // WHY: foreign `cut` silently succeeded as a copy and the requested retirement vanished —
    // WHY: silence was the bug and the refusal was the stopgap. 04b deletes the stopgap in the
    // WHY: same commit as the fix: the pre-pass RECORDS the cut and `runCutTransaction` retires
    // WHY: the source as a first-class edit against that file (ADR-0028). Both halves stay pinned
    // WHY: here — no silent copy (the source really is retired) and the insert lands at the target.
    await withTempDir("spanref-foreign-cut-", async (cwd) => {
      await writeFile(join(cwd, "sample.txt"), "a\nb\nc\nd\ne\n", "utf-8");
      await writeFile(join(cwd, "other.txt"), "x\ny\nz\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "other.txt" }, undefined, undefined, ctx);
      const h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "sample.txt"));
      const s = await lineHashes("x\ny\nz\n", join(cwd, "other.txt"));
      const result = await execute(
        {
          file: "sample.txt",
          edits: [foreignRefItem([h[4]!, h[4]!], [s[0]!, s[1]!], "other.txt", "cut")],
        },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result), "the foreign cut must commit, not refuse").toBe(true);
      if (!isMutationSuccess(result)) return;
      expect(result.result).toBe("a\nb\nc\nd\nx\ny\n");
      await expect(readFile(join(cwd, "sample.txt"), "utf-8")).resolves.toBe("a\nb\nc\nd\nx\ny\n");
      await expect(readFile(join(cwd, "other.txt"), "utf-8")).resolves.toBe("z\n");
    });
  });

  it("refuses a nested span.mode that disagrees with the payload mode (keel F3)", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      for (const [spanMode, payloadMode] of [
        ["cut", "copy"],
        ["copy", "cut"],
      ] as const) {
        const result = await execute(
          {
            file: "sample.txt",
            edits: [modeMismatchItem([h[4]!, h[4]!], [h[0]!, h[1]!], spanMode, payloadMode)],
          },
          cwd,
          { sessionKey: TEST_SESSION_ID },
        );
        // WHY: `parseEdits` reads only `payload.mode` (pipeline.ts:386-388), so a disagreeing
        // nested `span.mode` validates silently and ships whichever arm `payload.mode` names.
        // The nested mode must be validated against the top-level one — loud E_BAD_PAYLOAD.
        expect(
          isMutationFailure(result),
          `span.mode ${spanMode} vs mode ${payloadMode} must be refused, not validated silently`,
        ).toBe(true);
        if (!isMutationFailure(result)) continue;
        expect(result.code).toBe("E_BAD_PAYLOAD");
        await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\nd\ne\n");
      }
    });
  });

  it("reads one foreign file once per batch through the injected store (§10)", async () => {
    let h!: string[];
    let s!: string[];

    const copyItem = (from: number, to: number, onto: number) => ({
      target: { anchor_from: h[onto - 1]!, anchor_to: h[onto - 1]! },
      at: "after" as const,
      payload: {
        kind: "reference" as const,
        span: {
          anchor_from: s[from - 1]!,
          anchor_to: s[to - 1]!,
          file: "source.txt",
          mode: "copy" as const,
        },
        mode: "copy" as const,
      },
    });
    let batchResult = "";
    let sequenced = "";
    await withTempDir("spanref-foreign-onceread-", async (cwd) => {
      await writeFile(join(cwd, "target.txt"), "a\nb\nc\nd\ne\n", "utf-8");
      await writeFile(join(cwd, "source.txt"), "p\nq\nr\ns\nt\n", "utf-8");
      h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "target.txt"));
      s = await lineHashes("p\nq\nr\ns\nt\n", join(cwd, "source.txt"));
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "source.txt" }, undefined, undefined, ctx);
      // WHY: the store is re-opened per HOME-stubbed directory, so the injected proxy must wrap
      // the store that THIS directory's setup opened — capturing it outside would wrap a closed db.
      const realStore = await loadHashStore();
      const foreignAbs = (
        await readNormFile("source.txt", cwd, { store: realStore, noPersist: true })
      ).absolutePath;
      const counting = countingStore(realStore);
      const result = await execute(
        { file: "target.txt", edits: [copyItem(1, 2, 5), copyItem(4, 5, 1)] },
        cwd,
        { sessionKey: TEST_SESSION_ID, store: counting.store },
      );
      expect(
        isMutationSuccess(result),
        isMutationFailure(result)
          ? `two-item foreign batch must succeed: ${result.code} ${result.message}`
          : "two-item foreign batch must succeed",
      ).toBe(true);
      if (!isMutationSuccess(result)) return;
      batchResult = result.result;
      // WHY: (§10) read + load + lease of the foreign file are memoized on the resolved absolute
      // path: a batch of TWO foreign items owes exactly ONE served-table read per file, THROUGH
      // the injected store. At HEAD the pre-pass loads the session handle WITHOUT `input.store`
      // (pipeline.ts:491), so the injected store sees ZERO foreign reads — the count, not the
      // bytes, is the witness.
      expect(foreignServedReads(counting.queries, foreignAbs)).toBe(1);
      await expect(readFile(join(cwd, "source.txt"), "utf-8")).resolves.toBe("p\nq\nr\ns\nt\n");
    });
    // WHY: byte-identity arm: the batched result equals running the same two items as separate
    // sequential single-item batches — per-batch memoization must not stale-share across calls
    // either. PIN (green at HEAD on this content — the served-read count above is the red half).
    await withTempDir("spanref-foreign-sequential-", async (cwd) => {
      await writeFile(join(cwd, "target.txt"), "a\nb\nc\nd\ne\n", "utf-8");
      await writeFile(join(cwd, "source.txt"), "p\nq\nr\ns\nt\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "source.txt" }, undefined, undefined, ctx);
      // WHY: anchors are directory-seeded — the sequential dir needs its own.
      h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "target.txt"));
      s = await lineHashes("p\nq\nr\ns\nt\n", join(cwd, "source.txt"));
      const first = await execute({ file: "target.txt", edits: [copyItem(1, 2, 5)] }, cwd, {
        sessionKey: TEST_SESSION_ID,
      });
      expect(isMutationSuccess(first), "first single-item foreign batch must succeed").toBe(true);
      if (!isMutationSuccess(first)) return;
      const second = await execute({ file: "target.txt", edits: [copyItem(4, 5, 1)] }, cwd, {
        sessionKey: TEST_SESSION_ID,
      });
      expect(isMutationSuccess(second), "second single-item foreign batch must succeed").toBe(true);
      if (!isMutationSuccess(second)) return;
      sequenced = second.result;
    });
    expect(batchResult).toBe(sequenced);
    expect(batchResult).toBe("a\ns\nt\nb\nc\nd\ne\np\nq\n");
  });

  it("refuses a directly-constructed zero-line literal at the parse seam (remediation-2 B4)", async () => {
    // RED at `ad80222` — a behavioural regression witness: the min-line guard sits in `assertReq`,
    // which this entry point never calls, so `{kind:"literal", text:""}` DELETES the target span
    // and reports success where `baef230` refused it. Mirrors item (iv): the engine seam must
    // refuse LOUD, naming the wire field `"text"`, and the file must stay byte-identical.
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "sample.txt"));
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const result = await execute(
        { file: "sample.txt", edits: [handItem([h[1]!, h[1]!], "")] },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(
        isMutationFailure(result),
        isMutationSuccess(result)
          ? `zero-line literal succeeded and deleted the span: ${JSON.stringify(result.result)}`
          : "zero-line literal must be refused",
      ).toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_BAD_PAYLOAD");
      expect(result.message).toContain('"text"');
      expect(result.message).toContain("must carry at least one line");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\nd\ne\n");
    });
  });
});
