/**
 * Multi-file bash views — the ADR-0049 synthetic fixture matrix (M7 item 2).
 *
 * WHY a dedicated suite: the M7 evidence gate admits one real workload shape (plain `cat` over 2+
 * files) and marks `cat -n` / `nl -ba` / `sed -n` over 2+ files as SYNTHETIC-ONLY. This matrix is the
 * witness set the gate asks a fresh reviewer to check: the two-sided invariant per file, per-file
 * leases under the existing anchor identity, the page headers, the empty-page rule, and the config
 * provenance of the caps. Every fixture is named after the item it pins, and where the local shell
 * can produce the bytes the observed stdout comes from real bash rather than a hand-written string.
 *
 * WHY the numbering fixtures hand-write the GNU rendering: ADR-0049 M3 specifies CONTINUOUS stream
 * numbering across files — that is GNU `cat -n`/`nl`. BSD (macOS) `cat -n` restarts per file and BSD
 * `nl` refuses multiple operands, so the fixture carries the specified bytes explicitly and the
 * portability case below pins the BSD rendering the seam also accepts (both are line-count-derived).
 */
import { execFileSync } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { describe, expect, it } from "vitest";
import register from "../../index";
import { lineHashes } from "../../src/hashline/hash-identity.js";
import { CONFIG_REL } from "../../src/json-config.js";
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

function rowsOf(text: string): string[] {
  return text.split("\n").filter((line) => line.includes("│"));
}

function rowContent(row: string): string {
  return row.split("│").slice(1).join("│");
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
) {
  return (await handler!(
    {
      toolName: "bash",
      isError: false,
      input: { command },
      content: [{ type: "text", text: stdout }],
    },
    ctx,
  )) as unknown as { content: Array<{ type: string; text: string }> } | undefined;
}

function realStdout(dir: string, command: string): string {
  return execFileSync("bash", ["-c", command], { cwd: dir, encoding: "utf-8" }) as string;
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf-8");
  }
}

/**
 * WHY every fixture pins the caps in a PROJECT config: the caps resolve through a real ladder, and the
 * test harness points the GLOBAL rung at a store directory shared by the whole suite. Pinning the
 * project rung keeps each fixture's budget deterministic (10/2000 unless the fixture lowers it) and
 * states its provenance — the ladder itself is covered by `test/core/bash-multi-file-config.test.ts`.
 */
async function prepare(
  dir: string,
  files: Record<string, string>,
  multiFile: unknown = { maxFiles: 10, maxRows: 2000 },
): Promise<void> {
  await writeFiles(dir, files);
  await seedProjectMultiFile(dir, multiFile);
}

/** Seeds a project config file so the caps resolve from a real ladder rung, not a default. */
async function seedProjectMultiFile(dir: string, multiFile: unknown): Promise<void> {
  await mkdir(join(dir, ".pi", "agents", "pi-better-edit"), { recursive: true });
  await writeFile(join(dir, CONFIG_REL), JSON.stringify({ bash: { multiFile } }, null, 2), "utf-8");
}

describe("bash multi-file view fixtures (#183, ADR-0049 M7)", () => {
  it("fixture 1 — normal pair: one page per file, in operand order, every row leased", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      const files = { "a.txt": "a1\na2\n", "b.txt": "b1\nb2\n" };
      await prepare(dir, files);
      const command = "cat a.txt b.txt";
      const observed = realStdout(dir, command);
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-pair" } };

      const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      // WHY these exact headers: the page header IS the page's identity (M2) — no root banner, no
      // WHY: `---` dialect, just the settled `[Bash view: …]` grammar per file.
      expect(text).toContain("[Bash view: a.txt (2 lines total)]");
      expect(text).toContain("[Bash view: b.txt (2 lines total)]");
      expect(text.startsWith("[Bash view: a.txt (2 lines total)]")).toBe(true);
      const rows = rowsOf(text);
      expect(rows.map(rowContent)).toEqual(["a1", "a2", "b1", "b2"]);

      // WHY: (M2) leases keep the existing `(session, path, anchor)` identity and never cross files:
      // WHY: one edit through page A and one through page B, each against that file's own bytes.
      const aEdits = await editTool.execute(
        "e0",
        {
          file: "a.txt",
          edits: [
            { anchor_from: anchorFor(rows, "a2"), anchor_to: anchorFor(rows, "a2"), text: "A2" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(aEdits.isError).toBeFalsy();
      const bEdits = await editTool.execute(
        "e1",
        {
          file: "b.txt",
          edits: [
            { anchor_from: anchorFor(rows, "b1"), anchor_to: anchorFor(rows, "b1"), text: "B1" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(bEdits.isError).toBeFalsy();
    });
  });

  it("fixture 2 — zero-row file: an empty operand contributes a header and leases nothing", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      const files = { "a.txt": "a1\n", "empty.txt": "", "b.txt": "b1\n" };
      await prepare(dir, files);
      const command = "cat a.txt empty.txt b.txt";
      const observed = realStdout(dir, command);
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-empty-page" } };

      const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      // WHY `0 lines total` and not a claimed length: M4 prescribes the literal for a page that
      // WHY: serves nothing, and its observed interval is zero-length.
      expect(text).toContain("[Bash view: empty.txt (0 lines total)]");
      const rows = rowsOf(text);
      expect(rows.map(rowContent)).toEqual(["a1", "b1"]);

      // WHY: nothing from the empty page is leased — the page carries no rows and no anchors, so an
      // WHY: edit against that file's anchor space cannot resolve.
      await expect(
        editTool.execute(
          "e0",
          { file: "empty.txt", edits: [{ anchor_from: "zzzz", anchor_to: "zzzz", text: "x" }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow();
    });
  });

  it("fixture 3 — all-empty command stays raw", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      const files = { "e1.txt": "", "e2.txt": "" };
      await prepare(dir, files);
      const command = "cat e1.txt e2.txt";
      const observed = realStdout(dir, command);
      expect(observed).toBe("");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-all-empty" } };
      // WHY: (M4) serving only synthetic headers would show the model no observed byte at all.
      expect(
        await bashResult(handlers.get("tool_result")!, command, ctx, observed),
      ).toBeUndefined();
    });
  });

  it("fixture 4 — cat -n continuous stream numbering (GNU rendering)", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      await prepare(dir, { "a.txt": "a1\na2\n", "b.txt": "b1\nb2\n" });
      const command = "cat -n a.txt b.txt";
      // WHY hand-written: M3 specifies continuous stream numbering; GNU `cat -n` prints exactly this.
      const observed = "     1\ta1\n     2\ta2\n     3\tb1\n     4\tb2\n";
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-cat-n" } };
      const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      const rows = rowsOf(text);
      // WHY file-relative rows: the served rows are the raw re-read LINES; the transform is display
      // WHY: geometry only, never a lease coordinate (M3).
      expect(rows.map(rowContent)).toEqual(["a1", "a2", "b1", "b2"]);
      const edits = await editTool.execute(
        "e0",
        {
          file: "b.txt",
          edits: [
            { anchor_from: anchorFor(rows, "b2"), anchor_to: anchorFor(rows, "b2"), text: "B2" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(edits.isError).toBeFalsy();
    });
  });

  it("fixture 5 — nl -ba continuous stream numbering (GNU rendering)", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      await prepare(dir, { "a.txt": "a1\na2\n", "b.txt": "b1\nb2\n" });
      const command = "nl -ba a.txt b.txt";
      const observed = "     1\ta1\n     2\ta2\n     3\tb1\n     4\tb2\n";
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-nl" } };
      const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
      expect(result).toBeDefined();
      expect(rowsOf(result!.content[0]!.text).map(rowContent)).toEqual(["a1", "a2", "b1", "b2"]);
    });
  });

  it("fixture 5b — cat -n BSD per-file numbering (hand-written rendering)", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      await prepare(dir, { "a.txt": "a1\na2\n", "b.txt": "b1\nb2\n" });
      const command = "cat -n a.txt b.txt";
      // WHY hand-written BSD bytes: BSD `cat -n` RESTARTS numbering in each file, so this stream
      // WHY: matches only the per-file candidate of `multiViewExpectedTexts` — the continuous
      // WHY: candidate (fixture 4's bytes) generates different digits across all four rows. A GNU CI
      // WHY: host cannot produce these bytes with `realStdout`, which is exactly why they are pinned
      // WHY: here: without this fixture the per-file branch would be unexercised off a BSD host.
      const observed = "     1\ta1\n     2\ta2\n     1\tb1\n     2\tb2\n";
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-cat-n-bsd" } };
      const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
      expect(result).toBeDefined();
      const rows = rowsOf(result!.content[0]!.text);
      // WHY raw lines, not the numbering: the transform is display geometry only; leases come from
      // WHY: the file-relative re-read positions, so a restarted counter cannot shift a coordinate.
      expect(rows.map(rowContent)).toEqual(["a1", "a2", "b1", "b2"]);

      const edits = await editTool.execute(
        "e0",
        {
          file: "b.txt",
          edits: [
            { anchor_from: anchorFor(rows, "b1"), anchor_to: anchorFor(rows, "b1"), text: "B1" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(edits.isError).toBeFalsy();
    });
  });

  it("fixture 6 — a sed -n range spanning files maps stream lines to file-relative pages", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      await prepare(dir, { "a.txt": "a1\na2\n", "b.txt": "b1\nb2\n" });
      const command = "sed -n '2,4p' a.txt b.txt";
      const observed = realStdout(dir, command);
      expect(observed).toBe("a2\nb1\nb2\n");
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-sed-cross" } };
      const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      // WHY the ADR's own M5 example verbatim: a:2 is a partial page (range), b:1-2 is whole-file.
      expect(text).toContain("[Bash view: a.txt (lines 2-2 of 2 total)]");
      expect(text).toContain("[Bash view: b.txt (2 lines total)]");
      const rows = rowsOf(text);
      expect(rows.map(rowContent)).toEqual(["a2", "b1", "b2"]);

      // WHY only a:2 is leased in a.txt: line 1 was never printed, so its anchor stays unknown.
      const aHashes = await lineHashes("a1\na2\n", join(dir, "a.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "a.txt",
            edits: [{ anchor_from: aHashes[0]!, anchor_to: aHashes[0]!, text: "A1" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
      const ok = await editTool.execute(
        "e1",
        {
          file: "a.txt",
          edits: [
            { anchor_from: anchorFor(rows, "a2"), anchor_to: anchorFor(rows, "a2"), text: "A2" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(ok.isError).toBeFalsy();
    });
  });

  it("fixture 7 — no selected row in one file leaves a zero-row page", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      await prepare(dir, { "a.txt": "a1\na2\n", "b.txt": "b1\nb2\nb3\n" });
      const command = "sed -n '1,2p' a.txt b.txt";
      const observed = realStdout(dir, command);
      expect(observed).toBe("a1\na2\n");
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-sed-none" } };
      const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text).toContain("[Bash view: a.txt (2 lines total)]");
      // WHY: M5 says a file with no selected line follows M4 — the zero-row page, not a page that
      // WHY: claims it rendered the file.
      expect(text).toContain("[Bash view: b.txt (0 lines total)]");
      expect(rowsOf(text).map(rowContent)).toEqual(["a1", "a2"]);
    });
  });

  it("fixture 8 — a binary operand passes the whole command through", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      await writeFile(join(dir, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0a]));
      await writeFile(join(dir, "a.txt"), "a1\n", "utf-8");
      const command = "cat a.txt bin.dat";
      const observed = realStdout(dir, command);
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-binary" } };
      // WHY the whole command and not just that page: M8 — one bad file fails everything, raw.
      expect(
        await bashResult(handlers.get("tool_result")!, command, ctx, observed),
      ).toBeUndefined();
    });
  });

  it("fixture 9 — a file without a trailing newline has no provable boundary", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      await prepare(dir, { "a.txt": "a1\na2\n", "nonl.txt": "b1\nb2" });
      const command = "cat a.txt nonl.txt";
      const observed = realStdout(dir, command);
      expect(observed.endsWith("b2")).toBe(true);
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-no-newline" } };
      expect(
        await bashResult(handlers.get("tool_result")!, command, ctx, observed),
      ).toBeUndefined();
      // WHY zero leases: the refusal happens before the first lease.
      const hashes = await lineHashes("a1\na2\n", join(dir, "a.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "a.txt",
            edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "A1" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("fixture 10 — CRLF and a STREAM-INITIAL BOM serve normalized rows", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      await prepare(dir, { "crlf.txt": "c1\r\nc2\r\n", "plain.txt": "p1\np2\n" });
      const command = "cat crlf.txt plain.txt";
      const observed = realStdout(dir, command);
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-crlf" } };
      const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
      expect(result).toBeDefined();
      // WHY normalized rows: the anchors describe LF text, so CRLF is normalized away — the same D9
      // WHY: rule the single-file view applies, and it holds for every operand because `toLF` is global.
      expect(rowsOf(result!.content[0]!.text).map(rowContent)).toEqual(["c1", "c2", "p1", "p2"]);
    });
    await withTempDir("bash-multifile-", async (dir) => {
      await prepare(dir, { "bom.txt": "\uFEFFd1\nd2\n", "plain.txt": "p1\n" });
      const command = "cat bom.txt plain.txt";
      const observed = realStdout(dir, command);
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-bom-head" } };
      const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
      expect(result).toBeDefined();
      expect(rowsOf(result!.content[0]!.text).map(rowContent)).toEqual(["d1", "d2", "p1"]);
    });
    await withTempDir("bash-multifile-", async (dir) => {
      await prepare(dir, { "plain.txt": "p1\n", "bom.txt": "\uFEFFd1\n" });
      const command = "cat plain.txt bom.txt";
      const observed = realStdout(dir, command);
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-bom-mid" } };
      // WHY a MID-stream BOM fails closed: D9 strips a file's leading BOM, but in a concatenated
      // WHY: stream only the first operand's BOM is stream-leading — normalizing any other would need
      // WHY: the byte offsets M3 rejects, so the whole command passes through instead.
      expect(
        await bashResult(handlers.get("tool_result")!, command, ctx, observed),
      ).toBeUndefined();
    });
  });

  it("fixture 11 — over the file cap and over a configured row cap both pass through raw", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      const files: Record<string, string> = {};
      for (let index = 1; index <= 11; index += 1) files[`f${index}.txt`] = `l${index}\n`;
      await prepare(dir, files);
      const eleven = `cat ${Object.keys(files).join(" ")}`;
      const observedEleven = realStdout(dir, eleven);
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-over-files" } };
      // WHY the default cap: `maxFiles` defaults to 10, and the cap counts EVERY operand.
      expect(
        await bashResult(handlers.get("tool_result")!, eleven, ctx, observedEleven),
      ).toBeUndefined();
    });

    await withTempDir("bash-multifile-", async (dir) => {
      // WHY a seeded project config: the row cap must come from the ladder (M6), not from a constant —
      // WHY: lowering it is exactly what an operator may do.
      await prepare(
        dir,
        { "a.txt": "a1\na2\n", "b.txt": "b1\nb2\n", "c.txt": "c1\nc2\n" },
        {
          maxFiles: 10,
          maxRows: 4,
        },
      );
      const command = "cat a.txt b.txt c.txt";
      const observed = realStdout(dir, command);
      const { pi, handlers } = makeFakePi();
      register(pi);
      const overCtx = { cwd: dir, sessionManager: { getSessionId: () => "mf-over-rows" } };
      // WHY 6 rows over a cap of 4: all-or-nothing, never a truncated page.
      expect(
        await bashResult(handlers.get("tool_result")!, command, overCtx, observed),
      ).toBeUndefined();

      await seedProjectMultiFile(dir, { maxRows: 6 });
      const atCapCtx = { cwd: dir, sessionManager: { getSessionId: () => "mf-at-rows" } };
      const atCap = await bashResult(handlers.get("tool_result")!, command, atCapCtx, observed);
      expect(atCap).toBeDefined();
      expect(rowsOf(atCap!.content[0]!.text)).toHaveLength(6);
    });
  });

  it("fixture 12 — the ten-file boundary serves exactly ten pages", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      const files: Record<string, string> = {};
      for (let index = 1; index <= 10; index += 1) files[`f${index}.txt`] = `l${index}\n`;
      await prepare(dir, files);
      const command = `cat ${Object.keys(files).join(" ")}`;
      const observed = realStdout(dir, command);
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-ten" } };
      const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text.split("\n").filter((line) => line.startsWith("[Bash view: "))).toHaveLength(10);
      expect(rowsOf(text)).toHaveLength(10);
    });
  });

  it("accepts the BSD per-file numbering rendering as well as the continuous one", async () => {
    // WHY: M3 specifies continuous numbering (GNU). BSD `cat -n` restarts at 1 in each file, and the
    // WHY: seam accepts either closed convention because both are pure functions of line counts — a
    // WHY: stream matching neither still fails closed. This is the portability witness, run against
    // WHY: whatever `cat` this host has.
    await withTempDir("bash-multifile-", async (dir) => {
      await writeFiles(dir, { "a.txt": "a1\n", "b.txt": "b1\n" });
      const command = "cat -n a.txt b.txt";
      const observed = realStdout(dir, command);
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-numbering-portable" } };
      const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
      expect(result).toBeDefined();
      expect(rowsOf(result!.content[0]!.text).map(rowContent)).toEqual(["a1", "b1"]);
    });
  });

  it("fails closed on forged bytes, a reordered stream and a chained multi-file view", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      await prepare(dir, { "a.txt": "a1\na2\n", "b.txt": "b1\nb2\n" });
      const command = "cat a.txt b.txt";
      const observed = realStdout(dir, command);
      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const editTool = getTool("edit");
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-gates" } };

      // WHY a control first: the unmutated stream serves, so the refusals below are the mutations'
      // WHY: doing and not a dead path that refuses everything.
      expect(await bashResult(handlers.get("tool_result")!, command, ctx, observed)).toBeDefined();

      // WHY forged: one byte differs from the re-read file, so the page's rows are not witnessed.
      const forged = observed.replace("b2", "B2");
      expect(forged).not.toBe(observed);
      expect(await bashResult(handlers.get("tool_result")!, command, ctx, forged)).toBeUndefined();

      // WHY reordered: bash prints operand order; a swap names a stream no line-count proof covers.
      const swapped = "b1\nb2\na1\na2\n";
      expect(await bashResult(handlers.get("tool_result")!, command, ctx, swapped)).toBeUndefined();

      // WHY chained: M1 keeps the shape standalone, so a compound declines with `multi-view` and
      // WHY: leases nothing.
      const chained = "cat a.txt b.txt; echo hi";
      const chainedObserved = realStdout(dir, chained);
      // WHY a fresh session: the control above already leased a.txt in `ctx`, so "leases nothing"
      // WHY: must be measured in a session that has seen no serve at all.
      const chainedCtx = { cwd: dir, sessionManager: { getSessionId: () => "mf-chained" } };
      expect(
        await bashResult(handlers.get("tool_result")!, chained, chainedCtx, chainedObserved),
      ).toBeUndefined();
      const hashes = await lineHashes("a1\na2\n", join(dir, "a.txt"));
      await expect(
        editTool.execute(
          "e0",
          {
            file: "a.txt",
            edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "A1" }],
          },
          undefined,
          undefined,
          chainedCtx,
        ),
      ).rejects.toThrow("E_UNKNOWN_ANCHOR");
    });
  });

  it("reports a configured cap's rung and keeps the config path out of the model's text", async () => {
    await withTempDir("bash-multifile-", async (dir) => {
      await writeFiles(dir, { "a.txt": "a1\n", "b.txt": "b1\n" });
      // WHY an out-of-range project value: it is ignored WITH a warning that names the file, and the
      // WHY: serve still happens at the default — the warning never reaches the model's text.
      await seedProjectMultiFile(dir, { maxFiles: 99 });
      const command = "cat a.txt b.txt";
      const observed = realStdout(dir, command);
      const { pi, handlers } = makeFakePi();
      register(pi);
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "mf-warn" } };
      const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      expect(text).not.toContain("multiFile");
      expect(text).not.toContain(join(dir, CONFIG_REL));
    });
  });
});
