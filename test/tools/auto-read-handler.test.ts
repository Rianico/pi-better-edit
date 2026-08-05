import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { withTempDir } from "../support/fixtures";
import { AUTO_READ_MAX } from "../../src/constants";

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

  it("returns nothing when auto-read is disabled via config", async () => {
    await withTempDir("auto-read-disabled-", async (dir) => {
      const configDir = join(dir, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "config.json"), JSON.stringify({ autoRead: false }), "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);

      const sessionHandler = handlers.get("session_start");
      expect(sessionHandler).toBeDefined();
      await sessionHandler!({}, { getActiveTools: () => [], setActiveTools: () => {}, ui: { notify() {} } });

      const handler = handlers.get("tool_result");
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          toolName: "write",
          isError: false,
          input: { path: "test.txt" },
          content: [],
        },
        { cwd: dir },
      );

      expect(result).toBeUndefined();
    });
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

  it("returns the empty-file anchor when the written file is empty", async () => {
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
          content: [{ type: "text", text: "File written." }],
        },
        { cwd: dir },
      );

      expect(result).toBeDefined();
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content[1].text).toContain("--- Auto-read (hashline anchors) ---");
      expect(content[1].text).toContain("[File is empty. Use replace to insert content.]");
      expect(content[1].text).toMatch(/^[A-Za-z0-9]{3}│/m);
    });
  });

  it("returns nothing for a noop replace (anchors are unchanged)", async () => {
    await withTempDir("auto-read-noop-", async (dir) => {
      const filePath = join(dir, "noop.txt");
      await writeFile(filePath, "hello\nworld\n", "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);

      const handler = handlers.get("tool_result");
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "noop.txt" },
          details: { metrics: { classification: "noop" } },
          content: [{ type: "text", text: "No changes made to noop.txt" }],
        },
        { cwd: dir },
      );

      expect(result).toBeUndefined();
    });
  });

  it("returns an auto-read failure notice when the file cannot be read", async () => {
    const { pi, handlers } = makeFakePi();
    register(pi);

    const handler = handlers.get("tool_result");
    expect(handler).toBeDefined();

    const result = await handler!(
      {
        toolName: "write",
        isError: false,
        input: { path: "nonexistent.txt" },
        content: [{ type: "text", text: "File written." }],
      },
      { cwd: "/tmp" },
    );

    expect(result).toBeDefined();
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "File written." });
    expect(content[1].text).toContain("--- Auto-read failed:");
    expect(content[1].text).toContain("[E_NOT_FOUND]");
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

  it("windows undo_last_replace auto-read to the changed span plus 2 lines of context", async () => {
    await withTempDir("auto-read-window-undo-", async (dir) => {
      const filePath = join(dir, "undo-window.txt");
      await writeFile(filePath, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n", "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);

      const handler = handlers.get("tool_result");
      const result = await handler!(
        {
          toolName: "undo_last_replace",
          isError: false,
          input: { path: "undo-window.txt" },
          details: { metrics: { changed_lines: { first: 5, last: 5 } } },
          content: [{ type: "text", text: "Undone." }],
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
    });
  });

  it("does not auto-display lines over 50KB even though read allows 200KB lines", async () => {
    await withTempDir("auto-read-big-line-", async (dir) => {
      const filePath = join(dir, "big.txt");
      const big = "Q".repeat(60_000);
      await writeFile(filePath, `${big}\nsmall\n`, "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);

      const handler = handlers.get("tool_result");
      const result = await handler!(
        {
          toolName: "write",
          isError: false,
          input: { path: "big.txt" },
          content: [{ type: "text", text: "File written." }],
        },
        { cwd: dir },
      );

      const text = (result as { content: Array<{ type: string; text: string }> }).content[1].text;
      expect(text).toContain("│small");
      expect(text).not.toContain("│Q");
      expect(text).toContain("exceeds 50.0KB");
      expect(text).toContain("sed -n '1p'");
    });
  });

  it("caps the replace auto-read window at AUTO_READ_MAX lines", async () => {
    await withTempDir("auto-read-window-cap-", async (dir) => {
      const filePath = join(dir, "cap.txt");
      await writeFile(filePath, Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n", "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");

      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "cap.txt" },
          details: { metrics: { changed_lines: { first: 1, last: 2500 } } },
          content: [{ type: "text", text: "Replaced." }],
        },
        { cwd: dir },
      );

      const text = (result as { content: Array<{ type: string; text: string }> }).content[1].text;
      expect(text).toContain(`[Showing lines 1-${AUTO_READ_MAX} of 2500.`);
      expect(text).toContain(`│line ${AUTO_READ_MAX}`);
      expect(text).not.toContain("│line 2500");
    });
  });
});

describe("replace diff in model-visible text", () => {
  it("shows the post-edit diff instead of the summary when auto-read is on", async () => {
    await withTempDir("auto-read-diff-", async (dir) => {
      await writeFile(join(dir, "diff.txt"), "aaa\nbbb\nccc\n", "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const diff = " aaa\n-   │bbb\n+XYZ│BBB\n ccc";

      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "diff.txt" },
          details: {
            diff,
            metrics: { classification: "applied", changed_lines: { first: 2, last: 2 } },
          },
          content: [{ type: "text", text: "Successfully replaced in diff.txt. Added 1 line(s), removed 1 line(s)." }],
        },
        { cwd: dir },
      );

      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content).toHaveLength(2);
      expect(content[0].text).toBe(diff);
      expect(content[0].text).not.toContain("Successfully replaced");
      expect(content[1].text).toContain("--- Auto-read (hashline anchors) ---");
      expect(content[1].text).toContain("│bbb");
    });
  });

  it("keeps the warnings block alongside the diff", async () => {
    await withTempDir("auto-read-diff-warn-", async (dir) => {
      await writeFile(join(dir, "warn.txt"), "aaa\nbbb\nccc\n", "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const diff = " aaa\n-   │bbb\n+XYZ│BBB\n ccc";
      const summary = "Successfully replaced in warn.txt. Added 1 line(s), removed 1 line(s).\n\nWarnings:\n[E_BARE_HASH_PREFIX] Autocorrected: stripped \"HASH│\" prefix copied from read output in content_lines[0].";

      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "warn.txt" },
          details: { diff, metrics: { classification: "applied" } },
          content: [{ type: "text", text: summary }],
        },
        { cwd: dir },
      );

      const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(text).toContain(diff);
      expect(text).toContain("Warnings:");
      expect(text).toContain("[E_BARE_HASH_PREFIX]");
      expect(text).not.toContain("Successfully replaced");
    });
  });

  it("keeps the summary when the result carries no diff", async () => {
    await withTempDir("auto-read-diff-none-", async (dir) => {
      await writeFile(join(dir, "nodiff.txt"), "aaa\nbbb\nccc\n", "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");

      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "nodiff.txt" },
          details: { metrics: { classification: "applied" } },
          content: [{ type: "text", text: "Successfully replaced in nodiff.txt." }],
        },
        { cwd: dir },
      );

      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content).toHaveLength(2);
      expect(content[0].text).toBe("Successfully replaced in nodiff.txt.");
    });
  });

  it("leaves undo result text unchanged", async () => {
    await withTempDir("auto-read-diff-undo-", async (dir) => {
      await writeFile(join(dir, "undo.txt"), "aaa\nbbb\nccc\n", "utf-8");

      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");

      const result = await handler!(
        {
          toolName: "undo_last_replace",
          isError: false,
          input: { path: "undo.txt" },
          details: {
            diff: " aaa\n-   │bbb\n+XYZ│BBB\n ccc",
            metrics: { classification: "applied" },
          },
          content: [{ type: "text", text: "Undone last replace on undo.txt." }],
        },
        { cwd: dir },
      );

      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content).toHaveLength(2);
      expect(content[0].text).toBe("Undone last replace on undo.txt.");
    });
  });
});
