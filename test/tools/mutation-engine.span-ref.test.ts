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
import { lineHashes, initHasher } from "../../src/hashline/hash-identity.js";
import { loadHashStore, type HashStore } from "../../src/hash-store.js";
import { readNormFile } from "../../src/file-reader.js";
import type { NormalizedEditRequest, Placement } from "../../src/payload-contract.js";

useTestHome();

beforeAll(async () => {
  await initHasher();
});

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

function foreignServedReads(queries: RecordedQuery[], foreignAbs: string): number {
  return queries.filter(
    (q) =>
      /^\s*SELECT hashes FROM served_session_meta WHERE/.test(q.sql) &&
      q.params.some((p) => p === foreignAbs),
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
      expect(result.result).toBe("b\nC\na\n");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("b\nC\na\n");
    });
  });
});

describe("MutationEngine — reference payloads at the engine seam (ticket-04 rework)", () => {
  it('commits a directly-constructed foreign mode:"cut" as one two-file transaction (04b supersedes item iv)', async () => {
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
        expect(
          isMutationFailure(result),
          `span.mode ${spanMode} vs mode ${payloadMode} must be refused, not validated silently`,
        ).toBe(true);
        if (!isMutationFailure(result)) continue;
        expect(result.code).toBe("E_INTERNAL_INVARIANT");
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
      expect(foreignServedReads(counting.queries, foreignAbs)).toBe(1);
      await expect(readFile(join(cwd, "source.txt"), "utf-8")).resolves.toBe("p\nq\nr\ns\nt\n");
    });
    await withTempDir("spanref-foreign-sequential-", async (cwd) => {
      await writeFile(join(cwd, "target.txt"), "a\nb\nc\nd\ne\n", "utf-8");
      await writeFile(join(cwd, "source.txt"), "p\nq\nr\ns\nt\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "source.txt" }, undefined, undefined, ctx);
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
      expect(result.code).toBe("E_INTERNAL_INVARIANT");
      expect(result.message).toContain('"text"');
      expect(result.message).toContain("must carry at least one line");
      await expect(readFile(`${cwd}/sample.txt`, "utf-8")).resolves.toBe("a\nb\nc\nd\ne\n");
    });
  });
});
