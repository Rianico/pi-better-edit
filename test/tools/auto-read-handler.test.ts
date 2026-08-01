import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { withTempDir } from "../support/fixtures";

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
      return tools.get(name);
    },
  };
}

describe("auto-read handler", () => {
  const originalAutoRead = process.env.PI_HASHLINE_AUTO_READ;

  beforeEach(() => {
    process.env.PI_HASHLINE_AUTO_READ = "1";
  });

  afterEach(() => {
    if (originalAutoRead === undefined) {
      delete process.env.PI_HASHLINE_AUTO_READ;
    } else {
      process.env.PI_HASHLINE_AUTO_READ = originalAutoRead;
    }
  });

  it("appends auto-read content after a successful write", async () => {
    await withTempDir("auto-read-", async (dir) => {
      const filePath = join(dir, "test.txt");
      await writeFile(filePath, "hello\nworld\n", "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);

      const handler = handlers.get("tool_result");
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          toolName: "write",
          isError: false,
          input: { path: "test.txt" },
          content: [{ type: "text", text: "File written." }],
        },
        { cwd: dir },
      );

      expect(result).toBeDefined();
      expect(result).toHaveProperty("content");
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: "text", text: "File written." });
      expect(content[1].type).toBe("text");
      expect(content[1].text).toContain("--- Auto-read (hashline anchors) ---");
      expect(content[1].text).toContain("│hello");
      expect(content[1].text).toContain("│world");
    });
  });

  it("returns nothing when auto-read is disabled", async () => {
    delete process.env.PI_HASHLINE_AUTO_READ;

    const { pi, handlers } = makeFakePi();
    register(pi);

    const handler = handlers.get("tool_result");
    expect(handler).toBeDefined();

    const result = await handler!(
      {
        toolName: "write",
        isError: false,
        input: { path: "test.txt" },
        content: [],
      },
      { cwd: "/tmp" },
    );

    expect(result).toBeUndefined();
  });

  it("returns nothing for non-write tool results", async () => {
    const { pi, handlers } = makeFakePi();
    register(pi);

    const handler = handlers.get("tool_result");
    expect(handler).toBeDefined();

    const result = await handler!(
      {
        toolName: "read",
        isError: false,
        input: { path: "test.txt" },
        content: [],
      },
      { cwd: "/tmp" },
    );

    expect(result).toBeUndefined();
  });

  it("returns nothing when the write tool reported an error", async () => {
    const { pi, handlers } = makeFakePi();
    register(pi);

    const handler = handlers.get("tool_result");
    expect(handler).toBeDefined();

    const result = await handler!(
      {
        toolName: "write",
        isError: true,
        input: { path: "test.txt" },
        content: [],
      },
      { cwd: "/tmp" },
    );

    expect(result).toBeUndefined();
  });

  it("returns nothing when the input has no path", async () => {
    const { pi, handlers } = makeFakePi();
    register(pi);

    const handler = handlers.get("tool_result");
    expect(handler).toBeDefined();

    const result = await handler!(
      {
        toolName: "write",
        isError: false,
        input: {},
        content: [],
      },
      { cwd: "/tmp" },
    );

    expect(result).toBeUndefined();
  });

  it("returns nothing when the written file is empty", async () => {
    await withTempDir("auto-read-", async (dir) => {
      const filePath = join(dir, "empty.txt");
      await writeFile(filePath, "", "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);

      const handler = handlers.get("tool_result");
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          toolName: "write",
          isError: false,
          input: { path: "empty.txt" },
          content: [],
        },
        { cwd: dir },
      );

      expect(result).toBeUndefined();
    });
  });

  it("handles file read errors gracefully (no throw)", async () => {
    const { pi, handlers } = makeFakePi();
    register(pi);

    const handler = handlers.get("tool_result");
    expect(handler).toBeDefined();

    const result = await handler!(
      {
        toolName: "write",
        isError: false,
        input: { path: "nonexistent.txt" },
        content: [],
      },
      { cwd: "/tmp" },
    );

    expect(result).toBeUndefined();
  });

  it("enables auto-read via env var when session starts with no config file", async () => {
    await withTempDir("auto-read-session-", async (dir) => {
      const filePath = join(dir, "session.txt");
      await writeFile(filePath, "hello\nworld\n", "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);

      const sessionStart = handlers.get("session_start");
      expect(sessionStart).toBeDefined();
      await sessionStart!({}, { cwd: dir, ui: { notify() {} } });

      const handler = handlers.get("tool_result");
      const result = await handler!(
        {
          toolName: "write",
          isError: false,
          input: { path: "session.txt" },
          content: [{ type: "text", text: "File written." }],
        },
        { cwd: dir },
      );

      expect(result).toBeDefined();
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content).toHaveLength(2);
      expect(content[1].text).toContain("--- Auto-read (hashline anchors) ---");
      expect(content[1].text).toContain("│hello");
    });
  });

  it("windows replace auto-read to the changed span plus 2 lines of context", async () => {
    await withTempDir("auto-read-window-", async (dir) => {
      const filePath = join(dir, "window.txt");
      await writeFile(filePath, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n", "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);

      const handler = handlers.get("tool_result");
      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "window.txt" },
          details: { metrics: { changed_lines: { first: 5, last: 5 } } },
          content: [{ type: "text", text: "Replaced." }],
        },
        { cwd: dir },
      );

      expect(result).toBeDefined();
      const text = (result as { content: Array<{ type: string; text: string }> }).content[1].text;
      expect(text).toContain("│line 3");
      expect(text).toContain("│line 5");
      expect(text).toContain("│line 7");
      expect(text).not.toContain("│line 1");
      expect(text).not.toContain("│line 10");
      expect(text).toContain("[Showing lines 3-7 of 10.");
    });
  });

  it("clamps the replace auto-read window to the file start and end", async () => {
    await withTempDir("auto-read-window-clamp-", async (dir) => {
      const filePath = join(dir, "clamp.txt");
      await writeFile(filePath, Array.from({ length: 4 }, (_, i) => `row ${i + 1}`).join("\n") + "\n", "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);

      const handler = handlers.get("tool_result");
      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "clamp.txt" },
          details: { metrics: { changed_lines: { first: 1, last: 4 } } },
          content: [{ type: "text", text: "Replaced." }],
        },
        { cwd: dir },
      );

      expect(result).toBeDefined();
      const text = (result as { content: Array<{ type: string; text: string }> }).content[1].text;
      expect(text).toContain("│row 1");
      expect(text).toContain("│row 4");
    });
  });
});
