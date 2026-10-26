import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdir, symlink, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { lineHashes } from "../../src/hashline/hash-identity.js";

import { SEARCH_MAX_MATCHES } from "../../src/constants";
import { clearDiagnostics, readDiagnostics, useTestHome, withTempDir } from "../support/fixtures";

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

async function bashResult(
  handler: (...args: unknown[]) => unknown,
  command: string,
  ctx: { cwd: string; sessionManager: { getSessionId(): string } },
  stdout: string,
  extra?: Record<string, unknown>,
) {
  return (await handler!(
    {
      toolName: "bash",
      isError: false,
      input: { command },
      content: [{ type: "text", text: stdout }],
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

      const result = await bashResult(handler!, "cat f.txt", ctx, numberedLines(30));
      expect(result).toBeDefined();
      expect(result!.content).toHaveLength(1);
      const text = result!.content[0]!.text;
      expect(text.startsWith("[Bash view: ")).toBe(true);
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

      const sliceStdout = `${Array.from({ length: 5 }, (_, i) => `line${i + 16}`).join("\n")}\n`;
      const result = await bashResult(
        handler!,
        "cat f.txt | head -n 20 | tail -5",
        ctx,
        sliceStdout,
      );
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

  it("resolves a single pre-view cd and fails closed on post-view/multi-cd chains", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await mkdir(join(dir, "sub"), { recursive: true });
      const content = numberedLines(5);
      await writeFile(join(dir, "sub", "f.txt"), content, "utf-8");
      // WHY: byte-identical decoy — with the old last-`cd`-wins rule this chain
      // WHY: leased `sub/f.txt` while bash printed `./f.txt`, and the D9 byte gate
      // WHY: passed precisely because the decoy matches. Pass-through plus no
      // WHY: lease proves the wrong-file grant is gone (ADR-0033 D1).
      await writeFile(join(dir, "f.txt"), content, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-cd" } };

      const result = await bashResult(handler!, "cd sub && cat f.txt", ctx, content);
      expect(result).toBeDefined();
      expect(rowsOf(result!.content[0]!.text)).toHaveLength(5);

      // WHY: `cat f.txt && cd sub` viewed `./f.txt` — the `cd` ran too late to
      // WHY: affect it — so pass-through even though `sub/f.txt` is identical.
      const postCtx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-cd-post" } };
      expect(await bashResult(handler!, "cat f.txt && cd sub", postCtx, content)).toBeUndefined();
      // WHY: and no lease was granted for the unviewed path — its valid anchor
      // WHY: stays unknown in a session that never served it (fresh session, so
      // WHY: the single-`cd` replacement above cannot mask a leaked grant).
      const subHashes = await lineHashes(content, join(dir, "sub", "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "sub/f.txt",
            edits: [{ anchor_from: subHashes[0]!, anchor_to: subHashes[0]!, text: "LINE1" }],
          },
          undefined,
          undefined,
          postCtx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");

      // WHY: chained `cd`s compose (`cd a && cd b` lands in `a/b`, not `b`), so a
      // WHY: single out-of-order re-base would resolve the wrong directory.
      expect(await bashResult(handler!, "cd a && cd b && cat f.txt", ctx, content)).toBeUndefined();
      expect(
        await bashResult(handler!, "cd sub && cd .. && cat f.txt", ctx, content),
      ).toBeUndefined();
    });
  });

  it("passes through when the anchored preview exceeds its byte budget (D3)", async () => {
    await withTempDir("bash-view-", async (dir) => {
      // WHY (ADR-0033 D3): anchors add ~7 B/row, so a view whose raw stdout fits
      // WHY: the bash byte budget can still exceed the preview budget — swapping in
      // WHY: the shortened preview would silently drop lines under a header that
      // WHY: claims the full range. Strictly slice-accurate or pass-through.
      const width = 40;
      const lines = 1200;
      const big = `${Array.from({ length: lines }, (_, i) => `line${i + 1}`.padEnd(width, ".")).join("\n")}\n`;
      expect(Buffer.byteLength(big, "utf8")).toBeLessThan(51200);
      await writeFile(join(dir, "big.txt"), big, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-trunc" } };
      // WHY: stdout byte-matches the re-read slice (D9 passes) — only the preview
      // WHY: budget forces pass-through, so the model keeps the complete original.
      expect(await bashResult(handler!, "cat big.txt", ctx, big)).toBeUndefined();
    });
  });

  it("logs the internal pass-through reason behind PI_HASHLINE_DEBUG", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-debug" } };
      const previous = process.env.PI_HASHLINE_DEBUG;
      clearDiagnostics();
      try {
        process.env.PI_HASHLINE_DEBUG = "1";
        // WHY: observability must never become model-visible — the handler still
        // WHY: returns undefined (original output untouched); the reason goes to the
        // WHY: diagnostics log, never to the terminal's frame (ADR-0033 D6 holds).
        expect(await bashResult(handler!, "cat -A f.txt", ctx, "<<raw stdout>>")).toBeUndefined();
      } finally {
        if (previous === undefined) delete process.env.PI_HASHLINE_DEBUG;
        else process.env.PI_HASHLINE_DEBUG = previous;
      }
      expect(
        readDiagnostics().some((record) =>
          record.message.includes("[bash-view] pass-through (unsupported-command:cat)"),
        ),
      ).toBe(true);
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
        "grep -c line f.txt",
        "sed -i 's/a/b/' f.txt",
        "cat f.txt f.txt",
        "echo hi && cat f.txt",
        "cat f.txt; cat f.txt",
        "cat *.txt",
        "cat f.txt > g.txt",
        "cat nope.txt",
        "cat",
      ]) {
        expect(await bashResult(handler!, command, ctx, "<<raw stdout>>")).toBeUndefined();
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
        await bashResult(handler!, "cat f.txt", ctx, numberedLines(5), {
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

      const result = await bashResult(handler!, "cat f.txt", ctxA, numberedLines(5));
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

  it("replaces rtk-wrapped views when stdout matches the slice", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-rtk" } };

      const result = await bashResult(handler!, "rtk cat f.txt", ctx, numberedLines(5));
      expect(result).toBeDefined();
      const rows = rowsOf(result!.content[0]!.text);
      expect(rows).toHaveLength(5);
      const followUp = await editTool.execute(
        "e1",
        {
          file: "f.txt",
          edits: [
            {
              anchor_from: anchorFor(rows, "line4"),
              anchor_to: anchorFor(rows, "line4"),
              text: "LINE4",
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

  it("fails closed when stdout does not match the re-read slice", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-tamper" } };

      // WHY: a filtering wrapper (or drift between exec and re-read) must grant
      // WHY: no leases — the true anchor stays unleased and fails closed.
      expect(await bashResult(handler!, "cat f.txt", ctx, "<<filtered>>\n")).toBeUndefined();
      expect(
        await bashResult(handler!, "rtk cat f.txt", ctx, `${numberedLines(5)}extra-trailer\n`),
      ).toBeUndefined();
      const allHashes = await lineHashes(numberedLines(5), join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e1",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[1]!, anchor_to: allHashes[1]!, text: "LINE2" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("fails closed on multi-block stdout", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-multi" } };

      expect(
        await handler!(
          {
            toolName: "bash",
            isError: false,
            input: { command: "cat f.txt" },
            content: [
              { type: "text", text: numberedLines(5) },
              { type: "text", text: "second block" },
            ],
          },
          ctx,
        ),
      ).toBeUndefined();
    });
  });

  it("anchors a CRLF file viewed through bash (line-ending normalization)", async () => {
    await withTempDir("bash-view-", async (dir) => {
      // WHY: `cat` emits the disk bytes (CRLF) while `readNormFile` — and the
      // WHY: anchors below — describe the LF text, so the stdout comparison must
      // WHY: normalize line endings instead of failing closed on exactly the
      // WHY: files the model views through bash.
      const crlf = numberedLines(5).replace(/\n/g, "\r\n");
      await writeFile(join(dir, "f.txt"), crlf, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-crlf" } };

      const result = await bashResult(handler!, "cat f.txt", ctx, crlf);
      expect(result).toBeDefined();
      const rows = rowsOf(result!.content[0]!.text);
      expect(rows).toHaveLength(5);

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

  it("anchors a BOM file viewed through bash (BOM normalization)", async () => {
    await withTempDir("bash-view-", async (dir) => {
      // WHY: a leading BOM is stripped by `readNormFile`, so a BOM file has to
      // WHY: compare equal to its own stdout after the same strip — otherwise
      // WHY: the anchors describe text the byte gate refuses to serve.
      const withBom = `\uFEFF${numberedLines(5)}`;
      await writeFile(join(dir, "f.txt"), withBom, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-bom" } };

      const result = await bashResult(handler!, "cat f.txt", ctx, withBom);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      const rows = rowsOf(text);
      expect(rows).toHaveLength(5);
      // WHY: rows come from the normalized (BOM-free) text — the same anchors
      // WHY: the read path serves for the same file.
      expect(text).not.toContain("\uFEFF");

      const followUp = await editTool.execute(
        "e1",
        {
          file: "f.txt",
          edits: [
            {
              anchor_from: anchorFor(rows, "line3"),
              anchor_to: anchorFor(rows, "line3"),
              text: "LINE3",
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

  it("still fails closed when a CRLF/BOM view differs beyond its encoding", async () => {
    await withTempDir("bash-view-", async (dir) => {
      // WHY: normalization covers line endings and a BOM only. An added row, a
      // WHY: changed row, or undecodable bytes must still fail closed, so the
      // WHY: gate stays a byte check and not a fuzzy match (ADR-0033 D9).
      const crlf = numberedLines(5).replace(/\n/g, "\r\n");
      await writeFile(join(dir, "crlf.txt"), crlf, "utf-8");
      await writeFile(join(dir, "bom.txt"), `\uFEFF${numberedLines(5)}`, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = {
        cwd: dir,
        sessionManager: { getSessionId: () => "bash-view-encoding-strict" },
      };

      expect(await bashResult(handler!, "cat crlf.txt", ctx, `${crlf}extra\r\n`)).toBeUndefined();
      expect(
        await bashResult(handler!, "cat bom.txt", ctx, `\uFEFF${numberedLines(5)}extra\n`),
      ).toBeUndefined();
      expect(
        await bashResult(handler!, "cat crlf.txt", ctx, numberedLines(5).replace("line3", "LINE3")),
      ).toBeUndefined();
    });
  });

  it("anchors a `;`-chained silent prefix view and gates `pwd` prefixes on stdout", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await mkdir(join(dir, "sub"), { recursive: true });
      const content = numberedLines(5);
      await writeFile(join(dir, "sub", "f.txt"), content, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-semicolon" } };

      // WHY: `cd sub; cat f.txt` is the benchmark spelling of the pre-view `cd`
      // WHY: that `&&` already supports — the terminal statement carries the view.
      const result = await bashResult(handler!, "cd sub; cat f.txt", ctx, content);
      expect(result).toBeDefined();
      expect(rowsOf(result!.content[0]!.text)).toHaveLength(5);

      // WHY: `pwd` is admitted as a prefix, but it prints the working directory,
      // WHY: so D9 refuses the lease: the admitted shape can never mis-serve.
      const pwdCtx = {
        cwd: dir,
        sessionManager: { getSessionId: () => "bash-view-semicolon-pwd" },
      };
      expect(
        await bashResult(handler!, "pwd; cat sub/f.txt", pwdCtx, `${dir}\n${content}`),
      ).toBeUndefined();

      // WHY: a prefix `cd` that fails at runtime must lease nothing. bash viewed
      // WHY: `./f.txt` (the `cd` failed and `;` does not short-circuit), the
      // WHY: classifier resolves `missing/f.txt`, and the byte-identical decoy
      // WHY: proves no wrong-file grant slipped through the D9 byte gate.
      const decoy = numberedLines(5);
      await writeFile(join(dir, "f.txt"), decoy, "utf-8");
      const missCtx = {
        cwd: dir,
        sessionManager: { getSessionId: () => "bash-view-semicolon-miss" },
      };
      expect(await bashResult(handler!, "cd missing; cat f.txt", missCtx, decoy)).toBeUndefined();
      const decoyHashes = await lineHashes(decoy, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e9",
          {
            file: "f.txt",
            edits: [
              {
                anchor_from: decoyHashes[0]!,
                anchor_to: decoyHashes[0]!,
                text: "LINE1",
              },
            ],
          },
          undefined,
          undefined,
          missCtx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });
});

describe("bash search interception (I1a #73)", () => {
  it("injects -n at tool_call and serves anchored, leased rows end to end", async () => {
    await withTempDir("bash-search-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers, handlersAll, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-search-e2e" } };

      // WHY: the full path — the `tool_call` hook rewrites the model's unnumbered command, and the
      // WHY: `tool_result` side re-parses that mutated text (no cross-hook state) to decide the lease.
      const call = { toolName: "bash", input: { command: "grep 'line3' f.txt" } };
      for (const handler of handlersAll.get("tool_call") ?? []) await handler(call, ctx);
      expect(call.input.command).toBe("grep -n 'line3' f.txt");

      const result = await bashResult(
        handlers.get("tool_result")!,
        call.input.command,
        ctx,
        "3:line3\n",
      );
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text.startsWith("[Bash search (anchors)]\n")).toBe(true);
      expect(text).toContain("[f.txt (1 match)]");
      const rows = rowsOf(text);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.endsWith("│line3")).toBe(true);

      const followUp = await editTool.execute(
        "e1",
        {
          file: "f.txt",
          edits: [
            {
              anchor_from: anchorFor(rows, "line3"),
              anchor_to: anchorFor(rows, "line3"),
              text: "LINE3",
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

  it("serves a sparse match set and leases only the matched lines", async () => {
    await withTempDir("bash-search-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-search-sparse" } };

      const result = await bashResult(
        handlers.get("tool_result")!,
        "grep -n line f.txt",
        ctx,
        "2:line2\n4:line4\n",
      );
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text).toContain("[f.txt (2 matches)]");
      const rows = rowsOf(text);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.endsWith("│line2")).toBe(true);
      expect(rows[1]!.endsWith("│line4")).toBe(true);

      // WHY: line3 was never served — its (valid) anchor carries no lease and fails closed.
      const allHashes = await lineHashes(numberedLines(5), join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[2]!, anchor_to: allHashes[2]!, text: "L3" }],
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
              anchor_from: anchorFor(rows, "line4"),
              anchor_to: anchorFor(rows, "line4"),
              text: "LINE4",
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

  it("serves exactly the match cap and passes through one row over it", async () => {
    await withTempDir("bash-search-", async (dir) => {
      const stdoutFor = (n: number) =>
        `${Array.from({ length: n }, (_, i) => `${i + 1}:line${i + 1}`).join("\n")}\n`;

      const capped = `${numberedLines(50)}`;
      await writeFile(join(dir, "capped.txt"), capped, "utf-8");
      await writeFile(join(dir, "over.txt"), numberedLines(51), "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const atCap = { cwd: dir, sessionManager: { getSessionId: () => "bash-search-cap" } };
      const overCap = { cwd: dir, sessionManager: { getSessionId: () => "bash-search-over" } };

      const boundary = await bashResult(
        handlers.get("tool_result")!,
        "grep -n line capped.txt",
        atCap,
        stdoutFor(SEARCH_MAX_MATCHES),
      );
      expect(boundary).toBeDefined();
      expect(boundary!.content[0]!.text).toContain(`[capped.txt (${SEARCH_MAX_MATCHES} matches)]`);

      // WHY: the cap is all-or-nothing — raw passthrough with no truncation and no partial leases.
      expect(
        await bashResult(
          handlers.get("tool_result")!,
          "grep -n line over.txt",
          overCap,
          stdoutFor(SEARCH_MAX_MATCHES + 1),
        ),
      ).toBeUndefined();
      const overHashes = await lineHashes(numberedLines(51), join(dir, "over.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "over.txt",
            edits: [{ anchor_from: overHashes[0]!, anchor_to: overHashes[0]!, text: "L1" }],
          },
          undefined,
          undefined,
          overCap,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("fails closed on unparsable geometry, a forged witness, and an out-of-range line", async () => {
    await withTempDir("bash-search-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-search-gates" } };

      // WHY: `grep -c` prints a bare count and rg `<n> matches` prints nothing parseable — any row
      // WHY: that is not `LINE:content` means this stdout is not the admitted geometry.
      expect(
        await bashResult(handlers.get("tool_result")!, "grep -n line f.txt", ctx, "3\n"),
      ).toBeUndefined();
      // WHY: forged witness — stdout claims line3 but disk says `line3`→`forged`. D9 refuses.
      expect(
        await bashResult(handlers.get("tool_result")!, "grep -n line f.txt", ctx, "3:forged\n"),
      ).toBeUndefined();
      // WHY: line 99 does not exist on disk — the anchored row would name no line.
      expect(
        await bashResult(handlers.get("tool_result")!, "grep -n line f.txt", ctx, "99:line99\n"),
      ).toBeUndefined();
      // WHY: exit 1 (no matches) leaves stdout empty; the raw output must survive untouched.
      expect(
        await bashResult(handlers.get("tool_result")!, "grep -n zzz f.txt", ctx, ""),
      ).toBeUndefined();
      // WHY: a directory operand is a structural deny (spec §3.2) the pure classifier cannot see, so
      // WHY: the lifecycle layer re-checks the file kind after resolution and fails closed.
      await mkdir(join(dir, "sub"), { recursive: true });
      expect(
        await bashResult(handlers.get("tool_result")!, "grep -n line sub", ctx, "1:x\n"),
      ).toBeUndefined();

      const allHashes = await lineHashes(numberedLines(5), join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[2]!, anchor_to: allHashes[2]!, text: "L3" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("fails closed on a genuine stale capture: real stdout that went stale before tool_result", async () => {
    await withTempDir("bash-search-", async (dir) => {
      const original = numberedLines(5);
      await writeFile(join(dir, "f.txt"), original, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result")!;
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-search-toctou" } };
      // WHY: a separate session so the control's leases cannot mask the stale-capture refusal below.
      const controlCtx = {
        cwd: dir,
        sessionManager: { getSessionId: () => "bash-search-toctou-ctl" },
      };
      const command = "grep -n line3 f.txt";
      // WHY: real bash, not a hand-written string — the capture below is the bytes bash actually printed
      // WHY: for line 3 as it was on disk at capture time.
      const runReal = () => execFileSync("bash", ["-c", command], { cwd: dir, encoding: "utf-8" });

      const captured = runReal();
      expect(captured).toBe("3:line3\n");
      // WHY: control — the same handler over the same capture while the disk still matches produces an
      // WHY: anchor block, so the `undefined` after the mutation is the stale-capture refusal itself and
      // WHY: not a dead code path that would pass under any implementation.
      const control = await bashResult(handler, command, controlCtx, captured);
      expect(control).toBeDefined();
      expect(control!.content[0]!.text).toContain("[f.txt (1 match)]");

      // WHY: the race - the file mutates on disk AFTER the capture and BEFORE `tool_result` runs, so the
      // WHY: witness handed to the hook names line 3, but every line has shifted down one, so it names
      // WHY: content the disk no longer holds at that line.
      await writeFile(join(dir, "f.txt"), `line0\n${original}`, "utf-8");
      const fresh = runReal();
      // WHY: discriminating staleness proof: a fresh real run over the mutated file no longer matches the
      // WHY: captured text, so the capture is genuinely stale and not a fabricated mismatch.
      expect(fresh).toBe("4:line3\n");
      expect(fresh).not.toBe(captured);

      const event = {
        toolName: "bash",
        isError: false,
        input: { command },
        content: [{ type: "text", text: captured }],
      };
      const result = await handler(event, ctx);
      // (a) fails closed: no anchor block is fabricated for a witness the disk no longer supports.
      expect(result).toBeUndefined();
      // (b) what the model sees stays the raw bash stdout byte-for-byte: the hook rewrote nothing.
      expect(event.content[0]!.text).toBe(captured);

      // (c) zero leases were granted, so the anchor the captured stdout named is still unknown.
      const staleHashes = await lineHashes(original, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: staleHashes[2]!, anchor_to: staleHashes[2]!, text: "L3" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("keeps rg on the same gates and leaves denied commands byte-identical at tool_call", async () => {
    await withTempDir("bash-search-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers, handlersAll } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-search-rg" } };
      const calls = handlersAll.get("tool_call") ?? [];

      // WHY: denied flags must reach bash byte-identical — only the `-n` injection may mutate.
      for (const command of [
        "grep -c line f.txt",
        "rg --json line f.txt",
        "cat f.txt",
        "grep line f.txt | head -2",
      ]) {
        const call = { toolName: "bash", input: { command } };
        for (const handler of calls) await handler(call, ctx);
        expect(call.input.command).toBe(command);
      }

      const call = { toolName: "bash", input: { command: "rg line3 f.txt" } };
      for (const handler of calls) await handler(call, ctx);
      expect(call.input.command).toBe("rg --line-number line3 f.txt");

      const result = await bashResult(
        handlers.get("tool_result")!,
        call.input.command,
        ctx,
        "3:line3\n",
      );
      expect(result).toBeDefined();
      expect(result!.content[0]!.text).toContain("[f.txt (1 match)]");
      expect(rowsOf(result!.content[0]!.text)).toHaveLength(1);
    });
  });
  it("passes every denied flag through the hook byte-identically with the output untouched", async () => {
    await withTempDir("bash-search-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers, handlersAll } = makeFakePi();
      register(pi);
      const calls = handlersAll.get("tool_call") ?? [];
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-search-deny" } };
      const raw = "3:line3\n";

      // WHY: one row per denied flag — the injection hook must leave the command byte-identical (so
      // WHY: native grep/rg semantics are preserved) and the `tool_result` side must return undefined
      // WHY: (so the raw stdout reaches the model untouched).
      const denied = [
        "grep -c pat f.txt",
        "grep --count pat f.txt",
        "grep -v pat f.txt",
        "grep --invert-match pat f.txt",
        "grep -o pat f.txt",
        "grep --only-matching pat f.txt",
        "grep -A 2 pat f.txt",
        "grep -B 2 pat f.txt",
        "grep -C 2 pat f.txt",
        "grep -l pat f.txt",
        "grep -L pat f.txt",
        // WHY: the bare `--max-count` spelling stays denied — spec §3.2 admits the separate
        // WHY: argument for the short `-m` alone (see the classifier matrix for the same pin).
        "grep --max-count 3 pat f.txt",
        "grep -q pat f.txt",
        "grep -s pat f.txt",
        "grep -b pat f.txt",
        "grep -H pat f.txt",
        "grep -h pat f.txt",
        "grep -P pat f.txt",
        "grep -f pats f.txt",
        "grep -n5 pat f.txt",
        "grep --line-number=x pat f.txt",
        "rg --column pat f.txt",
        "rg --heading pat f.txt",
        "rg --no-heading pat f.txt",
        "rg -N pat f.txt",
        "rg --no-line-number pat f.txt",
        "rg --json pat f.txt",
        "rg --stats pat f.txt",
        "rg --files",
        "rg -r x pat f.txt",
        "rg --replace x pat f.txt",
        "rg -0 pat f.txt",
        "rg --null pat f.txt",
        "rg --vimgrep pat f.txt",
        "rg -uu pat f.txt",
        "rg -t ts pat f.txt",
        "rg -j 4 pat f.txt",
        "rg --hidden pat f.txt",
        "grep pat f.txt | head -2",
        "grep pat f.txt > out.txt",
        "grep pat f.txt && cat f.txt",
        "grep pat f.txt || cat f.txt",
        "grep pat f.txt &",
        "grep pat",
        "grep pat *.ts",
        "cat f.txt | grep pat",
      ];
      for (const command of denied) {
        const call = { toolName: "bash", input: { command } };
        for (const handler of calls) await handler(call, ctx);
        expect(call.input.command).toBe(command);
        expect(await bashResult(handlers.get("tool_result")!, command, ctx, raw)).toBeUndefined();
      }
    });
  });

  it("serves anchored rows for the Tier-1 flag shapes end to end", async () => {
    await withTempDir("bash-search-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers, handlersAll } = makeFakePi();
      register(pi);
      const calls = handlersAll.get("tool_call") ?? [];
      const raw = "3:line3\n";

      // WHY: the Tier-1 expansion (spec §3.2) only matters if it survives both seams — the
      // WHY: injected `-n` at `tool_call` AND the served rows at `tool_result`. Each case gets
      // WHY: its own session so the lease bookkeeping of one serve cannot mask the next.
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["grep 'line3' f.txt -w", "grep -n 'line3' f.txt -w"],
        ["grep 'line3' -x f.txt", "grep -n 'line3' -x f.txt"],
        ["grep -m 1 'line3' f.txt", "grep -n -m 1 'line3' f.txt"],
        ["grep --color=never -in 'line3' f.txt", "grep --color=never -in 'line3' f.txt"],
      ];
      for (const [index, [command, rewritten]] of cases.entries()) {
        const ctx = {
          cwd: dir,
          sessionManager: { getSessionId: () => `bash-search-tier1-${index}` },
        };
        const call = { toolName: "bash", input: { command } };
        for (const handler of calls) await handler(call, ctx);
        expect(call.input.command).toBe(rewritten);
        const result = await bashResult(handlers.get("tool_result")!, rewritten, ctx, raw);
        expect(result).toBeDefined();
        expect(result!.content[0]!.text).toContain("[f.txt (1 match)]");
        expect(rowsOf(result!.content[0]!.text)).toHaveLength(1);
      }
    });
  });

  it("passes attached context, filename/formatting and non-literal search shapes through both hooks", async () => {
    await withTempDir("bash-search-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers, handlersAll } = makeFakePi();
      register(pi);
      const calls = handlersAll.get("tool_call") ?? [];
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-search-widen" } };
      const raw = "3:line3\n";

      // WHY: the shapes the pure classifier refuses must also be inert at the hook seam — the injection
      // WHY: hook leaves the command byte-identical and `tool_result` returns undefined, so a widening
      // WHY: that admitted one of these would surface here as an injected `-n` or an anchor block.
      const denied = [
        // WHY: attached context flags; `-A2` prints `--` separators and bare context rows, so the
        // WHY: `^(\d+):` row geometry the anchors are built from is gone.
        "grep -A2 pat f.txt",
        "grep -B3 pat f.txt",
        "grep -C1 pat f.txt",
        // WHY: the filename flags add or drop the `file:` prefix the line-number parse keys on.
        "grep --with-filename pat f.txt",
        "grep --no-filename pat f.txt",
        // WHY: colour escapes wrap the digits the disk witness compares against.
        "grep --color pat f.txt",
        "grep --color=auto pat f.txt",
        // WHY: a backtick operand is expanded by bash, so the resolved file is not the file bash reads.
        "grep `cmd` f.txt",
        // WHY: the rg spellings of the same two widenings.
        "rg -A2 pat f.txt",
        "rg --with-filename pat f.txt",
      ];
      for (const command of denied) {
        const call = { toolName: "bash", input: { command } };
        for (const handler of calls) await handler(call, ctx);
        expect(call.input.command).toBe(command);
        expect(await bashResult(handlers.get("tool_result")!, command, ctx, raw)).toBeUndefined();
      }
    });
  });

  it("normalizes CRLF and BOM in the search witness exactly as D9 does for a view", async () => {
    await withTempDir("bash-search-", async (dir) => {
      // WHY: grep prints the disk bytes, so a CRLF file yields `3:line3\r` and a BOM file yields a
      // WHY: leading U+FEFF on row 1, while `readNormFile`/`visLines` (and the anchors served here)
      // WHY: describe LF/no-BOM text. `toLF(stripBOM(...))` is the tranche-1 D9 normalization, so the
      // WHY: search witness stays consistent with the view seam on the files bash actually printed.
      await writeFile(join(dir, "crlf.txt"), "line1\r\nline2\r\nline3\r\n", "utf-8");
      await writeFile(join(dir, "bom.txt"), "\uFEFFline1\nline2\n", "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-search-norm" } };

      const crlf = await bashResult(
        handlers.get("tool_result")!,
        "grep -n line crlf.txt",
        ctx,
        "3:line3\r\n",
      );
      expect(crlf).toBeDefined();
      expect(crlf!.content[0]!.text).toContain("[crlf.txt (1 match)]");
      expect(rowsOf(crlf!.content[0]!.text)[0]!.endsWith("│line3")).toBe(true);

      const bom = await bashResult(
        handlers.get("tool_result")!,
        "grep -n line bom.txt",
        ctx,
        "\uFEFF1:line1\n",
      );
      expect(bom).toBeDefined();
      expect(bom!.content[0]!.text).toContain("[bom.txt (1 match)]");
      expect(rowsOf(bom!.content[0]!.text)[0]!.endsWith("│line1")).toBe(true);
    });
  });
});

describe("bash multi-range sed lifecycle (Tier-2 item 7)", () => {
  it("intercepts merged multi-range sed and leases exactly the union", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(30), "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-sed-multi" } };

      // WHY: '16,18p'+'17,20p' merge at parse to [16,20]; stdout must equal
      // WHY: exactly that slice or the D9 byte gate fails closed.
      const sliceStdout = `${Array.from({ length: 5 }, (_, i) => `line${i + 16}`).join("\n")}\n`;
      const result = await bashResult(
        handler!,
        "sed -n -e '16,18p' -e '17,20p' f.txt",
        ctx,
        sliceStdout,
      );
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

  it("passes through disjoint multi-range sed (fold-inert) with no leases", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(30), "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-sed-disjoint" } };

      // WHY: disjoint [1,1],[30,30] cannot survive the sequential stream-relative
      // WHY: fold — the second range selects inside the first selection, yielding
      // WHY: empty — so D3 passes through and grants nothing. True sed would print
      // WHY: line1+line30; serving raw is the safe answer until a union-aware op
      // WHY: exists. Pass-through either way.
      expect(
        await bashResult(handler!, "sed -n -e '1p' -e '30p' f.txt", ctx, "line1\nline30\n"),
      ).toBeUndefined();
      const allHashes = await lineHashes(numberedLines(30), join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e1",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[0]!, anchor_to: allHashes[0]!, text: "LINE1" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("passes through mixed valid+garbage, reversed, and ;-joined sed spells", async () => {
    await withTempDir("bash-view-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-sed-deny" } };

      for (const command of [
        "sed -n -e '2p' -e 's/a/b/p' f.txt",
        "sed -n -e '2p' -e '/re/p' f.txt",
        "sed -n -e '4,2p' f.txt",
        "sed -n '4,2p' f.txt",
        "sed -n -e '1p;2p' f.txt",
        "sed -n '1p;2p' f.txt",
        "sed -n '2p' -e '3p' f.txt",
        "sed -n -e '2p' f.txt extra.txt",
      ]) {
        expect(await bashResult(handler!, command, ctx, "<<raw stdout>>")).toBeUndefined();
      }
    });
  });
});

describe("bash numbered view lifecycle (Tier-2 item 8)", () => {
  function catNumbered(text: string): string {
    // Mirrors GNU `cat -n` geometry: right-aligned width-6 number + tab.
    return (
      text
        .split("\n")
        .filter((l) => l !== "")
        .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
        .join("\n") + "\n"
    );
  }

  it("replaces `cat -n` output with the full-file anchored view and leases the whole file", async () => {
    await withTempDir("bash-view-num-", async (dir) => {
      const body = numberedLines(10);
      await writeFile(join(dir, "f.txt"), body, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      expect(handler).toBeDefined();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-num-a" } };

      const result = await bashResult(handler!, "cat -n f.txt", ctx, catNumbered(body));
      expect(result).toBeDefined();
      expect(result!.content).toHaveLength(1);
      const text = result!.content[0]!.text;
      expect(text.startsWith("[Bash view: ")).toBe(true);
      const rows = rowsOf(text);
      expect(rows).toHaveLength(10);
      for (const n of [1, 5, 10]) expect(rows.some((l) => l.endsWith(`│line${n}`))).toBe(true);

      // Lease shape: full-file — first AND last line anchors both edit cleanly.
      for (const target of ["line1", "line10"] as const) {
        const ok = await editTool.execute(
          "e-" + target,
          {
            file: "f.txt",
            edits: [
              {
                anchor_from: anchorFor(rows, target),
                anchor_to: anchorFor(rows, target),
                text: "X",
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(ok.isError).toBeFalsy();
      }
    });
  });

  it("renders `nl -ba` through the same full-file renderer with the same lease", async () => {
    await withTempDir("bash-view-num-", async (dir) => {
      const body = numberedLines(6);
      await writeFile(join(dir, "f.txt"), body, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-num-b" } };

      const catRes = await bashResult(handler!, "cat -n f.txt", ctx, catNumbered(body));
      const nlRes = await bashResult(handler!, "nl -ba f.txt", ctx, catNumbered(body));
      expect(catRes).toBeDefined();
      expect(nlRes).toBeDefined();
      // ONE renderer: same header; same row count; row bodies identical up to per-run hashes.
      expect(nlRes!.content[0]!.text.startsWith("[Bash view: ")).toBe(true);
      expect(rowsOf(nlRes!.content[0]!.text)).toHaveLength(6);
      const bodies = (t: string) =>
        rowsOf(t)
          .map((r) => r.split("│")[1])
          .join("\n");
      expect(bodies(nlRes!.content[0]!.text)).toBe(bodies(catRes!.content[0]!.text));

      const nlRows = rowsOf(nlRes!.content[0]!.text);
      const ok = await editTool.execute(
        "e1",
        {
          file: "f.txt",
          edits: [
            {
              anchor_from: anchorFor(nlRows, "line6"),
              anchor_to: anchorFor(nlRows, "line6"),
              text: "X",
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

  it("fails closed to raw stdout on any numbered-output skew (no lease, no replace)", async () => {
    await withTempDir("bash-view-num-", async (dir) => {
      const body = numberedLines(4);
      await writeFile(join(dir, "f.txt"), body, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-view-num-c" } };

      // Dropped row.
      const dropped = catNumbered(body)
        .split("\n")
        .filter((_, i) => i !== 1)
        .join("\n");
      expect(await bashResult(handler!, "cat -n f.txt", ctx, dropped)).toBeUndefined();
      // Renumbered (starts at 0).
      const renum =
        body
          .split("\n")
          .filter((l) => l !== "")
          .map((l, i) => `${String(i).padStart(6)}\t${l}`)
          .join("\n") + "\n";
      expect(await bashResult(handler!, "cat -n f.txt", ctx, renum)).toBeUndefined();
      // Forged content on a numbered row.
      const forged = catNumbered(body).replace("line2", "EVIL");
      expect(await bashResult(handler!, "nl -ba f.txt", ctx, forged)).toBeUndefined();
      // Unnumbered stdout for a numbered command (and vice versa).
      expect(await bashResult(handler!, "cat -n f.txt", ctx, body)).toBeUndefined();
      expect(await bashResult(handler!, "cat f.txt", ctx, catNumbered(body))).toBeUndefined();
    });
  });
});

describe("bash filter-stage lifecycle (Tier-3 item 9)", () => {
  it("serves cat|grep -v with file-true anchors and leases only the survivors", async () => {
    await withTempDir("bash-filter-", async (dir) => {
      const content = "keep1\nDROP\nkeep2\nDROP\nkeep3\n";
      await writeFile(join(dir, "f.txt"), content, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-filter-drop" } };
      const result = await bashResult(
        handlers.get("tool_result")!,
        "cat f.txt | grep -v DROP",
        ctx,
        "keep1\nkeep2\nkeep3\n",
      );
      expect(result).toBeDefined();
      const rows = rowsOf(result!.content[0]!.text);
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.split("\u2502")[1])).toEqual(["keep1", "keep2", "keep3"]);
      // WHY: the dropped line's true anchor was never served, so it grants nothing —
      // WHY: least privilege, and the witness that the fold binds real file positions.
      const allHashes = await lineHashes(content, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[1]!, anchor_to: allHashes[1]!, text: "X" }],
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
              anchor_from: anchorFor(rows, "keep2"),
              anchor_to: anchorFor(rows, "keep2"),
              text: "KEEP2",
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

  it("distinguishes subtract-then-head from head-then-subtract", async () => {
    await withTempDir("bash-filter-", async (dir) => {
      const content = "K1\nK2\na\nb\n";
      await writeFile(join(dir, "f.txt"), content, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      // WHY: subtract-then-head serves file lines 3 and 4.
      const first = { cwd: dir, sessionManager: { getSessionId: () => "bash-filter-order-a" } };
      const served = await bashResult(handler!, "cat f.txt | grep -v K | head -2", first, "a\nb\n");
      expect(served).toBeDefined();
      expect(rowsOf(served!.content[0]!.text).map((row) => row.split("\u2502")[1])).toEqual([
        "a",
        "b",
      ]);
      // WHY: head-then-subtract empties (lines 1 and 2 both contain K) — the fold yields
      // WHY: no windows, so the view passes through with zero leases.
      const second = { cwd: dir, sessionManager: { getSessionId: () => "bash-filter-order-b" } };
      expect(
        await bashResult(handler!, "cat f.txt | head -2 | grep -v K", second, ""),
      ).toBeUndefined();
    });
  });

  it("serves an unnumbered search source through the content fold, mutating nothing", async () => {
    await withTempDir("bash-filter-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(5), "utf-8");
      const { pi, handlers, handlersAll, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-filter-search-head" } };
      // WHY: the command reaches bash byte-identical — the source search became a `keep`, so
      // WHY: whatever the model's own semantics are is what the fold is gated against.
      const call = { toolName: "bash", input: { command: "grep line f.txt | head -2" } };
      for (const handler of handlersAll.get("tool_call") ?? []) await handler(call, ctx);
      expect(call.input.command).toBe("grep line f.txt | head -2");
      const result = await bashResult(
        handlers.get("tool_result")!,
        call.input.command,
        ctx,
        "line1\nline2\n",
      );
      expect(result).toBeDefined();
      expect(result!.content[0]!.text.startsWith("[Bash view: ")).toBe(true);
      expect(result!.content[0]!.text).toContain("[Bash view: f.txt (2 lines)]");
      const rows = rowsOf(result!.content[0]!.text);
      expect(rows).toHaveLength(2);
      // WHY: file-true coordinates — the survivors are lines 1 and 2, and both edit cleanly.
      const ok = await editTool.execute(
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
      expect(ok.isError).toBeFalsy();
    });
  });

  it("leases sparse survivors row by row instead of passing them through raw", async () => {
    await withTempDir("bash-filter-", async (dir) => {
      // WHY: 20 survivors over 40 lines is 20 runs — far past the read tool's 16-window budget —
      // WHY: yet a search-shaped row lease serves it; the window budget would go raw here.
      const sparse =
        Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? `hit${i + 1}` : "miss")).join("\n") +
        "\n";
      await writeFile(join(dir, "f.txt"), sparse, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-filter-sparse" } };
      const stdout = Array.from({ length: 20 }, (_, i) => `hit${i * 2 + 1}`).join("\n") + "\n";
      const result = await bashResult(
        handlers.get("tool_result")!,
        "cat f.txt | grep hit",
        ctx,
        stdout,
      );
      expect(result).toBeDefined();
      const rows = rowsOf(result!.content[0]!.text);
      expect(rows).toHaveLength(20);
      expect(rows[0]!.split("\u2502")[1]).toBe("hit1");
      // WHY: the interleaved `miss` line was filtered out, so its true anchor grants nothing.
      const allHashes = await lineHashes(sparse, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[1]!, anchor_to: allHashes[1]!, text: "X" }],
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
              anchor_from: anchorFor(rows, "hit1"),
              anchor_to: anchorFor(rows, "hit1"),
              text: "HIT",
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

  it("serves exactly the match cap and passes one row over it through raw", async () => {
    await withTempDir("bash-filter-", async (dir) => {
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const handler = handlers.get("tool_result");
      // WHY: SEARCH_MAX_MATCHES bounds the content seam exactly as it bounds a search:
      // WHY: over-cap passes the WHOLE output raw — never a silently truncated render.
      const fifty = Array.from({ length: 50 }, (_, i) => `hit${i + 1}`).join("\n") + "\n";
      await writeFile(join(dir, "f.txt"), fifty, "utf-8");
      const atCap = await bashResult(
        handler!,
        "cat f.txt | grep hit",
        { cwd: dir, sessionManager: { getSessionId: () => "bash-filter-cap-50" } },
        fifty,
      );
      expect(atCap).toBeDefined();
      expect(rowsOf(atCap!.content[0]!.text)).toHaveLength(50);
      const over = `${fifty}hit51\n`;
      await writeFile(join(dir, "f.txt"), over, "utf-8");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-filter-cap-51" } };
      expect(await bashResult(handler!, "cat f.txt | grep hit", ctx, over)).toBeUndefined();
      const allHashes = await lineHashes(over, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[0]!, anchor_to: allHashes[0]!, text: "X" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("fails closed on a stdout that the disk fold does not reproduce", async () => {
    await withTempDir("bash-filter-", async (dir) => {
      const body = numberedLines(5);
      await writeFile(join(dir, "f.txt"), body, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-filter-gates" } };
      // WHY: stdout claims every line survived a `-v line3` while the disk fold removes line3 —
      // WHY: the whole-stdout byte gate refuses the serve (never a partial grant).
      expect(await bashResult(handler!, "cat f.txt | grep -v line3", ctx, body)).toBeUndefined();
      // WHY: and the mirror image — stdout claims everything was filtered while the fold keeps
      // WHY: four lines — also refused, so "no output" can never be manufactured by the seam.
      expect(await bashResult(handler!, "cat f.txt | grep -v line3", ctx, "")).toBeUndefined();
      // WHY: zero leases after every refusal.
      const allHashes = await lineHashes(body, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[0]!, anchor_to: allHashes[0]!, text: "X" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });
});

describe("bash multi-file and recursive lifecycle (Tier-3 item 10)", () => {
  it("serves per-file sections and leases each named file independently", async () => {
    await withTempDir("bash-multi-", async (dir) => {
      await writeFile(join(dir, "a.txt"), "alpha1\nalpha2\nalpha3\n", "utf-8");
      await writeFile(join(dir, "b.txt"), "beta1\nbeta2\nbeta3\n", "utf-8");
      const { pi, handlers, handlersAll, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-multi" } };
      // WHY: the model's unnumbered multi-file search is spliced by the same tool_call hook.
      const call = { toolName: "bash", input: { command: "grep 3 a.txt b.txt" } };
      for (const handler of handlersAll.get("tool_call") ?? []) await handler(call, ctx);
      expect(call.input.command).toBe("grep -n 3 a.txt b.txt");
      const result = await bashResult(
        handlers.get("tool_result")!,
        call.input.command,
        ctx,
        "a.txt:3:alpha3\nb.txt:3:beta3\n",
      );
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text.startsWith("[Bash search (anchors)]\n")).toBe(true);
      expect(text).toContain("[a.txt (1 match)]");
      expect(text).toContain("[b.txt (1 match)]");
      expect(text.indexOf("[a.txt")).toBeLessThan(text.indexOf("[b.txt"));
      const rows = rowsOf(text);
      expect(rows).toHaveLength(2);
      // WHY: leases are per file, so both files' anchors edit in this one session.
      for (const [file, content] of [
        ["a.txt", "alpha3"],
        ["b.txt", "beta3"],
      ] as const) {
        const ok = await editTool.execute(
          `e-${file}`,
          {
            file,
            edits: [
              {
                anchor_from: anchorFor(rows, content),
                anchor_to: anchorFor(rows, content),
                text: "X",
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(ok.isError).toBeFalsy();
      }
    });
  });

  it("fails the whole multi-file serve closed on a forgery, an outside file or mixed geometry", async () => {
    await withTempDir("bash-multi-", async (dir) => {
      await writeFile(join(dir, "a.txt"), "alpha1\nalpha2\nalpha3\n", "utf-8");
      await writeFile(join(dir, "b.txt"), "beta1\nbeta2\nbeta3\n", "utf-8");
      await writeFile(join(dir, "evil.txt"), "gamma\n", "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-multi-gates" } };
      const command = "grep -n 3 a.txt b.txt";
      // WHY: forged content on a's line 3 — the disk witness refuses the whole serve.
      expect(
        await bashResult(handler!, command, ctx, "a.txt:3:forged\nb.txt:3:beta3\n"),
      ).toBeUndefined();
      // WHY: a triple naming a file outside the operand set (alias/escape forgery).
      expect(
        await bashResult(handler!, command, ctx, "a.txt:3:alpha3\nevil.txt:1:gamma\n"),
      ).toBeUndefined();
      // WHY: mixed single + triple geometry is never the admitted shape.
      expect(await bashResult(handler!, command, ctx, "3:alpha3\nb.txt:3:beta3\n")).toBeUndefined();
      // WHY: zero leases after every refusal — a's real anchor stays unknown.
      const hashes = await lineHashes("alpha1\nalpha2\nalpha3\n", join(dir, "a.txt"));
      await expect(
        editTool.execute(
          "e0",
          { file: "a.txt", edits: [{ anchor_from: hashes[2]!, anchor_to: hashes[2]!, text: "X" }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("serves exactly the total match cap across files and passes one over it through raw", async () => {
    await withTempDir("bash-multi-", async (dir) => {
      const make = (n: number) =>
        Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n") + "\n";
      await writeFile(join(dir, "a.txt"), make(30), "utf-8");
      await writeFile(join(dir, "b.txt"), make(20), "utf-8");
      await writeFile(join(dir, "c.txt"), "line1\n", "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const handler = handlers.get("tool_result");
      const rows50 =
        [
          ...Array.from({ length: 30 }, (_, i) => `a.txt:${i + 1}:line${i + 1}`),
          ...Array.from({ length: 20 }, (_, i) => `b.txt:${i + 1}:line${i + 1}`),
        ].join("\n") + "\n";
      const atCap = await bashResult(
        handler!,
        "grep -n line a.txt b.txt",
        { cwd: dir, sessionManager: { getSessionId: () => "bash-multi-cap" } },
        rows50,
      );
      expect(atCap).toBeDefined();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-multi-over" } };
      // WHY: SEARCH_MAX_MATCHES is the TOTAL budget across files — 51 rows pass raw whole.
      const over = `${rows50}c.txt:1:line1\n`;
      expect(
        await bashResult(handler!, "grep -n line a.txt b.txt c.txt", ctx, over),
      ).toBeUndefined();
      const hashes = await lineHashes(make(30), join(dir, "a.txt"));
      await expect(
        editTool.execute(
          "e0",
          { file: "a.txt", edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "X" }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("walks an explicit dir but never node_modules or hidden dirs (present-but-unwalked)", async () => {
    await withTempDir("bash-walk-", async (dir) => {
      await mkdir(join(dir, "sub", "node_modules", "dep"), { recursive: true });
      await mkdir(join(dir, "sub", ".hidden"), { recursive: true });
      await writeFile(join(dir, "sub", "ok.txt"), "line1\nline2\n", "utf-8");
      // WHY: the excluded files EXIST with matching content — the walk exclusion, not a missing
      // WHY: file, is what refuses the lease.
      await writeFile(
        join(dir, "sub", "node_modules", "dep", "leak.txt"),
        "line1\nline2\n",
        "utf-8",
      );
      await writeFile(join(dir, "sub", ".hidden", "s.txt"), "line1\n", "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const handler = handlers.get("tool_result");
      const good = await bashResult(
        handler!,
        "grep -rn line2 sub",
        { cwd: dir, sessionManager: { getSessionId: () => "bash-walk" } },
        "sub/ok.txt:2:line2\n",
      );
      expect(good).toBeDefined();
      expect(good!.content[0]!.text).toContain("[sub/ok.txt (1 match)]");
      // WHY: a triple from the excluded subtree fails the WHOLE serve (zero leases) even though
      // WHY: its bytes match disk.
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-walk-excl" } };
      expect(
        await bashResult(
          handler!,
          "grep -rn line2 sub",
          ctx,
          "sub/ok.txt:2:line2\nsub/node_modules/dep/leak.txt:2:line2\n",
        ),
      ).toBeUndefined();
      const leakHashes = await lineHashes(
        "line1\nline2\n",
        join(dir, "sub", "node_modules", "dep", "leak.txt"),
      );
      await expect(
        editTool.execute(
          "e0",
          {
            file: "sub/node_modules/dep/leak.txt",
            edits: [{ anchor_from: leakHashes[1]!, anchor_to: leakHashes[1]!, text: "X" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("upgrades an rg directory operand to the walk, while grep's stays raw", async () => {
    await withTempDir("bash-walk-", async (dir) => {
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "sub", "ok.txt"), "line1\nline2\n", "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-rg-dir" } };
      const served = await bashResult(
        handler!,
        "rg --line-number line2 sub",
        ctx,
        "sub/ok.txt:2:line2\n",
      );
      expect(served).toBeDefined();
      expect(served!.content[0]!.text).toContain("[sub/ok.txt (1 match)]");
      // WHY: grep needs its explicit `-r`; a bare directory operand stays raw (native grep
      // WHY: errors on a directory, and this seam must not "helpfully" walk it).
      expect(
        await bashResult(handler!, "grep -n line2 sub", ctx, "grep: sub: Is a directory\n"),
      ).toBeUndefined();
    });
  });

  it("serves rg --files as an anchorless, existence-checked list with no leases", async () => {
    await withTempDir("bash-files-", async (dir) => {
      await writeFile(join(dir, "a.txt"), "x\n", "utf-8");
      await writeFile(join(dir, "b.txt"), "y\n", "utf-8");
      const { pi, handlers, handlersAll, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-files" } };
      // WHY: no injection for a path list — the command reaches bash byte-identical.
      const call = { toolName: "bash", input: { command: "rg --files" } };
      for (const handler of handlersAll.get("tool_call") ?? []) await handler(call, ctx);
      expect(call.input.command).toBe("rg --files");
      const result = await bashResult(
        handlers.get("tool_result")!,
        call.input.command,
        ctx,
        "a.txt\nb.txt\n",
      );
      expect(result).toBeDefined();
      expect(result!.content[0]!.text.startsWith("[Bash file list (no anchors)]\n")).toBe(true);
      expect(rowsOf(result!.content[0]!.text)).toHaveLength(0);
      // WHY: anchorless means anchorless — even a valid content anchor grants nothing.
      const hashes = await lineHashes("x\n", join(dir, "a.txt"));
      await expect(
        editTool.execute(
          "e0",
          { file: "a.txt", edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "X" }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
      // WHY: a listed entry that does not exist on disk fails the whole list closed (invariant 2).
      expect(
        await bashResult(handlers.get("tool_result")!, "rg --files", ctx, "a.txt\nghost.txt\n"),
      ).toBeUndefined();
      // WHY: the same count cap bounds the list — 11 entries pass the whole output through raw.
      const eleven = Array.from({ length: 11 }, (_, i) => `f${i}.txt`).join("\n") + "\n";
      expect(
        await bashResult(handlers.get("tool_result")!, "rg --files", ctx, eleven),
      ).toBeUndefined();
    });
  });
});

describe("bash line-set consumer lifecycle (Tier-3 item 11)", () => {
  it("serves `sort -u` sorted, holding each surviving line's original anchor", async () => {
    await withTempDir("bash-lineset-", async (dir) => {
      const content = "beta\nalpha\nbeta\ngamma\n";
      await writeFile(join(dir, "f.txt"), content, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-lineset-sortu" } };
      const result = await bashResult(
        handlers.get("tool_result")!,
        "cat f.txt | sort -u",
        ctx,
        "alpha\nbeta\ngamma\n",
      );
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text.startsWith("[Bash view: ")).toBe(true);
      expect(text).toContain("[Bash view: f.txt (3 lines, sorted)]");
      const rows = rowsOf(text);
      expect(rows.map((row) => row.split("\u2502")[1])).toEqual(["alpha", "beta", "gamma"]);
      // WHY: coordinates travel WITH the row — the surviving `beta` is file line 1 (the FIRST
      // WHY: occurrence), so it holds line 1's anchor even though it renders second, and the
      // WHY: duplicate line 3 was deduped away so its anchor was never leased.
      const allHashes = await lineHashes(content, join(dir, "f.txt"));
      expect(anchorFor(rows, "beta")).toBe(allHashes[0]);
      expect(anchorFor(rows, "alpha")).toBe(allHashes[1]);
      expect(anchorFor(rows, "gamma")).toBe(allHashes[3]);
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[2]!, anchor_to: allHashes[2]!, text: "X" }],
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
              anchor_from: anchorFor(rows, "beta"),
              anchor_to: anchorFor(rows, "beta"),
              text: "BETA",
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

  it("collapses adjacent runs only for `uniq`, keeping each run head's own anchor", async () => {
    await withTempDir("bash-lineset-", async (dir) => {
      const content = "x\nx\ny\nx\n";
      await writeFile(join(dir, "f.txt"), content, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-lineset-uniq" } };
      const result = await bashResult(
        handlers.get("tool_result")!,
        "cat f.txt | uniq",
        ctx,
        "x\ny\nx\n",
      );
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text).toContain("[Bash view: f.txt (3 lines, adjacent-dedup)]");
      const rows = rowsOf(text);
      expect(rows.map((row) => row.split("\u2502")[1])).toEqual(["x", "y", "x"]);
      // WHY: `uniq` never sorts — the SECOND `x` run (file line 4) survives beside the first,
      // WHY: and each run head carries its own true line. Line 2 was the collapsed twin.
      const allHashes = await lineHashes(content, join(dir, "f.txt"));
      expect(rows[0]!.split("\u2502")[0]).toBe(allHashes[0]);
      expect(rows[1]!.split("\u2502")[0]).toBe(allHashes[2]);
      expect(rows[2]!.split("\u2502")[0]).toBe(allHashes[3]);
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[1]!, anchor_to: allHashes[1]!, text: "X" }],
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
              anchor_from: anchorFor(rows, "y"),
              anchor_to: anchorFor(rows, "y"),
              text: "Y",
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

  it("serves `wc -l` as a checkable count over every counted row, in file order", async () => {
    await withTempDir("bash-lineset-", async (dir) => {
      const content = numberedLines(5);
      await writeFile(join(dir, "f.txt"), content, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-lineset-count" } };
      // WHY: both count spellings are accepted (`4\n` piped, padded when GNU names a
      // WHY: file), so the padded observed bytes are a legal count.
      const result = await bashResult(
        handlers.get("tool_result")!,
        "cat f.txt | grep -v line3 | wc -l",
        ctx,
        "   4\n",
      );
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text).toContain("[Bash view: f.txt (count: 4)]");
      const rows = rowsOf(text);
      expect(rows.map((row) => row.split("\u2502")[1])).toEqual([
        "line1",
        "line2",
        "line4",
        "line5",
      ]);
      // WHY: the number is checkable because EVERY counted row is leased from the re-read
      // WHY: snapshot (file order, true coordinates) while the dropped line grants nothing.
      const allHashes = await lineHashes(content, join(dir, "f.txt"));
      expect(rows[3]!.split("\u2502")[0]).toBe(allHashes[4]);
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[2]!, anchor_to: allHashes[2]!, text: "X" }],
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
              anchor_from: anchorFor(rows, "line4"),
              anchor_to: anchorFor(rows, "line4"),
              text: "LINE4",
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

  it("accepts both `wc -l` output spellings and refuses any other number", async () => {
    await withTempDir("bash-lineset-", async (dir) => {
      const content = numberedLines(3);
      await writeFile(join(dir, "f.txt"), content, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const handler = handlers.get("tool_result");
      const run = (session: string, stdout: string) =>
        bashResult(
          handler!,
          "cat f.txt | wc -l",
          { cwd: dir, sessionManager: { getSessionId: () => session } },
          stdout,
        );
      const plain = await run("bash-lineset-count-plain", "3\n");
      expect(plain).toBeDefined();
      expect(plain!.content[0]!.text).toContain("[Bash view: f.txt (count: 3)]");
      expect(await run("bash-lineset-count-padded", "  3\n")).toBeDefined();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-lineset-count-gates" } };
      // WHY: every other observed shape refuses the WHOLE serve with zero leases — a number the
      // WHY: fold does not produce, a trailing extra field, a non-numeric line, a negative and
      // WHY: an empty stdout (the count gate never manufactures a number).
      for (const stdout of ["4\n", "3 4\n", "three\n", "-3\n", ""]) {
        expect(await bashResult(handler!, "cat f.txt | wc -l", ctx, stdout)).toBeUndefined();
      }
      const allHashes = await lineHashes(content, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[0]!, anchor_to: allHashes[0]!, text: "X" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("folds stage order: sort-then-head differs from head-then-sort", async () => {
    await withTempDir("bash-lineset-", async (dir) => {
      const content = "c\na\nb\na\n";
      await writeFile(join(dir, "f.txt"), content, "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const allHashes = await lineHashes(content, join(dir, "f.txt"));
      // WHY: the sorted stream is what the NEXT stage sees, so sort-then-head keeps a(2) and
      // WHY: b(3) while head-then-sort keeps c(1) and a(2) — same command words, other rows.
      const sortedFirst = await bashResult(
        handler!,
        "cat f.txt | sort -u | head -2",
        { cwd: dir, sessionManager: { getSessionId: () => "bash-lineset-order-a" } },
        "a\nb\n",
      );
      expect(sortedFirst).toBeDefined();
      const sortedRows = rowsOf(sortedFirst!.content[0]!.text);
      expect(sortedRows.map((row) => row.split("\u2502")[1])).toEqual(["a", "b"]);
      expect(sortedRows[0]!.split("\u2502")[0]).toBe(allHashes[1]);
      expect(sortedRows[1]!.split("\u2502")[0]).toBe(allHashes[2]);
      const headFirst = await bashResult(
        handler!,
        "cat f.txt | head -2 | sort -u",
        { cwd: dir, sessionManager: { getSessionId: () => "bash-lineset-order-b" } },
        "a\nc\n",
      );
      expect(headFirst).toBeDefined();
      const headRows = rowsOf(headFirst!.content[0]!.text);
      expect(headRows.map((row) => row.split("\u2502")[1])).toEqual(["a", "c"]);
      expect(headRows[0]!.split("\u2502")[0]).toBe(allHashes[1]);
      expect(headRows[1]!.split("\u2502")[0]).toBe(allHashes[0]);
      // WHY: the named pair agrees — dropping then sorting is the same set in the same order as
      // WHY: sorting then dropping — and both keep b(3) and c(1) as the surviving rows.
      for (const [session, command] of [
        ["bash-lineset-order-c", "cat f.txt | grep -v a | sort -u"],
        ["bash-lineset-order-d", "cat f.txt | sort -u | grep -v a"],
      ] as const) {
        const served = await bashResult(
          handler!,
          command,
          { cwd: dir, sessionManager: { getSessionId: () => session } },
          "b\nc\n",
        );
        expect(served).toBeDefined();
        const rows = rowsOf(served!.content[0]!.text);
        expect(rows.map((row) => row.split("\u2502")[1])).toEqual(["b", "c"]);
        expect(rows[0]!.split("\u2502")[0]).toBe(allHashes[2]);
        expect(rows[1]!.split("\u2502")[0]).toBe(allHashes[0]);
      }
    });
  });

  it("passes a consumer over the row cap through raw with zero leases", async () => {
    await withTempDir("bash-lineset-", async (dir) => {
      const over =
        Array.from(
          { length: SEARCH_MAX_MATCHES + 1 },
          (_, i) => `u${String(i).padStart(3, "0")}`,
        ).join("\n") + "\n";
      await writeFile(join(dir, "f.txt"), over, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-lineset-cap" } };
      // WHY: SEARCH_MAX_MATCHES bounds a consumer exactly as it bounds a search or filter — one
      // WHY: row over the cap passes the WHOLE output through raw, never a truncated render.
      expect(await bashResult(handler!, "cat f.txt | sort -u", ctx, over)).toBeUndefined();
      expect(
        await bashResult(handler!, "cat f.txt | wc -l", ctx, `${SEARCH_MAX_MATCHES + 1}\n`),
      ).toBeUndefined();
      const allHashes = await lineHashes(over, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[0]!, anchor_to: allHashes[0]!, text: "X" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("refuses a render the disk fold does not reproduce, with zero leases", async () => {
    await withTempDir("bash-lineset-", async (dir) => {
      const content = "beta\nalpha\nbeta\n";
      await writeFile(join(dir, "f.txt"), content, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-lineset-gates" } };
      // WHY: each of these claims a row set the disk fold does not produce — a foreign row, the
      // WHY: file's own order instead of byte order, and a duplicated survivor.
      for (const stdout of ["alpha\ngamma\n", "beta\nalpha\n", "alpha\nalpha\nbeta\n"]) {
        expect(await bashResult(handler!, "cat f.txt | sort -u", ctx, stdout)).toBeUndefined();
      }
      const allHashes = await lineHashes(content, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[0]!, anchor_to: allHashes[0]!, text: "X" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("passes an empty fold through raw instead of rendering a count over no rows", async () => {
    await withTempDir("bash-lineset-", async (dir) => {
      const content = numberedLines(5);
      await writeFile(join(dir, "f.txt"), content, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-lineset-empty" } };
      // WHY: a `wc -l` whose fold kept nothing has no row to lease, so the whole stdout passes
      // WHY: through — a bare `[f.txt (count: 0)]` header would claim a ledger it cannot honour.
      expect(
        await bashResult(handler!, "cat f.txt | grep -v line | wc -l", ctx, "0\n"),
      ).toBeUndefined();
      expect(
        await bashResult(handler!, "cat f.txt | grep -v line | sort -u", ctx, ""),
      ).toBeUndefined();
      const allHashes = await lineHashes(content, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[0]!, anchor_to: allHashes[0]!, text: "X" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });
});

describe("bash Tier-3 hardening (walk bounds and boundary twins)", () => {
  it("never admits a symlinked entry, and resolves a symlinked operand shared", async () => {
    await withTempDir("bash-hard-", async (dir) => {
      await mkdir(join(dir, "real"), { recursive: true });
      await writeFile(join(dir, "real", "ok.txt"), "line1\nline2\n", "utf-8");
      await symlink(join(dir, "real"), join(dir, "linked"), "dir");
      await symlink(join(dir, "real", "ok.txt"), join(dir, "link-file.txt"), "file");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-hard-symlink" } };
      // WHY: the OPERAND goes through the shared target resolver — the path authority every other
      // WHY: seam uses, which resolves symlink components on purpose — so a symlinked root is
      // WHY: walked as its target and the served display path stays editable through that resolver.
      const viaRoot = await bashResult(
        handler!,
        "grep -rn line2 linked",
        ctx,
        "linked/ok.txt:2:line2\n",
      );
      expect(viaRoot).toBeDefined();
      expect(viaRoot!.content[0]!.text).toContain("[linked/ok.txt (1 match)]");
      // WHY: the walk never admits a symlink ENTRY (a `Dirent` is not followed) but the seam
      // WHY: matches a stdout entry by RESOLVED identity, so a spelling that resolves into the
      // WHY: walked set serves the walked file's own display path and true line — the bytes are
      // WHY: verified against that file, and the render never echoes the link spelling.
      const viaEntry = await bashResult(
        handler!,
        "grep -rn line2 .",
        ctx,
        "link-file.txt:2:line2\n",
      );
      expect(viaEntry).toBeDefined();
      expect(viaEntry!.content[0]!.text).toContain("[real/ok.txt (1 match)]");
      // WHY: an entry that resolves OUTSIDE the walked set still fails the whole serve closed.
      await writeFile(join(dir, "other.txt"), "line1\nline2\n", "utf-8");
      expect(
        await bashResult(handler!, "grep -rn line2 real", ctx, "other.txt:2:line2\n"),
      ).toBeUndefined();
      // WHY: the real tree still serves — the refusals above are about links, not about walking.
      const good = await bashResult(handler!, "grep -rn line2 real", ctx, "real/ok.txt:2:line2\n");
      expect(good).toBeDefined();
      expect(good!.content[0]!.text).toContain("[real/ok.txt (1 match)]");
    });
  });

  it("bounds the walk by directories queued when a forest holds no files", async () => {
    await withTempDir("bash-hard-", async (dir) => {
      // WHY: review F4 — the visit bound must trip on a directory-only forest, where the file
      // WHY: counter never moves.
      for (let i = 0; i < 250; i++) await mkdir(join(dir, "d", `n${i}`), { recursive: true });
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-hard-dirs" } };
      expect(
        await bashResult(handlers.get("tool_result")!, "grep -rn zz d", ctx, "d/n1/x.txt:1:zz\n"),
      ).toBeUndefined();
    });
  });

  it("bounds the walk by files visited past the visit cap", async () => {
    await withTempDir("bash-hard-", async (dir) => {
      for (let i = 0; i < 205; i++) {
        await writeFile(join(dir, `f${i}.txt`), "line1\nline2\n", "utf-8");
      }
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-hard-files" } };
      expect(
        await bashResult(handlers.get("tool_result")!, "grep -rn line2 .", ctx, "f1.txt:2:line2\n"),
      ).toBeUndefined();
    });
  });

  it("honors an explicitly named excluded root and still skips a nested one", async () => {
    await withTempDir("bash-hard-", async (dir) => {
      await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
      await writeFile(join(dir, "node_modules", "top.txt"), "line1\nline2\n", "utf-8");
      await writeFile(join(dir, "node_modules", "dep", "deep.txt"), "line1\nline2\n", "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const handler = handlers.get("tool_result");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-hard-nm" } };
      // WHY: the exclusion gates DESCENT, not the operand — naming the root admits it whole,
      // WHY: including the subtree below it.
      const deep = await bashResult(
        handler!,
        "grep -rn line2 node_modules",
        ctx,
        "node_modules/dep/deep.txt:2:line2\n",
      );
      expect(deep).toBeDefined();
      expect(deep!.content[0]!.text).toContain("[node_modules/dep/deep.txt (1 match)]");
      // WHY: a `node_modules` seen while walking ANOTHER root is skipped (the nested case).
      await mkdir(join(dir, "other", "node_modules"), { recursive: true });
      await writeFile(join(dir, "other", "node_modules", "nested.txt"), "line1\nline2\n", "utf-8");
      await writeFile(join(dir, "other", "ok.txt"), "line1\nline2\n", "utf-8");
      expect(
        await bashResult(
          handler!,
          "grep -rn line2 other",
          ctx,
          "other/ok.txt:2:line2\nother/node_modules/nested.txt:2:line2\n",
        ),
      ).toBeUndefined();
    });
  });

  it("refuses an `rg --files` entry that is a directory", async () => {
    await withTempDir("bash-hard-", async (dir) => {
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "a.txt"), "x\n", "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-hard-listdir" } };
      // WHY: only regular files enter the walk's membership, so a directory entry (which native
      // WHY: `rg --files` never prints) fails the whole list closed.
      expect(
        await bashResult(handlers.get("tool_result")!, "rg --files", ctx, "a.txt\nsub\n"),
      ).toBeUndefined();
    });
  });

  it("passes a composed multi-range sed through raw (recorded boundary)", async () => {
    await withTempDir("bash-hard-", async (dir) => {
      await writeFile(join(dir, "f.txt"), numberedLines(40), "utf-8");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "bash-hard-sed" } };
      // WHY: review F6 — the two `range` ops are COMPOSED by the interval algebra, so the second
      // WHY: selection resolves against the already-narrowed stream, selects nothing and passes
      // WHY: the raw output through. Never a wrong slice; recorded in ADR-0033 D10.
      expect(
        await bashResult(
          handlers.get("tool_result")!,
          "cat f.txt | sed -n -e '1p' -e '30p'",
          ctx,
          "line1\nline30\n",
        ),
      ).toBeUndefined();
    });
  });
});

describe("bash view — pureView section banners (#134)", () => {
  // WHY: the read tool's own per-window header. The bash view renders through a one-element window
  // WHY: array, so it used to inherit this string as its file banner; that is the defect fixed here.
  const READ_HEADER = /^\[Lines \d+-\d+ of \d+ total\]$/;
  const catNumberedLocal = (text: string): string =>
    `${text
      .split("\n")
      .filter((l) => l !== "")
      .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
      .join("\n")}\n`;

  const drive = async (
    dir: string,
    body: Record<string, string>,
    command: string,
    stdout: string,
    session: string,
  ) => {
    for (const [name, text] of Object.entries(body)) {
      const full = join(dir, name);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, text, "utf-8");
    }
    const { pi, handlers } = makeFakePi();
    register(pi);
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => session } };
    const result = await bashResult(handlers.get("tool_result")!, command, ctx, stdout);
    return result?.content[0]?.text;
  };

  it("A1 — a whole-file `cat` names the file and its line count", async () => {
    await withTempDir("bash-view-", async (dir) => {
      const body = numberedLines(30);
      const text = await drive(dir, { "f.txt": body }, "cat f.txt", body, "bv-a1");
      expect(text).toBeDefined();
      const lines = text!.split("\n");
      expect(lines[0]).toBe("[Bash view: f.txt (30 lines total)]");
      expect(lines[1]).toMatch(/│line1$/);
      expect(READ_HEADER.test(lines[0]!)).toBe(false);
      expect(text!.split("\n").some((l) => READ_HEADER.test(l))).toBe(false);
    });
  });

  it("A1 / D5 — `cat -n` takes the same full-file banner, with no special case", async () => {
    await withTempDir("bash-view-", async (dir) => {
      const body = numberedLines(10);
      const text = await drive(
        dir,
        { "f.txt": body },
        "cat -n f.txt",
        catNumberedLocal(body),
        "bv-a1n",
      );
      expect(text!.split("\n")[0]).toBe("[Bash view: f.txt (10 lines total)]");
    });
  });

  it("A2 — a one-line file reads singular", async () => {
    await withTempDir("bash-view-", async (dir) => {
      const text = await drive(dir, { "one.txt": "line1\n" }, "cat one.txt", "line1\n", "bv-a2");
      expect(text!.split("\n")[0]).toBe("[Bash view: one.txt (1 lines total)]");
    });
  });

  it("A3 — `head -n 2` banners the range it covered", async () => {
    await withTempDir("bash-view-", async (dir) => {
      const body = numberedLines(30);
      const head2 = `${body.split("\n").slice(0, 2).join("\n")}\n`;
      const text = await drive(dir, { "f.txt": body }, "head -n 2 f.txt", head2, "bv-a3");
      expect(text!.split("\n")[0]).toBe("[Bash view: f.txt (lines 1-2 of 30 total)]");
    });
  });

  it("A4 — `sed -n '5,10p'` banners its range", async () => {
    await withTempDir("bash-view-", async (dir) => {
      const body = numberedLines(30);
      const slice = `${body.split("\n").slice(4, 10).join("\n")}\n`;
      const text = await drive(dir, { "f.txt": body }, "sed -n '5,10p' f.txt", slice, "bv-a4a");
      expect(text!.split("\n")[0]).toBe("[Bash view: f.txt (lines 5-10 of 30 total)]");
    });
  });

  it("A4 — `tail -n 15` banners the tail range", async () => {
    await withTempDir("bash-view-", async (dir) => {
      const body = numberedLines(30);
      const tail = `${body.split("\n").slice(15, 30).join("\n")}\n`;
      const text = await drive(dir, { "f.txt": body }, "tail -n 15 f.txt", tail, "bv-a4b");
      expect(text!.split("\n")[0]).toBe("[Bash view: f.txt (lines 16-30 of 30 total)]");
    });
  });

  it("A4 — a single-line `sed -n '5p'` still says `lines 5-5`", async () => {
    await withTempDir("bash-view-", async (dir) => {
      const body = numberedLines(30);
      const text = await drive(
        dir,
        { "f.txt": body },
        "sed -n '5p' f.txt",
        `${body.split("\n")[4]}\n`,
        "bv-a4c",
      );
      expect(text!.split("\n")[0]).toBe("[Bash view: f.txt (lines 5-5 of 30 total)]");
    });
  });

  it("A5 — a merged multi-range sed banners the union once", async () => {
    await withTempDir("bash-view-", async (dir) => {
      // WHY: overlapping `-e` ranges merge at parse (Tier-2 item 7) to ONE interval, so the
      // WHY: union carries a single banner — the policy is per section, but no bash command
      // WHY: can produce two sections (see the disjoint case below). Asserting the union's own
      // WHY: range, not an inherited window header.
      const body = numberedLines(30);
      const union = `${Array.from({ length: 5 }, (_, i) => `line${i + 16}`).join("\n")}\n`;
      const text = await drive(
        dir,
        { "f.txt": body },
        "sed -n -e '16,18p' -e '17,20p' f.txt",
        union,
        "bv-a5",
      );
      expect(text!.split("\n")[0]).toBe("[Bash view: f.txt (lines 16-20 of 30 total)]");
      expect(text!.split("\n").some((l) => READ_HEADER.test(l))).toBe(false);
    });
  });

  it("A5 boundary — a DISJOINT multi-range sed fails closed (no two-section view exists)", async () => {
    await withTempDir("bash-view-", async (dir) => {
      // WHY (§7.9): `applySliceOps` folds `range` ops by intersection, so two disjoint ranges
      // WHY: yield zero intervals and the gate passes the raw stdout through — there is no
      // WHY: reachable two-window bash view in this code. This pins that fail-closed boundary
      // WHY: rather than a two-banner rendering that cannot occur.
      const body = numberedLines(30);
      const stdout = "line5\nline6\nline10\nline11\n";
      const text = await drive(
        dir,
        { "f.txt": body },
        "sed -n -e '5,6p' -e '10,11p' f.txt",
        stdout,
        "bv-a5b",
      );
      expect(text).toBeUndefined();
    });
  });

  it("A6 — an over-budget slice still declines interception", async () => {
    await withTempDir("bash-view-", async (dir) => {
      // WHY: raw stdout fits the bash byte budget, but the anchors the view would serve do not fit
      // WHY: the preview budget — the D3 gate must still send it through raw, with zero leases.
      const big = `${Array.from({ length: 1500 }, (_, i) => `line${i + 1}`.padEnd(40, ".")).join("\n")}\n`;
      const slice = `${big.split("\n").slice(0, 1200).join("\n")}\n`;
      const text = await drive(dir, { "big.txt": big }, "head -n 1200 big.txt", slice, "bv-a6");
      expect(text).toBeUndefined();
    });
  });

  it("A7 — the banner names the caller's path, not the resolved one", async () => {
    await withTempDir("bash-view-", async (dir) => {
      const body = numberedLines(30);
      const head2 = `${body.split("\n").slice(0, 2).join("\n")}\n`;
      const pure = await drive(dir, { "sub/f.txt": body }, "head -n 2 sub/f.txt", head2, "bv-a7a");
      const piped = await drive(
        dir,
        { "sub/f.txt": body },
        "cat sub/f.txt | head -n 2",
        head2,
        "bv-a7b",
      );
      // WHY: the page header is the first line, so that is what names the caller's path.
      const pathOf = (t: string) => /^\[Bash view: ([^\]]*?) \(/.exec(t.split("\n")[0]!)?.[1];
      expect(pathOf(pure!)).toBe("sub/f.txt");
      expect(pathOf(piped!)).toBe(pathOf(pure!));
      expect(pure!.split("\n")[0]).not.toContain(dir);
    });
  });

  it("A9 — an empty file is not intercepted at all", async () => {
    await withTempDir("bash-view-", async (dir) => {
      const text = await drive(dir, { "empty.txt": "" }, "cat empty.txt", "", "bv-a9");
      expect(text).toBeUndefined();
    });
  });
});
describe("bash search — pipelined head/tail slices (#135 W1)", () => {
  const driveSearch = async (
    dir: string,
    body: string,
    command: string,
    stdout: string,
    session: string,
  ) => {
    await writeFile(join(dir, "f.txt"), body, "utf-8");
    const { pi, handlers, getTool } = makeFakePi();
    register(pi);
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => session } };
    const result = await bashResult(handlers.get("tool_result")!, command, ctx, stdout);
    return { text: result?.content[0]?.text, editTool: getTool("edit"), ctx };
  };

  it("leases exactly the head-sliced matches at their original lines", async () => {
    await withTempDir("bash-search-", async (dir) => {
      const body = numberedLines(10);
      const { text, editTool, ctx } = await driveSearch(
        dir,
        body,
        'grep -n "line" f.txt | rtk head -2',
        "1:line1\n2:line2\n",
        "w1-head",
      );
      expect(text).toBeDefined();
      expect(text).toContain("[f.txt (2 matches)]");
      const rows = rowsOf(text!);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.endsWith("│line1")).toBe(true);
      expect(rows[1]!.endsWith("│line2")).toBe(true);
      // WHY: F4 — file line 5 matched but was sliced away; its valid anchor carries no lease.
      const allHashes = await lineHashes(body, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[4]!, anchor_to: allHashes[4]!, text: "L5" }],
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
      expect(ok.isError).toBeFalsy();
    });
  });

  it("tail slicing keeps the last matches with original numbers", async () => {
    await withTempDir("bash-search-", async (dir) => {
      const body = numberedLines(10);
      const { text, editTool, ctx } = await driveSearch(
        dir,
        body,
        'grep -n "line" f.txt | rtk tail -2',
        "9:line9\n10:line10\n",
        "w1-tail",
      );
      expect(text).toBeDefined();
      expect(text).toContain("[f.txt (2 matches)]");
      const rows = rowsOf(text!);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.endsWith("│line9")).toBe(true);
      expect(rows[1]!.endsWith("│line10")).toBe(true);
      // WHY: F4 — file line 1 matched but was sliced away; its valid anchor carries no lease.
      const allHashes = await lineHashes(body, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[0]!, anchor_to: allHashes[0]!, text: "L1" }],
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
              anchor_from: anchorFor(rows, "line10"),
              anchor_to: anchorFor(rows, "line10"),
              text: "LINE10",
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

  it("a head-plus-tail chain folds left to right over matches", async () => {
    await withTempDir("bash-search-", async (dir) => {
      const body = numberedLines(10);
      const { text } = await driveSearch(
        dir,
        body,
        'grep -n "line" f.txt | rtk head -5 | rtk tail -2',
        "4:line4\n5:line5\n",
        "w1-chain",
      );
      expect(text).toBeDefined();
      expect(text).toContain("[f.txt (2 matches)]");
      const rows = rowsOf(text!);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.endsWith("│line4")).toBe(true);
      expect(rows[1]!.endsWith("│line5")).toBe(true);
    });
  });

  it("a zero-count slice declines instead of leasing nothing", async () => {
    await withTempDir("bash-search-", async (dir) => {
      const body = numberedLines(10);
      const { text } = await driveSearch(
        dir,
        body,
        'grep -n "line" f.txt | rtk head -0',
        "",
        "w1-zero",
      );
      expect(text).toBeUndefined();
    });
  });
});
describe("bash compound envelope (#135 C4)", () => {
  const SEARCH_HEAD = "[Bash search (anchors)]";
  const catNumberedLocal = (text: string): string =>
    `${text
      .split("\n")
      .filter((l) => l !== "")
      .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
      .join("\n")}\n`;
  const driveCompound = async (
    dir: string,
    files: Record<string, string>,
    command: string,
    stdout: string,
    session: string,
  ) => {
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(dir, name), text, "utf-8");
    }
    const { pi, handlers, getTool } = makeFakePi();
    register(pi);
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => session } };
    const result = await bashResult(handlers.get("tool_result")!, command, ctx, stdout);
    return { text: result?.content[0]?.text, editTool: getTool("edit"), ctx };
  };
  const matchRows = (from: number, to: number): string =>
    `${Array.from({ length: to - from + 1 }, (_, i) => `${from + i}:line${from + i}`).join("\n")}\n`;

  it("W5a — anchors the motivating compound: redundant cd, banner, two pipelined searches", async () => {
    await withTempDir("bash-compound-", async (dir) => {
      const body = numberedLines(10);
      const stdout = `=== header ===\n${matchRows(1, 3)}${matchRows(1, 5)}`;
      const { text, editTool, ctx } = await driveCompound(
        dir,
        { "f.txt": body },
        'cd . && printf "=== header ===\n"; grep -n "line" f.txt | head -3; grep -n "line" f.txt | head -5',
        stdout,
        "w5a",
      );
      expect(text).toBeDefined();
      const lines = text!.split("\n");
      expect(lines[0]).toBe("=== header ===");
      expect(lines[1]).toBe(SEARCH_HEAD);
      expect(lines[2]).toBe("[f.txt (3 matches)]");
      const rows = rowsOf(text!);
      expect(rows).toHaveLength(8);
      // WHY: every observed match row is anchored (none leak through raw).
      expect(rows.filter((l) => l.endsWith("│line1")).length).toBe(2);
      // WHY: leases cover exactly the served survivors in both blocks.
      const allHashes = await lineHashes(body, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[5]!, anchor_to: allHashes[5]!, text: "L6" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
      const ok2 = await editTool.execute(
        "e1",
        {
          file: "f.txt",
          edits: [
            {
              anchor_from: anchorFor(rows, "line2"),
              anchor_to: anchorFor(rows, "line2"),
              text: "L2",
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(ok2.isError).toBeFalsy();
    });
  });

  it("W5b — a corrupted middle block halts: prefix anchored, rest raw, partial leases", async () => {
    await withTempDir("bash-compound-", async (dir) => {
      const body = numberedLines(10);
      const badTail = "9:zzz\n9:zzz\n9:zzz\n9:zzz\n9:zzz\n";
      const stdout = `=== header ===\n${matchRows(1, 3)}${badTail}`;
      const { text, editTool, ctx } = await driveCompound(
        dir,
        { "f.txt": body },
        'cd . && printf "=== header ===\n"; grep -n "line" f.txt | head -3; grep -n "line" f.txt | head -5',
        stdout,
        "w5b",
      );
      expect(text).toBeDefined();
      // WHY: exactly one search block rendered (the verified prefix); the corrupt tail stays raw.
      expect(text!.split("\n").filter((l) => l === SEARCH_HEAD)).toHaveLength(1);
      expect(text!.split("\n")[2]).toBe("[f.txt (3 matches)]");
      expect(text!.includes("9:zzz")).toBe(true);
      expect(rowsOf(text!).some((l) => l.endsWith("│zzz"))).toBe(false);
      const rows = rowsOf(text!);
      const allHashes = await lineHashes(body, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[3]!, anchor_to: allHashes[3]!, text: "L4" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
      const ok2 = await editTool.execute(
        "e1",
        {
          file: "f.txt",
          edits: [
            {
              anchor_from: anchorFor(rows, "line2"),
              anchor_to: anchorFor(rows, "line2"),
              text: "L2",
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(ok2.isError).toBeFalsy();
    });
  });

  it("W5c — a disk mismatch halts rather than leasing", async () => {
    await withTempDir("bash-compound-", async (dir) => {
      const v1 = numberedLines(10);
      const stdout = `=== header ===\n${matchRows(1, 3)}${matchRows(1, 5)}`;
      await writeFile(join(dir, "f.txt"), v1, "utf-8");
      const v2 = v1.replace("line1\n", "CHANGED1\n");
      await writeFile(join(dir, "f.txt"), v2, "utf-8");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "w5c" } };
      const result = await bashResult(
        handlers.get("tool_result")!,
        'cd . && printf "=== header ===\n"; grep -n "line" f.txt | head -3; grep -n "line" f.txt | head -5',
        ctx,
        stdout,
      );
      expect(result?.content[0]?.text).toBeUndefined();
      const allHashes = await lineHashes(v2, join(dir, "f.txt"));
      await expect(
        getTool("edit").execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[1]!, anchor_to: allHashes[1]!, text: "L2" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("F2 — glue alone (no blocks) returns undefined even when its bytes verify", async () => {
    await withTempDir("bash-compound-", async (dir) => {
      const { text } = await driveCompound(dir, {}, 'printf "a"; printf "b"', "ab", "w5f2");
      expect(text).toBeUndefined();
    });
  });

  it("an empty search renders its banner with zero rows and the peel continues", async () => {
    await withTempDir("bash-compound-", async (dir) => {
      const body = numberedLines(10);
      const stdout = `h\n${matchRows(1, 2)}`;
      const { text, editTool, ctx } = await driveCompound(
        dir,
        { "f.txt": body },
        'printf "h\n"; grep -n "zzz" f.txt | head -5; grep -n "line" f.txt | head -2',
        stdout,
        "w5empty",
      );
      expect(text).toBeDefined();
      expect(text).toContain("[f.txt (0 matches)]");
      expect(text).toContain("[f.txt (2 matches)]");
      const rows = rowsOf(text!);
      expect(rows).toHaveLength(2);
      // WHY: F4 — file line 5 is displayed nowhere (empty block plus head-2 cover only 1-2);
      // WHY: its valid anchor carries no lease. Probed BEFORE any file-modifying edit,
      // WHY: because post-edit grants would enable it (pre-existing engine behavior).
      const allHashes = await lineHashes(body, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[4]!, anchor_to: allHashes[4]!, text: "LX" }],
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
              anchor_from: anchorFor(rows, "line2"),
              anchor_to: anchorFor(rows, "line2"),
              text: "L2",
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

  it("a numbered view anchors inside the envelope", async () => {
    await withTempDir("bash-compound-", async (dir) => {
      const body = numberedLines(10);
      const { text, editTool, ctx } = await driveCompound(
        dir,
        { "f.txt": body },
        'printf "h\n" && cat -n f.txt',
        `h\n${catNumberedLocal(body)}`,
        "w5num",
      );
      expect(text).toBeDefined();
      expect(text!.split("\n")[1]).toBe("[Bash view: f.txt (10 lines total)]");
      expect(rowsOf(text!)).toHaveLength(10);
      const ok = await editTool.execute(
        "e1",
        {
          file: "f.txt",
          edits: [
            {
              anchor_from: anchorFor(rowsOf(text!), "line10"),
              anchor_to: anchorFor(rowsOf(text!), "line10"),
              text: "L10",
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

  it("a lone trailing newline is tolerated, extra bytes halt", async () => {
    await withTempDir("bash-compound-", async (dir) => {
      const body = numberedLines(10);
      const base = `=== header ===\n${matchRows(1, 3)}${matchRows(1, 5)}`;
      const cmd =
        'cd . && printf "=== header ===\n"; grep -n "line" f.txt | head -3; grep -n "line" f.txt | head -5';
      const good = await driveCompound(dir, { "f.txt": body }, cmd, `${base}\n`, "w5nl-ok");
      expect(good.text).toBeDefined();
      expect(good.text).toContain("[f.txt (5 matches)]");
      const bad = await driveCompound(dir, { "f.txt": body }, cmd, `${base}EXTRA`, "w5nl-bad");
      // WHY: D4 partial — both blocks verified before the trailing garbage, so they
      // WHY: stand anchored with their leases while the unverified tail stays raw.
      expect(bad.text).toBeDefined();
      expect(bad.text!.split("\n").filter((l) => l === SEARCH_HEAD)).toHaveLength(2);
      expect(bad.text!.includes("EXTRA")).toBe(true);
      expect(rowsOf(bad.text!).some((l) => l.endsWith("│EXTRA"))).toBe(false);
    });
  });

  it("a view and a search anchor side by side with one base", async () => {
    await withTempDir("bash-compound-", async (dir) => {
      const body = numberedLines(10);
      const head2 = `${body.split("\n").slice(0, 2).join("\n")}\n`;
      const { text, editTool, ctx } = await driveCompound(
        dir,
        { "f.txt": body },
        'printf "h\n" && cat f.txt | head -n 2 && grep -n "line" f.txt | tail -2',
        `h\n${head2}9:line9\n10:line10\n`,
        "w5mix",
      );
      expect(text).toBeDefined();
      expect(text).toContain("[Bash view: f.txt (lines 1-2 of 10 total)]");
      expect(text).toContain("[f.txt (2 matches)]");
      expect(rowsOf(text!)).toHaveLength(4);
      // WHY: F4 — file line 5 sits in the gap (view took 1-2, search took 9-10);
      // WHY: its valid anchor carries no lease. Probed BEFORE any file-modifying edit,
      // WHY: because post-edit grants would enable it (pre-existing engine behavior).
      const allHashes = await lineHashes(body, join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "f.txt",
            edits: [{ anchor_from: allHashes[4]!, anchor_to: allHashes[4]!, text: "LX" }],
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
              anchor_from: anchorFor(rowsOf(text!), "line10"),
              anchor_to: anchorFor(rowsOf(text!), "line10"),
              text: "L10",
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
});

describe("bash serve attribution guards (#175)", () => {
  const drive = async (
    dir: string,
    files: Record<string, string>,
    command: string,
    stdout: string,
    session: string,
  ) => {
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(dir, name), text, "utf-8");
    }
    const { pi, handlers, getTool } = makeFakePi();
    register(pi);
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => session } };
    const result = await bashResult(handlers.get("tool_result")!, command, ctx, stdout);
    return { text: result?.content[0]?.text, editTool: getTool("edit"), ctx };
  };

  it("G1 twin: identical stdout rows from two admitted files fail closed, zero leases", async () => {
    await withTempDir("bash-attr-g1-", async (dir) => {
      // WHY: (ADR-0048 D1 — bash serve admission) never content matching, no other-file anchor bleed — file `a`
      // WHY: line 1 (`b.txt:3:x`) and file `a:1:b.txt` line 3 (`x`) print the identical row
      // WHY: `a:1:b.txt:3:x`, so either coordinate is a guess. Fail closed, zero leases.
      const files = { a: "b.txt:3:x\n", "a:1:b.txt": "y\nz\nx\n" };
      const command = "grep -n x a 'a:1:b.txt'";
      const stdout = "a:1:b.txt:3:x\na:1:b.txt:3:x\n";
      const { text, editTool, ctx } = await drive(dir, files, command, stdout, "attr-g1");
      // WHY: `text` is undefined on pass-through — the twin must not render an anchor block.
      expect(text).toBeUndefined();
      const hashesA = await lineHashes(files.a, join(dir, "a"));
      await expect(
        editTool.execute(
          "e0",
          { file: "a", edits: [{ anchor_from: hashesA[0]!, anchor_to: hashesA[0]!, text: "X" }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("G1 dot root: recursive spelling twin fails closed", async () => {
    await withTempDir("bash-attr-g1d-", async (dir) => {
      // WHY: `admitted` displays are `path.join`-normalized (`a`) while bash echoes the operand
      // WHY: spelling (`./a` for a `.` root) — candidates are resolved, never display-matched,
      // WHY: so the `./a` vs `a:1:b.txt` twin is still ambiguous and fails closed, zero leases.
      const files = { a: "b.txt:3:x\n", "a:1:b.txt": "y\nz\nx\n" };
      const { text, editTool, ctx } = await drive(
        dir,
        files,
        "grep -rn x .",
        "./a:1:b.txt:3:x\n./a:1:b.txt:3:x\n",
        "attr-g1d",
      );
      expect(text).toBeUndefined();
      const hashesA = await lineHashes(files.a, join(dir, "a"));
      await expect(
        editTool.execute(
          "e0",
          { file: "a", edits: [{ anchor_from: hashesA[0]!, anchor_to: hashesA[0]!, text: "X" }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("G1 adjacent control: one admitted split still serves", async () => {
    await withTempDir("bash-attr-g1c-", async (dir) => {
      // WHY: only `a` is admitted, so `a:1:b.txt:3:x` has exactly one resolving split —
      // WHY: the guard is an ambiguity refusal, not a multi-file refusal.
      const { text, editTool, ctx } = await drive(
        dir,
        { a: "b.txt:3:x\n", "other.txt": "q\n" },
        "grep -n x a other.txt",
        "a:1:b.txt:3:x\n",
        "attr-g1c",
      );
      expect(text).toBeDefined();
      const rows = rowsOf(text!);
      expect(rows).toHaveLength(1);
      const ok = await editTool.execute(
        "e1",
        {
          file: "a",
          edits: [
            {
              anchor_from: anchorFor(rows, "b.txt:3:x"),
              anchor_to: anchorFor(rows, "b.txt:3:x"),
              text: "X",
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

  it("G2: descending and duplicated search rows fail closed, ascending serves", async () => {
    // WHY: (serve-seam rule, one served row per file line — ADR-0048, bash serve admission,
    // WHY: states the no-bleed invariant, not an ordering clause) the printed
    // WHY: number is a label whose ORDER is proven by the stream, not by matching content — a
    // WHY: descending or repeated label owns no disjoint ordered intervals and no lease↔row
    // WHY: bijection, even with byte-equal rows.
    await withTempDir("bash-attr-g2-", async (dir) => {
      const files = { "f.txt": numberedLines(3) };
      const { text: desc } = await drive(
        dir,
        files,
        "grep -n line f.txt",
        "3:line3\n1:line1\n",
        "attr-g2d",
      );
      expect(desc).toBeUndefined();
      const {
        text: dup,
        editTool,
        ctx,
      } = await drive(dir, files, "grep -n line f.txt", "2:line2\n2:line2\n", "attr-g2u");
      expect(dup).toBeUndefined();
      const hashes = await lineHashes(numberedLines(3), join(dir, "f.txt"));
      await expect(
        editTool.execute(
          "e0",
          { file: "f.txt", edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "X" }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
    await withTempDir("bash-attr-g2c-", async (dir) => {
      const { text, editTool, ctx } = await drive(
        dir,
        { "f.txt": numberedLines(3) },
        "grep -n line f.txt",
        "1:line1\n2:line2\n",
        "attr-g2c",
      );
      expect(text).toBeDefined();
      const rows = rowsOf(text!);
      const ok = await editTool.execute(
        "e1",
        {
          file: "f.txt",
          edits: [
            {
              anchor_from: anchorFor(rows, "line2"),
              anchor_to: anchorFor(rows, "line2"),
              text: "L2",
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

  it("equal bytes in different compound blocks lease per block, the gap stays unleased", async () => {
    // WHY: (#175) lines 1-2 ARE lines 5-6 byte-for-byte — attribution is by interval, not
    // WHY: content, so each block leases its own lines while lines 3-4 (shown nowhere) refuse.
    // WHY: Two setups: rejection probes always run before the one mutating edit per session,
    // WHY: because leases are snapshot-bound and a success would move the snapshot.
    const body = "s1\ns2\nmid1\nmid2\ns1\ns2\n";
    const command = "printf \"h\\n\"; sed -n '1,2p' f.txt; sed -n '5,6p' f.txt";
    const stdout = "h\ns1\ns2\ns1\ns2\n";
    await withTempDir("bash-attr-eq-", async (dir) => {
      const { text, editTool, ctx } = await drive(
        dir,
        { "f.txt": body },
        command,
        stdout,
        "attr-eq-a",
      );
      expect(text).toBeDefined();
      expect(rowsOf(text!)).toHaveLength(4);
      const allHashes = await lineHashes(body, join(dir, "f.txt"));
      for (const idx of [2, 3]) {
        await expect(
          editTool.execute(
            "e0",
            {
              file: "f.txt",
              edits: [{ anchor_from: allHashes[idx]!, anchor_to: allHashes[idx]!, text: "LX" }],
            },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow("E_UNKNOWN_ANCHOR");
      }
      const rows = rowsOf(text!);
      const ok = await editTool.execute(
        "e1",
        {
          file: "f.txt",
          edits: [
            { anchor_from: anchorFor(rows, "s1"), anchor_to: anchorFor(rows, "s1"), text: "L1" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(ok.isError).toBeFalsy();
    });
    await withTempDir("bash-attr-eq-", async (dir) => {
      // WHY: the second block's own line 5 leases independently of block 1's line 1.
      const { text } = await drive(dir, { "f.txt": body }, command, stdout, "attr-eq-b");
      const rows = rowsOf(text!);
      const anchors = rows.filter((l) => l.endsWith("│s2")).map((l) => l.split("│")[0]!);
      expect(anchors).toHaveLength(2);
      expect(anchors[0]).not.toBe(anchors[1]);
    });
  });

  it("CRLF in a non-leading block is normalized; BOM there fails that block closed", async () => {
    // WHY: (ADR-0033 D9) the whole-observed CRLF/BOM normalization runs before the peel, so a
    // WHY: CRLF block still matches its disk-predicted bytes — while a mid-stream BOM is bytes
    // WHY: the disk prediction never contains, so the peel halts: block 1 keeps its leases,
    // WHY: the BOM block and remainder stay raw (ADR-0039 D4 prefix semantics).
    await withTempDir("bash-attr-crlf-", async (dir) => {
      const { text, editTool, ctx } = await drive(
        dir,
        { "a.txt": "a1\n", "c.txt": "c1\r\nc2\r\n" },
        'printf "h\\n"; cat a.txt; cat c.txt',
        "h\na1\nc1\r\nc2\r\n",
        "attr-crlf",
      );
      expect(text).toBeDefined();
      expect(rowsOf(text!).map((l) => l.split("│").slice(1).join("│"))).toEqual(["a1", "c1", "c2"]);
      const ok = await editTool.execute(
        "e1",
        {
          file: "c.txt",
          edits: [
            {
              anchor_from: anchorFor(rowsOf(text!), "c2"),
              anchor_to: anchorFor(rowsOf(text!), "c2"),
              text: "C2",
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(ok.isError).toBeFalsy();
    });
    await withTempDir("bash-attr-bom2-", async (dir) => {
      const { text, editTool, ctx } = await drive(
        dir,
        { "a.txt": "a1\n", "b.txt": "﻿b1\nb2\n" },
        'printf "h\\n"; cat a.txt; cat b.txt',
        "h\na1\n﻿b1\nb2\n",
        "attr-bom2",
      );
      expect(text).toBeDefined();
      // WHY: only block 1 anchored; the BOM block passes through as raw bytes.
      expect(rowsOf(text!)).toHaveLength(1);
      expect(text!.includes("﻿b1")).toBe(true);
      const hashesB = await lineHashes("﻿b1\nb2\n", join(dir, "b.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "b.txt",
            edits: [{ anchor_from: hashesB[0]!, anchor_to: hashesB[0]!, text: "X" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("a triple without the trailing newline still serves both rows", async () => {
    // WHY: (#175) the lone-trailing-newline tolerance is pop-if, not content matching — an
    // WHY: observed stream ending mid-row still owns two disjoint ordered intervals.
    await withTempDir("bash-attr-nonl3-", async (dir) => {
      const { text, editTool, ctx } = await drive(
        dir,
        { "a.txt": "l1\n", "b.txt": "m1\n" },
        "grep -n 1 a.txt b.txt",
        "a.txt:1:l1\nb.txt:1:m1",
        "attr-nonl3",
      );
      expect(text).toBeDefined();
      expect(rowsOf(text!)).toHaveLength(2);
      const ok = await editTool.execute(
        "e1",
        {
          file: "b.txt",
          edits: [
            {
              anchor_from: anchorFor(rowsOf(text!), "m1"),
              anchor_to: anchorFor(rowsOf(text!), "m1"),
              text: "B",
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

  it("missing trailing newline as the last block and a one-empty-line file both serve", async () => {
    await withTempDir("bash-attr-tail-", async (dir) => {
      // WHY: trailing-newline-only leniency (`joined` vs `joined + "\n"`) covers the last block.
      const { text } = await drive(
        dir,
        { "a.txt": "a1\n", "n.txt": "n1" },
        'printf "h\\n"; cat a.txt; cat n.txt',
        "h\na1\nn1",
        "attr-tail",
      );
      expect(text).toBeDefined();
      expect(rowsOf(text!)).toHaveLength(2);
    });
    await withTempDir("bash-attr-empty1-", async (dir) => {
      const { text, editTool, ctx } = await drive(
        dir,
        { "f.txt": "\n" },
        "cat f.txt",
        "\n",
        "attr-e1",
      );
      expect(text).toBeDefined();
      expect(rowsOf(text!)).toHaveLength(1);
      const rows = rowsOf(text!);
      const ok = await editTool.execute(
        "e1",
        {
          file: "f.txt",
          edits: [
            { anchor_from: rows[0]!.split("│")[0]!, anchor_to: rows[0]!.split("│")[0]!, text: "E" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(ok.isError).toBeFalsy();
    });
  });

  it("content that mimics geometry serves by byte equality, not by parsing content", async () => {
    // WHY: (#175) a `grep -n` row whose text starts `5:foo` and a `cat -n` line whose text
    // WHY: starts `5\tfoo` both serve — the label widths come from counters (leased line digits,
    // WHY: the fixed `%6d\t` field), so mimic content can never shift a split.
    await withTempDir("bash-attr-mimic-", async (dir) => {
      const { text } = await drive(
        dir,
        { "f.txt": "5:foo\nplain\n" },
        "grep -n foo f.txt",
        "1:5:foo\n",
        "attr-mimic-g",
      );
      expect(text).toBeDefined();
      expect(rowsOf(text!).map((l) => l.split("│").slice(1).join("│"))).toEqual(["5:foo"]);
    });
    await withTempDir("bash-attr-mimic-", async (dir) => {
      const { text } = await drive(
        dir,
        { "f.txt": "5\tfoo\nplain\n" },
        "cat -n f.txt",
        "     1\t5\tfoo\n     2\tplain\n",
        "attr-mimic-n",
      );
      expect(text).toBeDefined();
      expect(rowsOf(text!).map((l) => l.split("│").slice(1).join("│"))).toEqual([
        "5\tfoo",
        "plain",
      ]);
    });
  });
});
