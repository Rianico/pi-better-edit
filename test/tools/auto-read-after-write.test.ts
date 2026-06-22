import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";

async function getWritableTempRoot(): Promise<string> {
  const fallback = join(process.cwd(), ".tmp");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

async function makeTempDir(parent: string, prefix: string): Promise<string> {
  return (await mkdir(join(parent, prefix), { recursive: true }))!;
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

  // Set env var before registering if auto-read should be enabled
  const prevValue = process.env.PI_HASHLINE_AUTO_READ;
  if (options?.enableAutoRead) {
    process.env.PI_HASHLINE_AUTO_READ = "1";
  }

  register(pi);

  // Restore previous env value
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
    // Restore env after each test
    if (savedEnv === undefined) {
      delete process.env.PI_HASHLINE_AUTO_READ;
    } else {
      process.env.PI_HASHLINE_AUTO_READ = savedEnv;
    }
  });

  it("handler returns undefined by default (disabled)", async () => {
    const tempRoot = await getWritableTempRoot();
    const cwd = await makeTempDir(tempRoot, "auto-read-test-disabled-");
    await writeFile(join(cwd, "test.txt"), "hello\nworld\n", "utf-8");
    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();
      // Handler is always registered now, but returns undefined when disabled
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

      // Should return undefined because auto-read is disabled
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
    const tempRoot = await getWritableTempRoot();
    const cwd = await makeTempDir(tempRoot, "auto-read-test-");
    await writeFile(join(cwd, "test.txt"), "hello\nworld\n", "utf-8");
    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();
      expect(handler).toBeDefined();

      // Simulate a successful write
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

      // Verify the result was modified
      expect(writeResult).toBeDefined();
      expect(writeResult!.content).toHaveLength(2);

      // First element is the original write result
      expect(writeResult!.content![0]).toEqual({
        type: "text",
        text: "Successfully wrote 12 bytes to test.txt",
      });

      // Second element contains the auto-read with hashline anchors
      const autoReadText = writeResult!.content![1]!.text!;
      expect(autoReadText).toContain("--- Auto-read (hashline anchors) ---");
      expect(autoReadText).toMatch(/[A-Za-z0-9_-]{3}│hello/);
      expect(autoReadText).toMatch(/[A-Za-z0-9_-]{3}│world/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not trigger auto-read when write fails", async () => {
    const tempRoot = await getWritableTempRoot();
    const cwd = await makeTempDir(tempRoot, "auto-read-test-fail-");

    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();

      // Simulate a failed write
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

      // Should return undefined (no modification)
      expect(writeResult).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not trigger for non-write tools", async () => {
    const tempRoot = await getWritableTempRoot();
    const cwd = await makeTempDir(tempRoot, "auto-read-test-nonwrite-");

    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();

      // Simulate a read tool result
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

      // Should return undefined (no modification)
      expect(readResult).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("handles missing path in write input gracefully", async () => {
    const tempRoot = await getWritableTempRoot();
    const cwd = await makeTempDir(tempRoot, "auto-read-test-nopath-");

    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();

      // Simulate write with missing path
      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { content: "hello" }, // no path field
          content: [{ type: "text", text: "Successfully wrote 5 bytes" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      // Should return undefined (no modification)
      expect(writeResult).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns original write result when auto-read fails", async () => {
    const tempRoot = await getWritableTempRoot();
    const cwd = await makeTempDir(tempRoot, "auto-read-test-autoreadfail-");

    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();

      // Simulate write to a path that doesn't exist yet (auto-read will fail)
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

      // Should return undefined (auto-read failed, no modification to original result)
      // The event system preserves the original result when handler returns undefined
      expect(writeResult).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("includes hashline anchors in correct format", async () => {
    const tempRoot = await getWritableTempRoot();
    const cwd = await makeTempDir(tempRoot, "auto-read-test-format-");

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

      // Verify hashline format: each line should be HASH│content
      const lines = autoReadText.split("\n");
      const hashlinePattern = /^[A-Za-z0-9_-]{3}│/;

      // Find lines after the header
      const headerIndex = lines.findIndex((l) =>
        l.includes("--- Auto-read (hashline anchors) ---"),
      );
      expect(headerIndex).toBeGreaterThanOrEqual(0);

      // Check that subsequent lines have hashline format
      const contentLines = lines.slice(headerIndex + 1).filter((l) => l.length > 0);
      for (const line of contentLines) {
        expect(line).toMatch(hashlinePattern);
      }

      // Verify actual content is present
      expect(autoReadText).toContain("function hello()");
      expect(autoReadText).toContain("return 'world'");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("handles large files with truncation", async () => {
    const tempRoot = await getWritableTempRoot();
    const cwd = await makeTempDir(tempRoot, "auto-read-test-large-");

    try {
      const { getToolResultHandler } = createTestPi({ enableAutoRead: true });
      const handler = getToolResultHandler();

      // Create a large content (2500 lines to exceed DEFAULT_MAX_LINES=2000)
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

      // Should contain the header
      expect(autoReadText).toContain("--- Auto-read (hashline anchors) ---");

      // Should contain some lines (truncated)
      expect(autoReadText).toContain("line 1");

      // Should contain pagination hint since file is large
      expect(autoReadText).toMatch(/offset=\d+/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
