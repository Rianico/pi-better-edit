import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { lineHashes } from "../../src/hashline";
import { useTestHome, withTempDir } from "../support/fixtures";

useTestHome();

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
        "grep -n line f.txt",
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
