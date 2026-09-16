import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findServedHashEcho, servedHashEchoDenial, registerWriteHook } from "../../src/write-hook";
import { initHasher, lineHashes, canon } from "../../src/hashline";
import { recordServed } from "../../src/served-session/index.js";
import { withTempDir } from "../support/fixtures";
import { resolveTarget } from "../../src/fs-write";
import { toCwd } from "../../src/paths";
import { splitLines } from "../../src/utils.js";

type ToolCallHandler = (
  event: { toolName: string; input: Record<string, unknown> },
  ctx: {
    cwd: string;
    sessionManager: { getSessionId(): string };
    signal?: AbortSignal;
  },
) => Promise<{ block?: boolean; reason?: string } | void>;

function localIO() {
  return {
    resolve: async (p: string, cwd: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("Operation aborted");
      return resolveTarget(toCwd(p, cwd));
    },
  };
}

function canonsForLines(lines: string[]): (string | null)[] {
  return lines.map((line) => canon(line));
}

async function servedPreviewForFile(
  path: string,
  cwd: string,
  sessionKey: string,
): Promise<string> {
  await initHasher();
  const content = await readFile(path, "utf-8");
  const hashes = await lineHashes(content, path);
  const rows = hashes.map((hash, idx) => ({ position: idx, hash }));
  await recordServed(sessionKey, await resolveTarget(path), rows);
  const { fmtRegion } = await import("../../src/hashline");
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  if (lines.length === 1 && lines[0] === "") {
    return `${hashes[0]}│`;
  }
  return fmtRegion(hashes, lines);
}

describe("write served hash guard", () => {
  it("allows clean content and unrelated literal hash-like text", () => {
    const served: (string | null)[] = ["Ab3", "Cd4", null];
    const canons = canonsForLines(["# Notes", "body", ""]);
    expect(findServedHashEcho(splitLines("# Notes\nbody\n"), served, canons, 1)).toBeUndefined();
    expect(
      findServedHashEcho(splitLines("Zz9│literal protocol text\nbody\n"), served, canons, 1),
    ).toBeUndefined();
    expect(
      findServedHashEcho(splitLines("prefix Ab3│is ordinary text\nbody\n"), served, canons, 1),
    ).toBeUndefined();
  });

  it("refuses a verbatim served row at any position", () => {
    const served: (string | null)[] = ["Ab3", "Cd4"];
    const canons = canonsForLines(["# Notes", "body"]);
    const hit = findServedHashEcho(splitLines("Ab3│# Notes\nbody\n"), served, canons, 1);
    expect(hit).toMatchObject({ line: 1, hash: "Ab3", servedLine: 1 });
    // served prefix with differing content stays silent
    expect(
      findServedHashEcho(splitLines("Cd4│wrong line\nAb3│wrong line\n"), served, canons, 1),
    ).toBeUndefined();
  });

  it("stays silent without canon data", () => {
    expect(
      findServedHashEcho(splitLines("Ab3│nT2│CCd│UIA│## 1. H1\n"), ["Ab3"], [], 1),
    ).toBeUndefined();
  });

  it("rejects a copied current preview before the write body can change disk", async () => {
    await withTempDir("write-served-hash-red-", async (cwd) => {
      await initHasher();
      const path = join(cwd, "notes.md");
      const original = "# Notes\nbody\n";
      await writeFile(path, original, "utf-8");
      const beforeBytes = await readFile(path);

      const _io = localIO();
      const sessionKey = "session-a";
      const previewText = await servedPreviewForFile(path, cwd, sessionKey);

      const listeners = new Map<string, ToolCallHandler>();
      const pi = {
        on(event: string, handler: unknown) {
          listeners.set(event, handler as ToolCallHandler);
        },
      } as unknown as Parameters<typeof registerWriteHook>[0];
      registerWriteHook(pi);

      const listener = listeners.get("tool_call");
      expect(listener).toBeDefined();
      if (!listener) return;

      const result = await listener(
        {
          toolName: "write",
          input: { path, content: previewText },
        },
        {
          cwd,
          sessionManager: { getSessionId: () => sessionKey },
          signal: new AbortController().signal,
        },
      );

      expect(result).toMatchObject({ block: true });
      expect((result as { reason?: string }).reason).toContain("[E_SERVED_ECHO]");
      expect((result as { reason?: string }).reason).toContain("tool output, not file content");
      expect((result as { reason?: string }).reason).toContain("Nothing was written");
      expect((result as { reason?: string }).reason).toContain('mode: "literal"');
      expect(await readFile(path)).toEqual(beforeBytes);

      const cleanResult = await listener(
        {
          toolName: "write",
          input: { path, content: "# Updated\nbody\n" },
        },
        {
          cwd,
          sessionManager: { getSessionId: () => sessionKey },
          signal: new AbortController().signal,
        },
      );
      expect(cleanResult).toBeUndefined();
      expect(await readFile(path)).toEqual(beforeBytes);
    });
  });

  it("does not reuse served state across sessions or canonical paths", async () => {
    await withTempDir("write-served-hash-scope-", async (cwd) => {
      await initHasher();
      const io = localIO();
      const servedPath = join(cwd, "served.md");
      const otherPath = join(cwd, "other.md");
      await writeFile(servedPath, "served line\n", "utf-8");
      await writeFile(otherPath, "other line\n", "utf-8");
      const previewText = await servedPreviewForFile(servedPath, cwd, "session-a");

      await expect(
        servedHashEchoDenial(io, servedPath, previewText, cwd, "session-b"),
      ).resolves.toBeUndefined();
      await expect(
        servedHashEchoDenial(io, otherPath, previewText, cwd, "session-a"),
      ).resolves.toBeUndefined();
    });
  });

  it("uses evidence, not shape: served prefix with differing content is allowed", async () => {
    await withTempDir("write-served-hash-generic-", async (cwd) => {
      await initHasher();
      const io = localIO();
      const path = join(cwd, "doc.md");
      await writeFile(path, "hello\n", "utf-8");
      const abs = await resolveTarget(path);
      await recordServed("s1", abs, [{ position: 0, hash: "Ab3" }]);
      await expect(
        servedHashEchoDenial(io, path, "Zz9│literal text\n", cwd, "s1"),
      ).resolves.toBeUndefined();
      // Ab3 without canon data stays silent even at the same line
      await expect(
        servedHashEchoDenial(io, path, "Ab3│hello\n", cwd, "s1"),
      ).resolves.toBeUndefined();
    });
  });

  it("honours a literal declaration on write", async () => {
    await withTempDir("write-served-hash-literal-", async (cwd) => {
      await initHasher();
      const io = localIO();
      const path = join(cwd, "notes.md");
      await writeFile(path, "line\n", "utf-8");
      const previewText = await servedPreviewForFile(path, cwd, "sess");
      // general refuses the verbatim preview
      const refused = await servedHashEchoDenial(io, path, previewText, cwd, "sess");
      expect(refused).toMatch(/\[E_SERVED_ECHO\]/);
      // literal allows the same bytes through
      const allowed = await servedHashEchoDenial(
        io,
        path,
        previewText,
        cwd,
        "sess",
        undefined,
        "literal",
      );
      expect(allowed).toBeUndefined();
    });
  });

  it("formats the refusal with the full message contract", async () => {
    await withTempDir("write-served-hash-msg-", async (cwd) => {
      await initHasher();
      const io = localIO();
      const path = join(cwd, "notes.md");
      await writeFile(path, "line\n", "utf-8");
      const previewText = await servedPreviewForFile(path, cwd, "sess");
      const reason = await servedHashEchoDenial(io, path, previewText, cwd, "sess");
      expect(reason).toContain("[MODEL] [E_SERVED_ECHO]");
      expect(reason).toContain("line 1 begins with");
      expect(reason).toContain("served for this session, path, and line 1");
      expect(reason).toContain("tool output, not file content");
      expect(reason).toContain("Nothing was written");
      expect(reason).toContain('mode: "literal"');
      expect(reason).toContain("Re-read");
      // the guard message must not become a paste source
      const firstRow = previewText.split("\n")[0]!;
      expect(reason).not.toContain(firstRow);
    });
  });
});
