import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { getWritableTempRoot } from "../support/fixtures";

async function makeTempDir(prefix: string): Promise<string> {
	// mkdtemp (not mkdir) so every call gets a fresh, unique dir even if a prior
	// run left a stale same-named dir behind; the body just needs a writable cwd.
	return mkdtemp(join(await getWritableTempRoot(), prefix));
}

type ToolResultHandler = (
  event: {
    toolName: string;
    toolCallId: string;
    input: unknown;
    content: Array<{ type: string; text?: string }>;
    details: unknown;
    isError: boolean;
  },
  ctx: {
    cwd: string;
    signal?: AbortSignal;
  },
) => Promise<
  | {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
      isError?: boolean;
    }
  | undefined
  | void
>;

function createTestPi(options?: { enableAutoRead?: boolean }) {
  let toolResultHandler: ToolResultHandler | undefined;
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: unknown) {
      if (event === "tool_result") {
        toolResultHandler = handler as ToolResultHandler;
      }
    },
  } as any;

  const prevValue = process.env.PI_HASHLINE_AUTO_READ;
  if (options?.enableAutoRead) {
    process.env.PI_HASHLINE_AUTO_READ = "1";
  }

  register(pi);

  if (options?.enableAutoRead) {
    if (prevValue === undefined) {
      delete process.env.PI_HASHLINE_AUTO_READ;
    } else {
      process.env.PI_HASHLINE_AUTO_READ = prevValue;
    }
  }

  return {
    pi,
    getToolResultHandler: () => toolResultHandler,
  };
}

describe("auto-read after write", () => {
  const savedEnv = process.env.PI_HASHLINE_AUTO_READ;

  afterEach(() => {

    if (savedEnv === undefined) {
      delete process.env.PI_HASHLINE_AUTO_READ;
    } else {
      process.env.PI_HASHLINE_AUTO_READ = savedEnv;
    }
  });

  it("handler returns undefined by default (disabled)", async () => {
    const cwd = await makeTempDir("auto-read-test-disabled-");
    await writeFile(join(cwd, "test.txt"), "hello\nworld\n", "utf-8");
    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();

      expect(handler).toBeDefined();

      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "test.txt", content: "hello\nworld\n" },
          content: [{ type: "text", text: "Successfully wrote 12 bytes" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("registers handler when PI_HASHLINE_AUTO_READ=1", async () => {
    const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
    const handler = getToolResultHandler();
    expect(handler).toBeDefined();
  });

  it("appends hashline read output after successful write when enabled", async () => {
    const cwd = await makeTempDir("auto-read-test-");
    await writeFile(join(cwd, "test.txt"), "hello\nworld\n", "utf-8");
    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();
      expect(handler).toBeDefined();

      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "test.txt", content: "hello\nworld\n" },
          content: [{ type: "text", text: "Successfully wrote 12 bytes to test.txt" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeDefined();
      expect(writeResult!.content).toHaveLength(2);

      expect(writeResult!.content![0]).toEqual({
        type: "text",
        text: "Successfully wrote 12 bytes to test.txt",
      });

      const autoReadText = writeResult!.content![1]!.text!;
      expect(autoReadText).toContain("--- Auto-read (hashline anchors) ---");
      expect(autoReadText).toMatch(/[A-Za-z0-9_-]{3}│hello/);
      expect(autoReadText).toMatch(/[A-Za-z0-9_-]{3}│world/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not trigger auto-read when write fails", async () => {
    const cwd = await makeTempDir("auto-read-test-fail-");

    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();

      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "test.txt", content: "hello" },
          content: [{ type: "text", text: "Error: Permission denied" }],
          details: undefined,
          isError: true,
        },
        { cwd },
      );

      expect(writeResult).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not trigger for non-write tools", async () => {
    const cwd = await makeTempDir("auto-read-test-nonwrite-");

    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();

      const readResult = await handler!(
        {
          toolName: "read",
          toolCallId: "read-1",
          input: { path: "test.txt" },
          content: [{ type: "text", text: "abc1│hello" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(readResult).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("handles missing path in write input gracefully", async () => {
    const cwd = await makeTempDir("auto-read-test-nopath-");

    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();

      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { content: "hello" },
          content: [{ type: "text", text: "Successfully wrote 5 bytes" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns original write result when auto-read fails", async () => {
    const cwd = await makeTempDir("auto-read-test-autoreadfail-");

    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();

      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "nonexistent/deeply/nested/file.txt", content: "hello" },
          content: [{ type: "text", text: "Successfully wrote 5 bytes to nonexistent/deeply/nested/file.txt" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("includes hashline anchors in correct format", async () => {
    const cwd = await makeTempDir("auto-read-test-format-");

    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();

      const content = "function hello() {\n  return 'world';\n}\n";
      await writeFile(join(cwd, "code.ts"), content, "utf-8");
      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "code.ts", content },
          content: [{ type: "text", text: "Successfully wrote 38 bytes to code.ts" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeDefined();
      const autoReadText = writeResult!.content![1]!.text!;

      const lines = autoReadText.split("\n");
      const hashlinePattern = /^[A-Za-z0-9_-]{3}│/;

      const headerIndex = lines.findIndex((l) =>
        l.includes("--- Auto-read (hashline anchors) ---"),
      );
      expect(headerIndex).toBeGreaterThanOrEqual(0);

      const contentLines = lines.slice(headerIndex + 1).filter((l) => l.length > 0);
      for (const line of contentLines) {
        expect(line).toMatch(hashlinePattern);
      }

      expect(autoReadText).toContain("function hello()");
      expect(autoReadText).toContain("return 'world'");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("handles large files with truncation", async () => {
    const cwd = await makeTempDir("auto-read-test-large-");

    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();

      const largeContent = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
      await writeFile(join(cwd, "large.txt"), largeContent, "utf-8");
      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "large.txt", content: largeContent },
          content: [{ type: "text", text: "Successfully wrote 1890 bytes to large.txt" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeDefined();
      const autoReadText = writeResult!.content![1]!.text!;

      expect(autoReadText).toContain("--- Auto-read (hashline anchors) ---");

      expect(autoReadText).toContain("line 1");

      expect(autoReadText).toMatch(/offset=\d+/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
