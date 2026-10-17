import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import register from "../../index";
import type { LocatedBox } from "../../src/bash-conversion/decide.js";
import { decide } from "../../src/bash-conversion/decide.js";
import { useTestHome, withTempDir } from "../support/fixtures";

useTestHome();

// WHY per-rule pins (#152 relaxation A): a single leading block with an inert `wc` tail
// converts to a compound whose block is byte-identical to the standalone serve; every other
// tail shape falls through to the ORIGINAL guards with their ORIGINAL reasons (proved below
// by asserting the legacy reason strings, not just "declines").

function reasonOf(command: string): string {
  const decision = decide(command);
  if (decision.kind !== "passThrough") throw new Error(`expected decline for ${command}`);
  return decision.reason;
}

describe("bash relaxation-A decisions (#152)", () => {
  it("admits a leading view with one inert tail", () => {
    const decision = decide("cat data.txt; wc -l notes.md");
    expect(decision).toEqual({
      kind: "pureCompound",
      segments: [
        { kind: "view", filePath: "data.txt", ops: [] },
        { kind: "raw", command: "wc -l notes.md" },
      ],
    });
  });
  it("admits the `&&` joined head identically", () => {
    const decision = decide("cat data.txt && wc -l notes.md");
    expect(decision.kind).toBe("pureCompound");
    if (decision.kind === "pureCompound") {
      expect(decision.segments.map((segment) => segment.kind)).toEqual(["view", "raw"]);
    }
  });
  it("admits a leading search with one inert tail and records the splice offset", () => {
    const located: LocatedBox = {};
    const decision = decide("grep -n beta notes.md; wc -l data.txt", located);
    expect(decision.kind).toBe("pureCompound");
    if (decision.kind === "pureCompound") {
      expect(decision.segments.map((segment) => segment.kind)).toEqual(["search", "raw"]);
    }
    expect(located.searchNameEnds?.length).toBe(1);
  });
  it("admits several inert tails after the head", () => {
    const decision = decide("cat f; wc -l a; wc -l b");
    expect(decision.kind).toBe("pureCompound");
    if (decision.kind === "pureCompound") {
      expect(decision.segments.map((segment) => segment.kind)).toEqual(["view", "raw", "raw"]);
    }
  });
  it("declines a second block with the legacy prefix reason", () => {
    expect(reasonOf("cat a.txt; cat b.txt")).toBe("multi-statement");
  });
  it("declines a view that is not first via the tail's own reason", () => {
    expect(reasonOf("wc -l x; cat data.txt")).toBe("unsupported-command:wc");
  });
  it("declines a trailing search with the legacy prefix reason", () => {
    expect(reasonOf("cat data.txt; grep -n beta notes.md")).toBe("multi-statement");
  });
  it("declines a post-view `cd` with its guard reason", () => {
    expect(reasonOf("cat data.txt && cd /tmp && pwd")).toBe("post-view-cd");
    // WHY: the `;` joined twin never reaches the `cd` guard — the head rule needs every tail
    // WHY: segment inert, and a `cd` is explicitly not inert, so the prefix gate fires first.
    // WHY: Both joiners decline; the `&&` form proves the guard itself still holds.
    expect(reasonOf("cat data.txt; cd /tmp; pwd")).toBe("multi-statement");
  });
  it("declines an unsafe tail with its own reason", () => {
    expect(reasonOf("cat data.txt && sed 's/a/b/' data.txt")).toBe("unsupported-command:sed");
  });
  it("keeps the glued multi-block compound converting", () => {
    const decision = decide("echo hi && cat a && cat b");
    expect(decision.kind).toBe("pureCompound");
    if (decision.kind === "pureCompound") {
      expect(decision.segments.map((segment) => segment.kind)).toEqual(["glue", "view", "view"]);
    }
  });
  it("refuses a stdin-reading `wc` anywhere", () => {
    // WHY: a bare `wc -l` counts the harness stdin — un attributable, so never inert.
    expect(reasonOf("wc -l")).toBe("unsupported-command:wc");
    expect(reasonOf("cat f; wc -l")).toBe("multi-statement");
  });
  it("declines when a block follows the tail", () => {
    // WHY: the head rule requires EVERY later segment inert; a later block vetoes admission
    // WHY: up front, so the legacy prefix guard fires with its legacy reason.
    expect(reasonOf("cat a; wc -l b; cat c")).toBe("multi-statement");
  });
  it("keeps glued chains on their exact legacy behavior", () => {
    // WHY: relaxation A is glue-free by definition (`!hasGlue` in the head rule) — a glued
    // WHY: chain with a non-glue tail declines exactly as before, via the tail's own reason.
    expect(reasonOf("echo hi && cat f && wc -l g")).toBe("unsupported-command:wc");
  });
});

function rowsOf(text: string): string[] {
  return text.split("\n").filter((line) => line.includes("\u2502"));
}

function makeFakePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    pi: {
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    } as any,
    handlers,
  };
}

async function bashResult(
  handler: (...args: unknown[]) => unknown,
  command: string,
  ctx: { cwd: string; sessionManager: { getSessionId(): string } },
  stdout: string,
) {
  return (await handler!(
    {
      toolName: "bash",
      isError: false,
      input: { command },
      content: [{ type: "text", text: stdout }],
    },
    ctx,
  )) as { content: Array<{ type: string; text: string }> } | undefined;
}

describe("bash relaxation-A rendering (#152)", () => {
  it("serves the block identically to a standalone view, then the raw tail", async () => {
    await withTempDir("bash-inert-", async (dir) => {
      const data = "alpha\nbeta\n";
      await writeFile(join(dir, "data.txt"), data, "utf-8");
      await writeFile(join(dir, "notes.md"), "one\ntwo\nthree\n", "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      expect(handler).toBeDefined();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-inert-a" } };
      const tail = "       3 notes.md\n";

      const standalone = await bashResult(handler!, "cat data.txt", ctx, data);
      expect(standalone).toBeDefined();
      const compound = await bashResult(handler!, "cat data.txt; wc -l notes.md", ctx, data + tail);
      expect(compound).toBeDefined();
      // WHY: the block's rows (hash anchors + content) are identical to the standalone
      // WHY: serve — the tail contributes bytes only, never leases. (The compound seam
      // WHY: newline-normalizes the block envelope; rows and anchors are what must match.)
      const compoundText = compound!.content[0]!.text;
      const standaloneText = standalone!.content[0]!.text;
      expect(rowsOf(compoundText)).toEqual(rowsOf(standaloneText));
      expect(compoundText.endsWith(tail)).toBe(true);
      expect(compoundText.slice(0, -tail.length).endsWith("\n")).toBe(true);
    });
  });
  it("serves the search block identically to a standalone search, then the raw tail", async () => {
    await withTempDir("bash-inert-", async (dir) => {
      await writeFile(join(dir, "notes.md"), "one beta\ntwo\nthree beta\n", "utf-8");
      await writeFile(join(dir, "data.txt"), "alpha\nbeta\n", "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      expect(handler).toBeDefined();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-inert-b" } };
      const searchOut = "1:one beta\n3:three beta\n";
      const tail = "       2 data.txt\n";

      const standalone = await bashResult(handler!, "grep -n beta notes.md", ctx, searchOut);
      expect(standalone).toBeDefined();
      const compound = await bashResult(
        handler!,
        "grep -n beta notes.md; wc -l data.txt",
        ctx,
        searchOut + tail,
      );
      expect(compound).toBeDefined();
      const compoundText = compound!.content[0]!.text;
      const standaloneText = standalone!.content[0]!.text;
      expect(rowsOf(compoundText)).toEqual(rowsOf(standaloneText));
      expect(compoundText.endsWith(tail)).toBe(true);
    });
  });
});
