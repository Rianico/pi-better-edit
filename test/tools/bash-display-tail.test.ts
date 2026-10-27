import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { useTestHome, withTempDir } from "../support/fixtures";

useTestHome();

function makeFakePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools = new Map<string, unknown>();
  const handlersAll = new Map<string, Array<(...args: unknown[]) => unknown>>();
  return {
    pi: {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
        const registered = handlersAll.get(event) ?? [];
        registered.push(handler);
        handlersAll.set(event, registered);
      },
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    } as any,
    handlers,
    handlersAll,
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

function hasCommand(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function displayed(program: string, args: string[], raw: string): string {
  return execFileSync(program, args, { input: raw, encoding: "utf8" });
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

describe("bash display-tail serve seam (ADR-0048 D2)", () => {
  it("serves raw rows and a disclosure for cat -vet", async () => {
    await withTempDir("bash-display-", async (dir) => {
      const raw = numberedLines(30);
      await writeFile(join(dir, "f.txt"), raw, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-display-vet" } };
      const stdout = displayed("cat", ["-vet"], raw);

      const result = await bashResult(handler!, "cat f.txt | cat -vet", ctx, stdout);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text.startsWith("[Bash view: f.txt (30 lines total)]")).toBe(true);
      expect(text).toContain("[cat -vet rendering dropped; raw rows served]");
      expect(text).not.toContain("$");
      const rows = rowsOf(text);
      expect(rows).toHaveLength(30);
      expect(rows[0]!.endsWith("│line1")).toBe(true);

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

  it("serves the verified slice for a staged view plus cat -vet", async () => {
    await withTempDir("bash-display-slice-", async (dir) => {
      const raw = numberedLines(30);
      const slice = Array.from({ length: 5 }, (_, i) => `line${i + 16}`).join("\n") + "\n";
      await writeFile(join(dir, "f.txt"), raw, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-display-slice" } };
      const stdout = displayed("cat", ["-vet"], slice);

      const result = await bashResult(
        handler!,
        "cat f.txt | head -20 | tail -5 | cat -vet",
        ctx,
        stdout,
      );
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text.startsWith("[Bash view: f.txt (lines 16-20 of 30 total)]")).toBe(true);
      expect(text).toContain("[cat -vet rendering dropped; raw rows served]");
      const rows = rowsOf(text);
      expect(rows).toHaveLength(5);
      expect(rows.map((row) => row.split("│")[1])).toEqual([
        "line16",
        "line17",
        "line18",
        "line19",
        "line20",
      ]);

      const followUp = await editTool.execute(
        "e2",
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
      expect(followUp.isError).toBeFalsy();
    });
  });

  it.skipIf(process.platform === "darwin")("serves raw rows for cat -A", async () => {
    await withTempDir("bash-display-a-", async (dir) => {
      const raw = numberedLines(3);
      await writeFile(join(dir, "f.txt"), raw, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-display-a" } };
      const stdout = displayed("cat", ["-A"], raw);

      const result = await bashResult(handler!, "cat f.txt | cat -A", ctx, stdout);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text).toContain("[cat -A rendering dropped; raw rows served]");
      expect(rowsOf(text)).toHaveLength(3);
      expect(text).not.toContain("$");
    });
  });

  it.skipIf(!hasCommand("od"))("serves raw rows for od -c", async () => {
    await withTempDir("bash-display-od-", async (dir) => {
      const raw = numberedLines(4);
      await writeFile(join(dir, "f.txt"), raw, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-display-od" } };
      const stdout = displayed("od", ["-c"], raw);

      const result = await bashResult(handler!, "cat f.txt | od -c", ctx, stdout);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text).toContain("[od -c rendering dropped; raw rows served]");
      expect(rowsOf(text)).toHaveLength(4);
    });
  });

  it.skipIf(!hasCommand("xxd"))("serves raw rows for xxd", async () => {
    await withTempDir("bash-display-xxd-", async (dir) => {
      const raw = numberedLines(4);
      await writeFile(join(dir, "f.txt"), raw, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-display-xxd" } };
      const stdout = displayed("xxd", [], raw);

      const result = await bashResult(handler!, "cat f.txt | xxd", ctx, stdout);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text).toContain("[xxd rendering dropped; raw rows served]");
      expect(rowsOf(text)).toHaveLength(4);
    });
  });

  it.skipIf(!hasCommand("hexdump"))("serves raw rows for hexdump -C", async () => {
    await withTempDir("bash-display-hexdump-", async (dir) => {
      const raw = numberedLines(4);
      await writeFile(join(dir, "f.txt"), raw, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-display-hexdump" } };
      const stdout = displayed("hexdump", ["-C"], raw);

      const result = await bashResult(handler!, "cat f.txt | hexdump -C", ctx, stdout);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text).toContain("[hexdump -C rendering dropped; raw rows served]");
      expect(rowsOf(text)).toHaveLength(4);
    });
  });

  it("passes through raw when the observed transform does not match the re-read slice", async () => {
    await withTempDir("bash-display-mismatch-", async (dir) => {
      const raw = numberedLines(4);
      await writeFile(join(dir, "f.txt"), raw, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-display-mismatch" } };
      const wrong = displayed("cat", ["-vet"], "different\n");

      const result = await bashResult(handler!, "cat f.txt | cat -vet", ctx, wrong);
      expect(result).toBeUndefined();
    });
  });

  it("serves raw rows for a CRLF file and a BOM file", async () => {
    await withTempDir("bash-display-crlf-", async (dir) => {
      const raw = "line1\r\nline2\r\n";
      await writeFile(join(dir, "f.txt"), raw, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-display-crlf" } };
      const stdout = displayed("cat", ["-vet"], raw);

      const result = await bashResult(handler!, "cat f.txt | cat -vet", ctx, stdout);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text).toContain("[cat -vet rendering dropped; raw rows served]");
      expect(text).not.toContain("^M");
      expect(rowsOf(text).map((row) => row.split("│")[1])).toEqual(["line1", "line2"]);
    });

    await withTempDir("bash-display-bom-", async (dir) => {
      const raw = "\uFEFFline1\nline2\n";
      await writeFile(join(dir, "f.txt"), raw, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-display-bom" } };
      const stdout = displayed("cat", ["-vet"], raw);

      const result = await bashResult(handler!, "cat f.txt | cat -vet", ctx, stdout);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text).toContain("[cat -vet rendering dropped; raw rows served]");
      expect(rowsOf(text).map((row) => row.split("│")[1])).toEqual(["line1", "line2"]);
    });
  });
});
