import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lineHashes } from "../../src/hashline";
import { normReq, assertReq, prepareEditArguments } from "../../src/payload-contract.js";
import { withTempFile, withTempDir, setupIntegrationTest, useTestHome } from "../support/fixtures";
import { servedHashEchoDenial } from "../../src/write-hook.js";
import { resolveTarget } from "../../src/fs-write.js";
import { toCwd } from "../../src/paths.js";
import { readFile as readFsFile } from "node:fs/promises";

const home = useTestHome();

function localIO() {
  return {
    resolve: async (p: string, cwd: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("Operation aborted");
      return resolveTarget(toCwd(p, cwd));
    },
  };
}

describe("literal declaration payload", () => {
  it("absent mode behaves as general and unknown root fields fail with mode in the hint", () => {
    const base = {
      file: "a.txt",
      edits: [{ anchor_from: "AAA", anchor_to: "BBB", replace_with: "x" }],
    };
    expect(() => assertReq(normReq(base))).not.toThrow();
    expect(() => assertReq(normReq({ ...base, mode: "literal" }))).not.toThrow();
    expect(() => assertReq(normReq({ ...base, mode: "general" }))).not.toThrow();
    try {
      prepareEditArguments({ ...base, bogus: 1 });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/E_BAD_PAYLOAD/);
      expect((e as Error).message).toContain("mode");
    }
    try {
      prepareEditArguments({ ...base, mode: "force" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/E_BAD_PAYLOAD/);
    }
  });
});

describe("edit served-row gate with declaration", () => {
  it("refuses a verbatim row and a multi-row chain, accepts ambiguous content", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const before = await readFsFile(path, "utf-8");
      // verbatim single row
      await expect(
        editTool.execute(
          "e1",
          {
            file: "sample.txt",
            edits: [
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: `${hashes[1]}│two` },
            ],
          } as any,
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_SERVED_ECHO/);
      // multi-row chain copied from another position
      await expect(
        editTool.execute(
          "e1",
          {
            file: "sample.txt",
            edits: [
              {
                anchor_from: hashes[2]!,
                anchor_to: hashes[2]!,
                replace_with: `${hashes[0]}│one\n${hashes[1]}│two`,
              },
            ],
          } as any,
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_SERVED_ECHO/);
      // ambiguous: served prefix, differing content stays accepted
      const ok = await editTool.execute(
        "e1",
        {
          file: "sample.txt",
          edits: [
            {
              anchor_from: hashes[1]!,
              anchor_to: hashes[1]!,
              replace_with: `${hashes[1]}│CHANGED`,
            },
          ],
        } as any,
        undefined,
        undefined,
        ctx,
      );
      expect(ok.content[0]?.text).toContain("Successfully edited");
      expect(await readFsFile(path, "utf-8")).toContain(`${hashes[1]}│CHANGED`);
      // restore for byte-identical check of refusals: refusals wrote nothing before the accepted write
      expect(before).toBe("one\ntwo\nthree\n");
    });
  });

  it("refusal carries the full message contract and sharpens on the 2nd identical refusal", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const payload = {
        file: "sample.txt",
        edits: [
          { anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: `${hashes[1]}│two` },
        ],
      } as any;
      const first = await editTool
        .execute("e1", payload, undefined, undefined, ctx)
        .catch((e: unknown) => e as Error);
      expect(first.message).toContain("[MODEL] [E_SERVED_ECHO]");
      expect(first.message).toContain("replacement line 1");
      expect(first.message).toContain(hashes[1]!);
      expect(first.message).toContain("line 2");
      expect(first.message).toContain("tool output, not file content");
      expect(first.message).toContain("Nothing was written");
      expect(first.message).toContain('mode: "literal"');
      expect(first.message).toContain("Re-read");
      expect(first.message).not.toContain(`${hashes[1]}│two`);
      expect(first.message).toContain("submission 1");
      const before = await readFsFile(path, "utf-8");
      const second = await editTool
        .execute("e1", payload, undefined, undefined, ctx)
        .catch((e: unknown) => e as Error);
      expect(second.message).toContain("submission 2");
      expect(second.message).not.toEqual(first.message);
      expect(second.message).toContain("Identical refusal");
      const third = await editTool
        .execute("e1", payload, undefined, undefined, ctx)
        .catch((e: unknown) => e as Error);
      expect(third.message).toMatch(/E_SERVED_ECHO/);
      expect(await readFsFile(path, "utf-8")).toBe(before);
    });
  });

  it("honours a literal declaration byte-exact with a human line and a metric", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const verbatim = `${hashes[1]}│two`;
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.txt",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: verbatim }],
          mode: "literal",
        } as any,
        undefined,
        undefined,
        ctx,
      );
      const after = await readFsFile(path, "utf-8");
      expect(after).toBe(`one\n${verbatim}\nthree\n`);
      const details = result.details as any;
      expect(details?.warnings?.join("\n")).toContain("[USER]");
      expect(details?.warnings?.join("\n")).toContain("literal declaration");
      expect(details?.metrics?.literalDeclarations).toBe(1);
    });
  });
});

describe("write served-row gate with declaration", () => {
  it("refuses verbatim rows, accepts ambiguous content, honours literal", async () => {
    await withTempDir("write-literal-", async (cwd) => {
      const { readFile: rf } = await import("node:fs/promises");
      const path = join(cwd, "notes.md");
      await writeFile(path, "one\ntwo\n", "utf-8");
      // Use the read tool to serve real rows (populates canons)
      const { getTool } = setupIntegrationTest(cwd);
      const rTool = getTool("read");
      const eCtx = { cwd, sessionManager: { getSessionId: () => "sess-w" } } as any;
      await rTool.execute("r1", { path: "notes.md" }, undefined, undefined, eCtx);
      const io = localIO();
      const { lineHashes: lh } = await import("../../src/hashline");
      const hashes = await lh("one\ntwo\n", path);
      const verbatim = `${hashes[0]}│one\n${hashes[1]}│two\n`;
      const refused = await servedHashEchoDenial(io, path, verbatim, cwd, "sess-w");
      expect(refused).toMatch(/E_SERVED_ECHO/);
      expect(refused).toContain("Nothing was written");
      expect(refused).toContain('mode: "literal"');
      const ambiguous = await servedHashEchoDenial(
        io,
        path,
        `${hashes[0]}│CHANGED\n`,
        cwd,
        "sess-w",
      );
      expect(ambiguous).toBeUndefined();
      const allowed = await servedHashEchoDenial(
        io,
        path,
        verbatim,
        cwd,
        "sess-w",
        undefined,
        "literal",
      );
      expect(allowed).toBeUndefined();
      expect(await rf(path, "utf-8")).toBe("one\ntwo\n");
    });
  });
});

describe("write literal audit via tool_result", () => {
  it("appends a dimmed human line and a metric on a literal write", async () => {
    const { default: register } = await import("../../index.js");
    const { makeTempDir } = await import("../support/fixtures.js");
    const { shutdownHashStore } = await import("../../src/hash-store.js");
    const { rm } = await import("node:fs/promises");
    const cwd = await makeTempDir("write-literal-audit-");
    try {
      const path = join(cwd, "notes.md");
      await writeFile(path, "one\ntwo\n", "utf-8");
      let toolResultHandler: any;
      const pi = {
        registerTool() {},
        registerCommand() {},
        getActiveTools: () => [],
        setActiveTools() {},
        on(event: string, handler: unknown) {
          if (event === "tool_result") toolResultHandler = handler;
        },
      } as any;
      register(pi);
      expect(toolResultHandler).toBeDefined();
      // Serve the pre-write rows
      const { getTool } = setupIntegrationTest(cwd);
      const rTool = getTool("read");
      const eCtx = { cwd, sessionManager: { getSessionId: () => "sess-audit" } } as any;
      await rTool.execute("r1", { path: "notes.md" }, undefined, undefined, eCtx);
      const { lineHashes: lh } = await import("../../src/hashline");
      const hashes = await lh("one\ntwo\n", path);
      const verbatim = `${hashes[0]}│one\n${hashes[1]}│two\n`;
      // Simulate a successful literal write that bypassed the pre-write guard
      await writeFile(path, verbatim, "utf-8");
      const out = await toolResultHandler(
        {
          toolName: "write",
          toolCallId: "w1",
          input: { path: "notes.md", content: verbatim, mode: "literal" },
          content: [{ type: "text", text: "ok" }],
          details: undefined,
          isError: false,
        },
        { cwd, sessionManager: { getSessionId: () => "sess-audit" } },
      );
      expect(out?.content?.map((c: any) => c.text).join("\n")).toContain(
        "served-echo check bypassed by literal declaration",
      );
      expect(JSON.stringify(out?.details)).toContain("literalDeclarations");
    } finally {
      shutdownHashStore();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
