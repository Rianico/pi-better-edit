import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { lineHashes } from "../../src/hashline";

import { SEARCH_MAX_MATCHES } from "../../src/constants";
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
      expect(text.startsWith("--- Bash view (hashline anchors) ---\n")).toBe(true);
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
      const logged: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      try {
        process.env.PI_HASHLINE_DEBUG = "1";
        // WHY: observability must never become model-visible — the handler still
        // WHY: returns undefined (original output untouched); the reason goes to
        // WHY: stderr only (ADR-0033 D6 holds).
        expect(await bashResult(handler!, "cat -A f.txt", ctx, "<<raw stdout>>")).toBeUndefined();
      } finally {
        console.error = originalError;
        if (previous === undefined) delete process.env.PI_HASHLINE_DEBUG;
        else process.env.PI_HASHLINE_DEBUG = previous;
      }
      expect(
        logged.some((line) => line.includes("[bash-view] pass-through (unsupported-command:cat)")),
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
      expect(text.startsWith("--- Bash search (hashline anchors) ---\n")).toBe(true);
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
        "grep -r pat .",
        "grep -R pat .",
        "grep -P pat f.txt",
        "grep -e pat f.txt",
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
        "grep pat a.txt f.txt",
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
