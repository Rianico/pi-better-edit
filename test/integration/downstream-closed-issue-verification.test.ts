/**
 * Closed downstream (`Rianico/dsh-better-edit`) issues re-verified against the line-identity MVCC
 * redesign (bd3a8f2).
 *
 * Why re-verify at all: several of those closes rested on mechanisms the redesign *replaced*, so
 * "closed" is not inherited evidence —
 *   - #31 (freed anchors re-bind to identical-content lines) was closed by ADR-0013 epoch `strictPos`,
 *     which the spec rejects as dead code and supersedes with leases;
 *   - #48 (epoch-lifecycle remainder — full-read gating) rested on the epoch concurrency model that
 *     ADR-0017 supersedes with the LRU vacuum; its upstream sibling `pi-better-edit#70` (dense
 *     re-serve after write) described the same epoch-era serve path;
 *   - #51 (anchor-space exhaustion reported as `E_LARGE_FILE`) rested on the accumulation of
 *     session-retired anchors;
 *   - #53 (incomplete served refresh after multi-entry batches) and #38 (boundary duplicate removal)
 *     sit on the apply/serve path the redesign rewrote.
 *
 * Each `it` pins the property the close depended on. Issues whose path the redesign never touched are
 * covered by existing green suites (cited per case) rather than duplicated here. Downstream closes
 * that are DSH-port-only (#71, #69, #43 — the `str_replace_editor` shadow and the agent-scope router)
 * are out of reach of this package: `rg` finds no such seam here.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import register from "../../index";
import { withTempFile, withTempBytes, setupIntegrationTest, getText } from "../support/fixtures";
import { loadServed } from "../../src/served-session";
import { sessionKeyFor } from "../../src/served-session/session";

function ctxFor(cwd: string, id = "closed-issues"): unknown {
  return { cwd, ui: { notify() {} }, sessionManager: { getSessionId: () => id } };
}

function rows(text: string): { hash: string; text: string }[] {
  const out: { hash: string; text: string }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z0-9]{3})│(.*)$/);
    if (m) out.push({ hash: m[1]!, text: m[2]! });
  }
  return out;
}

const BOM = "\uFEFF";

describe("closed #64 — legacy object-form edits entries", () => {
  it("applies {remove_from, remove_to, replacement_text} end-to-end through the tool seam", async () => {
    await withTempFile("legacy.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const served = rows(
        getText(await readTool.execute("r1", { path: "legacy.txt" }, undefined, undefined, ctx)),
      );
      const line2 = served[1]!.hash;

      const res = await editTool.execute(
        "e1",
        {
          file: "legacy.txt",
          edits: [{ remove_from: line2, remove_to: line2, replacement_text: "TWO" }],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(res)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("one\nTWO\nthree\n");
    });
  });
});

describe("closed #31 — retired anchors never re-bind to a twin", () => {
  it("fails closed when a deleted line's anchor is reused on its surviving duplicate", async () => {
    await withTempFile("twins.txt", "aaa\nbbb\naaa\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = rows(
        getText(await readTool.execute("r1", { path: "twins.txt" }, undefined, undefined, ctx)),
      );
      const line1 = first[0]!.hash;
      const line3 = first[2]!.hash;
      expect(line1).not.toBe(line3);

      // delete line 1: line 3's `aaa` shifts up, and line 1's anchor is retired
      await editTool.execute(
        "e1",
        { path: "twins.txt", edits: [[line1, line1, ""]] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("bbb\naaa\n");

      // reuse the deleted anchor: must fail closed, never re-bind onto the surviving `aaa`
      await expect(
        editTool.execute(
          "e2",
          { path: "twins.txt", edits: [[line1, line1, "CCC"]] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_STALE_(ANCHOR|RANGE)/);
      expect(await readFile(path, "utf-8")).toBe("bbb\naaa\n");
    });
  });
});

describe("closed #53 — served refresh after a multi-entry batch", () => {
  it("leaves a dense served mirror and chains a follow-up edit off the batch diff", async () => {
    const content = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await withTempFile("batch.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const served = rows(
        getText(await readTool.execute("r1", { path: "batch.txt" }, undefined, undefined, ctx)),
      );
      const line2 = served[1]!.hash;
      const line10 = served[9]!.hash;

      const batch = await editTool.execute(
        "e1",
        {
          path: "batch.txt",
          edits: [
            [line2, line2, "line 2 modified"],
            [line10, line10, "line 10\nline 10.1\nline 10.2"],
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(batch)).toContain("Successfully edited");

      const after = (await readFile(path, "utf-8")).split("\n");
      const mirror = await loadServed(sessionKeyFor(ctx as never), path);
      // denseness: the whole file stays served (never a hole inside the length)
      expect(mirror.slice(0, after.length - 1).every((h) => h !== null)).toBe(true);

      // chain: a diff-row anchor is usable without a re-read
      const diff = (batch.details as { diff?: string }).diff ?? "";
      const anchor = diff
        .split("\n")
        .find((l) => l.startsWith("+") && l.includes("│line 10.2"))!
        .slice(1, 4);
      const chained = await editTool.execute(
        "e2",
        { path: "batch.txt", edits: [[anchor, anchor, "line 10.2 chained"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(chained)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toContain("line 10.2 chained");
    });
  });
});

describe("closed #48 — full re-read after an external change", () => {
  it("re-serves a dense mirror and accepts the fresh anchors for the next edit", async () => {
    await withTempFile("shift.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "shift.txt" }, undefined, undefined, ctx);

      const { writeFile } = await import("fs/promises");
      await writeFile(path, "a\nb\nc\nd\ne\nf\n", "utf-8");

      const reread = rows(
        getText(await readTool.execute("r2", { path: "shift.txt" }, undefined, undefined, ctx)),
      );
      expect(reread.map((r) => r.text)).toEqual(["a", "b", "c", "d", "e", "f"]);
      const mirror = await loadServed(sessionKeyFor(ctx as never), path);
      expect(mirror).toHaveLength(6);
      expect(mirror.every((h) => h !== null)).toBe(true);

      const last = reread[5]!.hash;
      await editTool.execute(
        "e1",
        { path: "shift.txt", edits: [[last, last, "F"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\ne\nF\n");
    });
  });
});

describe("closed #51 — anchor space is a line-count limit, not a retirement accumulator", () => {
  it("keeps serving and editing after delete-heavy churn across fresh sessions", async () => {
    const content = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join("\n") + "\n";
    await withTempFile("churn.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      for (let round = 0; round < 6; round++) {
        const sessionCtx = ctxFor(cwd, `churn-${round}`);
        const served = rows(
          getText(
            await readTool.execute(
              `r${round}`,
              { path: "churn.txt" },
              undefined,
              undefined,
              sessionCtx,
            ),
          ),
        );
        const victim = served[0]!.hash; // retire the first line's anchor every round
        await editTool.execute(
          `e${round}`,
          { path: "churn.txt", edits: [[victim, victim, ""]] },
          undefined,
          undefined,
          sessionCtx,
        );
      }

      const finalCtx = ctxFor(cwd, "churn-final");
      const fresh = rows(
        getText(
          await readTool.execute("rf", { path: "churn.txt" }, undefined, undefined, finalCtx),
        ),
      );
      expect(fresh).toHaveLength(14);
      const target = fresh[13]!.hash;
      await editTool.execute(
        "ef",
        { path: "churn.txt", edits: [[target, target, "row 20 last"]] },
        undefined,
        undefined,
        finalCtx,
      );
      expect(await readFile(path, "utf-8")).toContain("row 20 last");
      expect((await readFile(path, "utf-8")).split("\n")).toHaveLength(15);
    });
  });
});

describe("closed #23/#60 — BOM and encoding handling", () => {
  it("preserves the UTF-8 BOM across an edit", async () => {
    await withTempBytes(
      "bom.txt",
      Buffer.from(`${BOM}alpha\nbravo\ncharlie\n`, "utf-8"),
      async ({ cwd, path }) => {
        const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
        const served = rows(
          getText(await readTool.execute("r1", { path: "bom.txt" }, undefined, undefined, ctx)),
        );
        const line2 = served[1]!.hash;

        await editTool.execute(
          "e1",
          { path: "bom.txt", edits: [[line2, line2, "BRAVO"]] },
          undefined,
          undefined,
          ctx,
        );

        const bytes = await readFile(path);
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(bytes.toString("utf-8")).toBe(`${BOM}alpha\nBRAVO\ncharlie\n`);
      },
    );
  });

  it("flags non-UTF-8 input on read instead of failing silently", async () => {
    // GBK-encoded "中文" — invalid UTF-8
    await withTempBytes("gbk.txt", Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]), async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute("r1", { path: "gbk.txt" }, undefined, undefined, ctx),
      );
      // #34's contract: readable, with the lossy-decoding disclosure
      expect(text).toContain("Non-UTF-8 bytes shown as U+FFFD");
    });
  });
});

describe("multi-session — session key authority", () => {
  it("falls back to one in-process key when the context carries no sessionManager", async () => {
    await withTempFile("fallback.txt", "alpha\n", async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const bareA = { cwd }; // no sessionManager
      const bareB = { cwd }; // a second context, also without one

      // Documented fallback: `sessionKeyFor` memoizes ONE process-wide key, so such contexts are a
      // single logical session. pi always supplies `sessionManager`; this pin keeps the fallback
      // from ever reading as per-context isolation.
      expect(sessionKeyFor(bareA as never)).toBe(sessionKeyFor(bareB as never));

      const served = rows(
        getText(
          await readTool.execute("r1", { path: "fallback.txt" }, undefined, undefined, bareA),
        ),
      );
      await editTool.execute(
        "e1",
        { path: "fallback.txt", edits: [[served[0]!.hash, served[0]!.hash, "ALPHA"]] },
        undefined,
        undefined,
        bareB,
      );
      expect(await readFile(path, "utf-8")).toBe("ALPHA\n");
    });
  });
});

describe("closed #38 — boundary duplicate removal", () => {
  it("keeps a replacement's last line when it equals the line after remove_to", async () => {
    await withTempFile("braces.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const served = rows(
        getText(await readTool.execute("r1", { path: "braces.ts" }, undefined, undefined, ctx)),
      );
      const line1 = served[0]!.hash;

      await editTool.execute(
        "e1",
        { path: "braces.ts", edits: [[line1, line1, "X\nb"]] },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe("X\nb\nb\nc\n");
    });
  });
});

describe("closed #29 — write path never injects anchors", () => {
  it("allows clean content through the registered write hook unchanged", async () => {
    await withTempFile("hook.txt", "seed\n", async ({ cwd, path }) => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const tools = new Map<string, unknown>();
      register({
        registerTool: (t: { name: string }) => tools.set(t.name, t),
        registerCommand() {},
        on: (e: string, h: (...args: unknown[]) => unknown) => handlers.set(e, h),
        getActiveTools: () => [],
        setActiveTools() {},
      } as never);

      const input = { path, content: "# title\n\nplain body\n" };
      const ctx = ctxFor(cwd, "hook-session");
      const handler = handlers.get("tool_call");
      if (handler) {
        const decision = await handler({ toolName: "write", input }, ctx);
        expect((decision as { block?: boolean } | undefined)?.block ?? false).toBe(false);
      }

      const { writeFile } = await import("fs/promises");
      await writeFile(path, String(input.content), "utf-8");
      const written = await readFile(path, "utf-8");
      expect(written).toBe("# title\n\nplain body\n");
      expect(written).not.toMatch(/[A-Za-z0-9]{3}│/);
    });
  });
});
