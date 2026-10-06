import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { lineHashes } from "../../src/hashline";
import { useTestHome, withTempDir } from "../support/fixtures";

useTestHome();

function makeFakePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools = new Map<string, unknown>();
  return {
    pi: {
      registerTool(tool: any) {
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
    getTool(name: string) {
      return tools.get(name) as {
        execute: (
          id: string,
          params: unknown,
          ...rest: unknown[]
        ) => Promise<{ content?: unknown; details?: any; isError?: boolean }>;
      };
    },
  };
}

function numberedLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n") + "\n";
}

function rowsOf(text: string): string[] {
  return text.split("\n").filter((line) => line.includes("│"));
}

function anchorFor(rows: string[], content: string): string {
  const row = rows.find((line) => line.endsWith(`│${content}`));
  if (!row) throw new Error(`no served row for ${content}`);
  return row.split("│")[0]!;
}

async function bashResult(
  handler: (...args: unknown[]) => unknown,
  command: string,
  ctx: { cwd: string; sessionManager: { getSessionId(): string } },
  extra?: Record<string, unknown>,
) {
  return (await handler!(
    {
      toolName: "bash",
      isError: false,
      input: { command },
      content: [{ type: "text", text: "<<raw stdout>>" }],
      ...extra,
    },
    ctx,
  )) as { content: Array<{ type: string; text: string }> } | undefined;
}

describe("bash view lifecycle", () => {
  it("replaces cat output with the anchored slice and grants working leases", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(30), "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      expect(handler).toBeDefined();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-a" } };

      const result = await bashResult(handler!, "cat f.txt", ctx);
      expect(result).toBeDefined();
      expect(result!.content).toHaveLength(1);
      const text = result!.content[0]!.text;
      expect(text.startsWith("--- Bash view (hashline anchors) ---\n")).toBe(true);
      expect(text).not.toContain("<<raw stdout>>");
      const rows = rowsOf(text);
      expect(rows).toHaveLength(30);

      const followUp = await editTool.execute(
        "e1",
        {
          file: "f.txt",
          edits: [
            {
              anchor_from: anchorFor(rows, "line2"),
              anchor_to: anchorFor(rows, "line2"),
              text: "LINE2",
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(followUp.isError).toBeFalsy();
    });
  });

  it("serves exactly the pipeline slice and leases only those lines", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(30), "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-slice" } };

      const result = await bashResult(handler!, "cat f.txt | head -n 20 | tail -5", ctx);
      expect(result).toBeDefined();
      const rows = rowsOf(result!.content[0]!.text);
      expect(rows).toHaveLength(5);
      for (const n of [16, 17, 18, 19, 20]) {
        expect(rows.some((line) => line.endsWith(`│line${n}`))).toBe(true);
      }
      expect(rows.some((line) => line.endsWith("│line15"))).toBe(false);
      expect(rows.some((line) => line.endsWith("│line21"))).toBe(false);

      // WHY: least privilege before the first edit: line5 was never served, so its
      // WHY: anchor — though valid content — carries no lease and fails closed.
      // WHY: (After any successful edit the commit re-serves the whole file, so
      // WHY: this scoping holds until the session's first successful mutation.)
      const allHashes = await lineHashes(numberedLines(30), join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[4]!, anchor_to: allHashes[4]!, text: "LINE5" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");

      const ok = await editTool.execute(
        "e1",
        {
          file: "f.txt",
          edits: [
            {
              anchor_from: anchorFor(rows, "line18"),
              anchor_to: anchorFor(rows, "line18"),
              text: "LINE18",
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(ok.isError).toBeFalsy();
    });
  });

  it("resolves cd-prefixed chains against the last literal cd", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "sub", "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-cd" } };

      const result = await bashResult(handler!, "cd sub && cat f.txt", ctx);
      expect(result).toBeDefined();
      expect(rowsOf(result!.content[0]!.text)).toHaveLength(5);
    });
  });

  it("passes through non-views, errors, truncation, and missing files", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-pass" } };

      for (const command of [
        "cat -A f.txt",
        "cd -",
        "grep -n line f.txt",
        "sed -i 's/a/b/' f.txt",
        "cat f.txt f.txt",
        "echo hi && cat f.txt",
        "cat f.txt; cat f.txt",
        "cat *.txt",
        "cat f.txt > g.txt",
        "cat nope.txt",
        "cat",
      ]) {
        expect(await bashResult(handler!, command, ctx)).toBeUndefined();
      }
      expect(
        await handler!(
          {
            toolName: "bash",
            isError: true,
            input: { command: "cat f.txt" },
            content: [{ type: "text", text: "boom" }],
          },
          ctx,
        ),
      ).toBeUndefined();
      expect(
        await bashResult(handler!, "cat f.txt", ctx, {
          details: { truncation: { truncated: true } },
        }),
      ).toBeUndefined();
    });
  });

  it("isolates bash-granted leases per session", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctxA = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-A" } };
      const ctxB = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-B" } };

      const result = await bashResult(handler!, "cat f.txt", ctxA);
      const anchor = anchorFor(rowsOf(result!.content[0]!.text), "line3");
      await expect(
        editTool.execute(
          "e1",
          { file: "f.txt", edits: [{ anchor_from: anchor, anchor_to: anchor, text: "LINE3" }] },
          undefined,
          undefined,
          ctxB,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });
});
