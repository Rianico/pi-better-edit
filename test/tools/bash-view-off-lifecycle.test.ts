/**
 * Bash view off-switch and first-interception warning lifecycle. Mirrors
 * `test/tools/bash-view-lifecycle.test.ts`: the same fake-pi harness and the same
 * `cat`/`grep -n` shapes, asserting the config seam drives the hook — `off`
 * passes both branches through byte-identical, and a successful interception warns
 * once per session (reset by `session_start`).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import register from "../../index";
import { BASH_VIEW_ENV_VAR } from "../../src/bash-view-config.js";
import { configDir } from "../../src/config-dir.js";
import { CONFIG_FILE_NAME } from "../../src/json-config.js";
import { clearDiagnostics, readDiagnostics, useTestHome, withTempDir } from "../support/fixtures";

useTestHome();

/**
 * WHY this reset exists: the global settings file now lives in `configDir()`, which the harness
 * allocates once per FILE — so a `bash-view off global` written by one test would otherwise steer
 * the next one. Before the move it lived under the per-test HOME, which `withTempDir` removed.
 */
beforeEach(async () => {
  await rm(join(configDir(), CONFIG_FILE_NAME), { force: true });
});

function makeFakePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const handlersAll = new Map<string, Array<(...args: unknown[]) => unknown>>();
  return {
    pi: {
      registerTool(): void {},
      registerCommand(): void {},
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
  };
}

function numberedLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n") + "\n";
}

function makeCtx(
  cwd: string,
  sessionId: string,
  notices: Array<{ message: string; level: string }>,
) {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (message: string, level: string): void => {
        notices.push({ message, level });
      },
    },
  };
}

async function bashResult(
  handler: (...args: unknown[]) => unknown,
  command: string,
  ctx: unknown,
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

async function fireSessionStart(
  handlersAll: Map<string, Array<(...args: unknown[]) => unknown>>,
  ctx: unknown,
): Promise<void> {
  for (const handler of handlersAll.get("session_start") ?? []) {
    await handler(undefined, ctx);
  }
}

afterEach(() => {
  delete process.env[BASH_VIEW_ENV_VAR];
  vi.restoreAllMocks();
});

describe("bash view off-switch lifecycle", () => {
  it("passes the view branch through untouched when bash.view is off", async () => {
    await withTempDir("bash-view-off-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(30), "utf-8");
      await mkdir(join(dir, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(dir, ".pi", "agents", "pi-better-edit.json"),
        JSON.stringify({ bash: { view: "off" } }),
        "utf-8",
      );
      const { pi, handlers } = makeFakePi();
      register(pi);
      const notices: Array<{ message: string; level: string }> = [];
      const ctx = makeCtx(dir, "off-view", notices);

      const result = await bashResult(
        handlers.get("tool_result")!,
        "cat f.txt",
        ctx,
        numberedLines(30),
      );

      expect(result).toBeUndefined();
      expect(notices).toEqual([]);
    });
  });

  it("bypasses the search branch too when off, and intercepts again when on", async () => {
    await withTempDir("bash-view-off-search-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(30), "utf-8");
      await mkdir(join(dir, ".pi", "agents"), { recursive: true });
      const configPath = join(dir, ".pi", "agents", "pi-better-edit.json");
      await writeFile(configPath, JSON.stringify({ bash: { view: "off" } }), "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const notices: Array<{ message: string; level: string }> = [];
      const ctx = makeCtx(dir, "off-search", notices);

      const off = await bashResult(
        handlers.get("tool_result")!,
        "grep -n 'line3' f.txt",
        ctx,
        "3:line3",
      );
      expect(off).toBeUndefined();

      await writeFile(configPath, JSON.stringify({ bash: { view: "on" } }), "utf-8");
      const on = await bashResult(
        handlers.get("tool_result")!,
        "grep -n 'line3' f.txt",
        ctx,
        "3:line3",
      );
      expect(on?.content[0]?.text.startsWith("--- Bash search (hashline anchors) ---\n")).toBe(
        true,
      );
    });
  });

  it("warns once per session on successful interception, naming the off-ramp", async () => {
    await withTempDir("bash-view-warn-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(30), "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const notices: Array<{ message: string; level: string }> = [];
      const ctx = makeCtx(dir, "warn-once", notices);

      const first = await bashResult(
        handlers.get("tool_result")!,
        "cat f.txt",
        ctx,
        numberedLines(30),
      );
      expect(first?.content[0]?.text.startsWith("--- Bash view (hashline anchors) ---\n")).toBe(
        true,
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.level).toBe("warning");
      expect(notices[0]?.message).toContain("/pi-better-edit bash-view off");

      const second = await bashResult(
        handlers.get("tool_result")!,
        "cat f.txt",
        ctx,
        numberedLines(30),
      );
      expect(second?.content[0]?.text.startsWith("--- Bash view (hashline anchors) ---\n")).toBe(
        true,
      );
      expect(notices).toHaveLength(1);
    });
  });

  it("shares the once-per-session notice across the view and search branches", async () => {
    await withTempDir("bash-view-warn-shared-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(30), "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const notices: Array<{ message: string; level: string }> = [];
      const ctx = makeCtx(dir, "warn-shared", notices);

      await bashResult(handlers.get("tool_result")!, "cat f.txt", ctx, numberedLines(30));
      expect(notices).toHaveLength(1);

      const search = await bashResult(
        handlers.get("tool_result")!,
        "grep -n 'line3' f.txt",
        ctx,
        "3:line3",
      );
      expect(search?.content[0]?.text.startsWith("--- Bash search (hashline anchors) ---\n")).toBe(
        true,
      );
      expect(notices).toHaveLength(1);
    });
  });

  it("warns again after session start resets the notice", async () => {
    await withTempDir("bash-view-warn-reset-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(30), "utf-8");
      const { pi, handlers, handlersAll } = makeFakePi();
      register(pi);
      const notices: Array<{ message: string; level: string }> = [];
      const ctx = makeCtx(dir, "warn-reset", notices);

      await bashResult(handlers.get("tool_result")!, "cat f.txt", ctx, numberedLines(30));
      expect(notices).toHaveLength(1);

      await fireSessionStart(handlersAll, ctx);

      await bashResult(handlers.get("tool_result")!, "cat f.txt", ctx, numberedLines(30));
      expect(notices).toHaveLength(2);
    });
  });

  it("records the notice when the context carries no ui surface", async () => {
    await withTempDir("bash-view-warn-headless-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(30), "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      clearDiagnostics();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "warn-headless" } };

      const result = await bashResult(
        handlers.get("tool_result")!,
        "cat f.txt",
        ctx,
        numberedLines(30),
      );

      expect(result?.content[0]?.text.startsWith("--- Bash view (hashline anchors) ---\n")).toBe(
        true,
      );
      // WHY the file and not the console: with no `ui` surface there is no in-TUI notice, but
      // WHY the terminal belongs to Pi's renderer, so the notice is recorded instead of printed.
      expect(
        readDiagnostics()
          .map((record) => record.message)
          .join("\n"),
      ).toContain("/pi-better-edit bash-view off");
    });
  });
});
