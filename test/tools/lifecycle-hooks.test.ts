import { describe, expect, it, vi } from "vitest";
import { createLifecycleHooks } from "../../src/lifecycle-hooks/index.js";

function ctx(overrides: Partial<{ cwd: string; sessionId: string }> = {}) {
  return {
    cwd: overrides.cwd ?? "/tmp",
    sessionManager: { getSessionId: () => overrides.sessionId ?? "test-session" },
    ui: { notify: vi.fn() },
  };
}

describe("lifecycle-hooks", () => {
  it("onSessionStart initializes hasher and prunes, notifies on debug", async () => {
    const initHasher = vi.fn(async () => ({} as never));
    const pruneMissingAll = vi.fn(async () => {});
    const hooks = createLifecycleHooks({ initHasher, pruneMissingAll });
    process.env.PI_HASHLINE_DEBUG = "1";
    const c = ctx();
    await hooks.onSessionStart({}, c);
    expect(initHasher).toHaveBeenCalledOnce();
    expect(pruneMissingAll).toHaveBeenCalledOnce();
    expect(c.ui.notify).toHaveBeenCalledWith("Hashline Edit mode active", "info");
    delete process.env.PI_HASHLINE_DEBUG;
  });

  it("onSessionStart swallows prune failure (best-effort)", async () => {
    const initHasher = vi.fn(async () => ({} as never));
    const pruneMissingAll = vi.fn(async () => {
      throw new Error("db boom");
    });
    const hooks = createLifecycleHooks({ initHasher, pruneMissingAll });
    await expect(hooks.onSessionStart({}, ctx())).resolves.toBeUndefined();
  });

  it("onWrite returns undefined for non-text file (no record)", async () => {
    const recordDiffServes = vi.fn(async () => {});
    const hooks = createLifecycleHooks({
      resolveTarget: async (p: string) => p,
      toCwd: (p: string) => p,
      valAccess: async () => {},
      loadFileKindAndText: async () => ({ kind: "binary", description: "bin" }),
      recordDiffServes,
      sessionKeyFor: () => "sk",
    });
    const result = await hooks.onWrite(
      { toolName: "write", isError: false, input: { path: "/tmp/x.bin" }, content: [] },
      ctx(),
    );
    expect(result).toBeUndefined();
    expect(recordDiffServes).not.toHaveBeenCalled();
  });

  it("onWrite auto-reads text file and records serves via single best-effort path", async () => {
    const recordDiffServes = vi.fn(async () => {});
    const hooks = createLifecycleHooks({
      resolveTarget: async (p: string) => p,
      toCwd: (p: string) => p,
      valAccess: async () => {},
      loadFileKindAndText: async () => ({ kind: "text", text: "hello\n" }),
      readNormFile: async () => ({
        normalized: "hello\n",
        fileHashes: ["AAA"],
        absolutePath: "/tmp/x.txt",
        bom: "",
        originalEnding: "\n",
        hadUtf8DecodeErrors: false,
      }),
      fmtReadPreview: async () => ({ text: "AAA│hello", served: [{ position: 0, hash: "AAA" }] }),
      recordDiffServes,
      sessionKeyFor: () => "sk",
      visLines: (s: string) => s.split("\n"),
      clearUndo: async () => {},
    });
    const result = await hooks.onWrite(
      { toolName: "write", isError: false, input: { path: "/tmp/x.txt" }, content: [{ type: "text", text: "ok" }] },
      ctx(),
    );
    expect(result?.content[1]?.text).toContain("Auto-read");
    expect(recordDiffServes).toHaveBeenCalledOnce();
  });

  it("onWrite swallows record failure (best-effort recovery owned once)", async () => {
    const recordDiffServes = vi.fn(async () => {
      throw new Error("record boom");
    });
    const hooks = createLifecycleHooks({
      resolveTarget: async (p: string) => p,
      toCwd: (p: string) => p,
      valAccess: async () => {},
      loadFileKindAndText: async () => ({ kind: "text", text: "hi" }),
      readNormFile: async () => ({
        normalized: "hi\n",
        fileHashes: ["BBB"],
        absolutePath: "/tmp/y.txt",
        bom: "",
        originalEnding: "\n",
        hadUtf8DecodeErrors: false,
      }),
      fmtReadPreview: async () => ({ text: "BBB│hi", served: [{ position: 0, hash: "BBB" }] }),
      recordDiffServes,
      sessionKeyFor: () => "sk",
      visLines: (s: string) => s.split("\n"),
      clearUndo: async () => {},
    });
    const result = await hooks.onWrite(
      { toolName: "write", isError: false, input: { path: "/tmp/y.txt" }, content: [] },
      ctx(),
    );
    expect(result?.content[0]?.text).toContain("Auto-read");
  });

  it("onToolResult dispatches write vs edit via same best-effort record path", async () => {
    const recordDiffServes = vi.fn(async () => {});
    const hooks = createLifecycleHooks({
      resolveTarget: async (p: string) => p,
      toCwd: (p: string) => p,
      valAccess: async () => {},
      loadFileKindAndText: async () => ({ kind: "text", text: "a" }),
      readNormFile: async () => ({
        normalized: "a\n",
        fileHashes: ["CCC"],
        absolutePath: "/tmp/a.txt",
        bom: "",
        originalEnding: "\n",
        hadUtf8DecodeErrors: false,
      }),
      fmtReadPreview: async () => ({ text: "CCC│a", served: [{ position: 0, hash: "CCC" }] }),
      recordDiffServes,
      sessionKeyFor: () => "sk",
      visLines: (s: string) => s.split("\n"),
      clearUndo: async () => {},
    });
    const w = await hooks.onToolResult(
      { toolName: "write", isError: false, input: { path: "/tmp/a.txt" }, content: [] },
      ctx(),
    );
    expect(w?.content[0]?.text).toContain("Auto-read");
    expect(recordDiffServes).toHaveBeenCalledTimes(1);
  });

  it("onEdit records via servedByPath and deduplicates empty serves", async () => {
    const recordDiffServes = vi.fn(async () => {});
    const hooks = createLifecycleHooks({
      resolveTarget: async (p: string) => p,
      toCwd: (p: string) => p,
      recordDiffServes,
      sessionKeyFor: () => "sk",
      finalizeToolResult: () => ({
        content: [{ type: "text", text: "diff" }],
        servedRows: [{ position: 0, hash: "HHH" }],
      }),
    });
    const result = await hooks.onEdit(
      {
        toolName: "edit",
        isError: false,
        input: { path: "/tmp/z.txt" },
        details: {
          diff: "diff",
          servedByPath: [
            { path: "/tmp/z.txt", servedRows: [], resultLineCount: 1 },
            { path: "/tmp/z.txt", servedRows: [{ position: 0, hash: "HHH" }], resultLineCount: 1 },
          ],
        },
      } as unknown as never,
      ctx(),
    );
    expect(result?.content[0]?.text).toBe("diff");
    expect(recordDiffServes).toHaveBeenCalledTimes(1);
  });

  it("onToolResult returns undefined for isError or unknown tool", async () => {
    const hooks = createLifecycleHooks();
    expect(await hooks.onToolResult({ toolName: "write", isError: true, input: { path: "/x" } }, ctx())).toBeUndefined();
    expect(await hooks.onToolResult({ toolName: "read", isError: false } as never, ctx())).toBeUndefined();
  });
});
