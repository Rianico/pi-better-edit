/**
 * `decide()` admits an inert `wc` count tail after verified blocks: relaxation A (#152) for one
 * leading block with no glue, and D4 (#185, ADR-0048) past the last block of a multi-block
 * static-glue chain. The tail stays bytes-only — no block, anchor, or lease — and every other
 * tail shape falls through to the guard that already owned it, with its byte-identical legacy
 * reason.
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import register from "../../index";
import type { LocatedBox } from "../../src/bash-conversion/decide.js";
import { decide } from "../../src/bash-conversion/decide.js";
import { useTestHome, withTempDir } from "../support/fixtures";

useTestHome();

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
    expect(reasonOf("wc -l")).toBe("unsupported-command:wc");
    expect(reasonOf("cat f; wc -l")).toBe("multi-statement");
  });
  it("declines when a block follows the tail", () => {
    expect(reasonOf("cat a; wc -l b; cat c")).toBe("multi-statement");
  });
  it("keeps the single-block glued chain declining (D4 scope is multi-block)", () => {
    expect(reasonOf("echo hi && cat f && wc -l g")).toBe("unsupported-command:wc");
  });
});

describe("bash inert count tail after verified blocks (#185)", () => {
  it("admits the multi-block static-glue chain with a final count tail", () => {
    expect(decide("echo hi && cat a.txt && cat b.txt && wc -l a.txt b.txt")).toEqual({
      kind: "pureCompound",
      segments: [
        { kind: "glue", glue: { program: "echo", expectedText: "hi\n", expectedBytes: 3 } },
        { kind: "view", filePath: "a.txt", ops: [] },
        { kind: "view", filePath: "b.txt", ops: [] },
        { kind: "raw", command: "wc -l a.txt b.txt" },
      ],
    });
  });
  it("admits the tail after a search block without recording a splice offset", () => {
    const located: LocatedBox = {};
    const decision = decide("echo hi && cat a.txt && grep -n beta b.txt && wc -l b.txt", located);
    expect(decision.kind).toBe("pureCompound");
    if (decision.kind === "pureCompound") {
      expect(decision.segments.map((segment) => segment.kind)).toEqual([
        "glue",
        "view",
        "search",
        "raw",
      ]);
    }
    expect(located.searchNameEnds?.length).toBe(1);
  });
  it("admits several count tails after the last block", () => {
    const decision = decide("echo hi && cat a && cat b && wc -l a && wc -lc a b");
    expect(decision.kind).toBe("pureCompound");
    if (decision.kind === "pureCompound") {
      expect(decision.segments.map((segment) => segment.kind)).toEqual([
        "glue",
        "view",
        "view",
        "raw",
        "raw",
      ]);
    }
  });
  it("declines every non-count tail with its own legacy reason", () => {
    expect(reasonOf("echo hi && cat a && cat b && wc -w a")).toBe("unsupported-command:wc");
    expect(reasonOf("echo hi && cat a && cat b && wc a")).toBe("unsupported-command:wc");
    expect(reasonOf("echo hi && cat a && cat b && sort a")).toBe("unsupported-command:sort");
  });
  it("declines a stdin-reading, redirected, or piped count tail", () => {
    expect(reasonOf("echo hi && cat a && cat b && wc -l")).toBe("unsupported-command:wc");
    expect(reasonOf("echo hi && cat a && cat b && wc -l a > out.txt")).toBe("non-literal-command");
    expect(reasonOf("echo hi && cat a && cat b && wc -l a | head -1")).toBe("unsupported-pipeline");
  });
  it("declines a count tail that is not after the last block", () => {
    expect(reasonOf("echo hi && cat a && cat b && wc -l a && cat c")).toBe(
      "unsupported-command:wc",
    );
    expect(reasonOf("echo hi && wc -l a && cat a && cat b")).toBe("unsupported-command:wc");
  });
  it("declines a post-block `cd` before the tail with the guard's reason", () => {
    expect(reasonOf("echo hi && cat a && cat b && cd sub && wc -l a")).toBe("post-block-cd");
  });
  it("keeps relaxation A's broader inert set where it already applied", () => {
    expect(decide("cat a && wc -w a").kind).toBe("pureCompound");
  });
  it("keeps the second-block attribution guard closed", () => {
    expect(reasonOf("cat a && cat b")).toBe("multi-view");
    expect(reasonOf("grep x a && cat b")).toBe("multi-view");
    const decision = decide("echo hi && cat a && cat b");
    expect(decision.kind).toBe("pureCompound");
    if (decision.kind === "pureCompound") {
      expect(decision.segments.map((segment) => segment.kind)).toEqual(["glue", "view", "view"]);
    }
  });
  it("keeps the chain ceiling ahead of the tail", () => {
    expect(
      reasonOf("echo h && cat a && cat b && wc -l a && true && true && true && true && true"),
    ).toBe("chain-too-long");
  });
});

function rowsOf(text: string): string[] {
  return text.split("\n").filter((line) => line.includes("\u2502"));
}

function numbered(n: number): string {
  return Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n") + "\n";
}

function makeFakePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools = new Map<string, ToolExecutor>();
  return {
    pi: {
      registerTool(tool: { name: string } & ToolExecutor) {
        tools.set(tool.name, tool);
      },
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
    getTool(name: string): ToolExecutor {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`tool ${name} not registered`);
      return tool;
    },
  };
}

interface ToolExecutor {
  execute(
    id: string,
    params: unknown,
    ...rest: unknown[]
  ): Promise<{ isError?: boolean; content?: unknown }>;
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

describe("bash inert count tail rendering (#185)", () => {
  it("serves both verified blocks and leaves the count tail raw", async () => {
    await withTempDir("bash-inert-d4-", async (dir) => {
      const a = "alpha\nbeta\n";
      const b = "gamma\ndelta\n";
      await writeFile(join(dir, "a.txt"), a, "utf-8");
      await writeFile(join(dir, "b.txt"), b, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      expect(handler).toBeDefined();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-inert-d4a" } };
      const tail = "      2 a.txt\n      2 b.txt\n";

      const result = await bashResult(
        handler!,
        "echo hi && cat a.txt && cat b.txt && wc -l a.txt b.txt",
        ctx,
        `hi\n${a}${b}${tail}`,
      );
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text.startsWith("hi\n")).toBe(true);
      expect(text).toContain("[Bash view: a.txt (2 lines total)]");
      expect(text).toContain("[Bash view: b.txt (2 lines total)]");
      const rows = rowsOf(text);
      expect(rows.map((row) => row.split("\u2502").slice(1).join("\u2502"))).toEqual([
        "alpha",
        "beta",
        "gamma",
        "delta",
      ]);
      expect(text.endsWith(tail)).toBe(true);
    });
  });
  it("leases per block and leaves the count tail unrowed", async () => {
    await withTempDir("bash-inert-d4-", async (dir) => {
      const a = numbered(6);
      await writeFile(join(dir, "a.txt"), a, "utf-8");
      await writeFile(join(dir, "b.txt"), "tail\n", "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-inert-d4b" } };
      const tail = "      6 a.txt\n      1 b.txt\n";

      const result = await bashResult(
        handlers.get("tool_result")!,
        'printf "== head ==\\n" && cat a.txt && cat b.txt && wc -l a.txt b.txt',
        ctx,
        `== head ==\n${a}tail\n${tail}`,
      );
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      const rows = rowsOf(text);
      expect(text.split("\n")[0]).toBe("== head ==");
      expect(rows.map((row) => row.split("\u2502").slice(1).join("\u2502"))).toEqual([
        "line1",
        "line2",
        "line3",
        "line4",
        "line5",
        "line6",
        "tail",
      ]);
      expect(text.endsWith(tail)).toBe(true);
      const edit = (file: string, row: string, id: string) => {
        const anchor = rows.find((line) => line.endsWith(`\u2502${row}`))!.split("\u2502")[0]!;
        return getTool("edit").execute(
          id,
          { file, edits: [{ anchor_from: anchor, anchor_to: anchor, text: `X-${row}` }] },
          undefined,
          undefined,
          ctx,
        );
      };
      expect((await edit("a.txt", "line3", "e1")).isError).toBeFalsy();
      expect((await edit("b.txt", "tail", "e2")).isError).toBeFalsy();
    });
  });
});
