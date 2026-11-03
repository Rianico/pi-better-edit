import { describe, expect, it } from "vitest";
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { fileHashesFor } from "../../src/hashline/hash-identity.js";
import { withTempFile, getText, extractHash, testSessionManager } from "../support/fixtures";

type ToolResultEvent = {
  toolName: string;
  isError: boolean;
  input: Record<string, unknown>;
  details: any;
  content: Array<{ type: string; text: string }>;
};
type ToolResultCtx = { cwd: string };

function makeSeamPi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools = new Map<string, any>();
  const pi = {
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
  } as any;
  register(pi);
  return {
    handlers,
    getTool(name: string) {
      return tools.get(name);
    },
  };
}

async function hashRefs(
  readTool: any,
  path: string,
  ctx: ToolResultCtx,
  needles: string[],
): Promise<Record<string, string>> {
  const read = await readTool.execute("r1", { file: path }, undefined, undefined, ctx);
  const lines = getText(read).split("\n");
  const out: Record<string, string> = {};
  for (const needle of needles) {
    const line = lines.find((l) => l.includes(needle));
    if (!line) throw new Error(`read output did not show "${needle}"`);
    out[needle] = extractHash(line);
  }
  return out;
}

const RENDER_SRC = [
  "function render(items) {",
  "  const out = [];",
  "  for (const it of items) {",
  "    if (it.active) {",
  "      out.push(it.name);",
  "    }",
  "  }",
  '  return out.join(", ");',
  "}",
  "",
].join("\n");

const RENDER_LINTED = [
  "function render(items) {",
  "  const out = [];",
  "  for (const it of items) {",
  "    if (it.active) {",
  "      try {",
  "        out.push(it.name);",
  "      } catch {}",
  "    }",
  "  }",
  '  return out.join(", ");',
  "}",
  "",
].join("\n");

describe("anchor identity at the tool seam: raw-byte anchors, lease-surviving formatter churn", () => {
  it("edit -> external whitespace-only rewrite -> edit applies with pre-rewrite anchors", async () => {
    await withTempFile("render.ts", RENDER_SRC, async ({ cwd }) => {
      const { handlers, getTool } = makeSeamPi();
      const readTool = getTool("read");
      const editTool = getTool("edit");
      const toolResultHandler = handlers.get("tool_result") as (
        event: ToolResultEvent,
        ctx: ToolResultCtx,
      ) => Promise<any>;
      expect(toolResultHandler).toBeDefined();
      const ctx = { cwd, sessionManager: testSessionManager };
      const abs = join(cwd, "render.ts");

      const refs = await hashRefs(readTool, "render.ts", ctx, ["out.push(it.name);"]);
      const pushRef = refs["out.push(it.name);"]!;

      const edit1: any = await editTool.execute(
        "e1",
        {
          file: "render.ts",
          edits: [
            {
              anchor_from: pushRef,
              anchor_to: pushRef,
              text: "try {\n          out.push(it.name);\n        } catch {}",
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(edit1)).toContain("Successfully edited");

      await toolResultHandler(
        {
          toolName: "edit",
          isError: false,
          input: { path: "render.ts" },
          details: edit1.details,
          content: edit1.content,
        },
        ctx,
      );

      // The anchor edit1's own diff served for the line it wrote — the anchor the model holds
      // when the formatter runs.
      const pushRow = (edit1.details.diff as string)
        .split("\n")
        .find((row) => row.startsWith("+") && row.includes("out.push(it.name);"))!;
      const preRewriteRef = extractHash(pushRow.slice(1));

      // Whitespace-only relative to what edit1 wrote: the same lines, re-indented.
      await writeFile(abs, RENDER_LINTED, "utf-8");

      const edit2: any = await editTool.execute(
        "e2",
        {
          file: "render.ts",
          edits: [
            {
              anchor_from: preRewriteRef,
              anchor_to: preRewriteRef,
              text: "out.push(it.name); // tagged",
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(edit2)).toContain("Successfully edited");
      const final = await readFile(abs, "utf-8");
      expect(final).toContain("out.push(it.name); // tagged");
      expect(final).toContain("try {");
    });
  });

  it("#233: a canon-unchanged edit serves the content-derived anchor, not a probe fallback", async () => {
    await withTempFile(
      "nbsp.ts",
      'const a = 1;\nconst s = "a\u00A0b";\nconst z = 2;\n',
      async ({ cwd }) => {
        const { getTool } = makeSeamPi();
        const readTool = getTool("read");
        const editTool = getTool("edit");
        const ctx = { cwd, sessionManager: testSessionManager };
        const abs = join(cwd, "nbsp.ts");

        const refs = await hashRefs(readTool, "nbsp.ts", ctx, ["a\u00A0b"]);
        const nbspRef = refs["a\u00A0b"]!;

        // NBSP -> space: the line's bytes change, its canon does not. A canon-keyed allocator
        // cannot tell the written line from the line it replaced.
        const result: any = await editTool.execute(
          "e1",
          {
            file: "nbsp.ts",
            edits: [{ anchor_from: nbspRef, anchor_to: nbspRef, text: 'const s = "a b";' }],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(getText(result)).toContain("Successfully edited");

        const onDisk = await readFile(abs, "utf-8");
        const derived = fileHashesFor(abs, onDisk);
        const diffRow = (result.details.diff as string)
          .split("\n")
          .find((row) => row.startsWith("+") && row.includes('const s = "a b";'))!;
        const reRead = await readTool.execute("r2", { file: "nbsp.ts" }, undefined, undefined, ctx);
        const readRow = getText(reRead)
          .split("\n")
          .find((row) => row.includes('const s = "a b";'))!;

        // WHY: measured before the fix — both serves handed back a probe spelling while the line's
        // WHY: own content derived a different anchor. The written line's identity is its own bytes.
        expect(extractHash(diffRow.slice(1))).toBe(derived[1]);
        expect(extractHash(readRow)).toBe(derived[1]);
        expect(extractHash(readRow)).not.toBe("AAAA");
        // The byte change is a real identity change, so the anchor moves with it.
        expect(extractHash(readRow)).not.toBe(nbspRef);
      },
    );
  });

  it("brace merged onto the signature line rejects with E_TARGET_LOST", async () => {
    await withTempFile("f.ts", "func hello()\n{\n    }\n", async ({ cwd }) => {
      const { getTool } = makeSeamPi();
      const readTool = getTool("read");
      const editTool = getTool("edit");
      const ctx = { cwd, sessionManager: testSessionManager };
      const abs = join(cwd, "f.ts");

      const refs = await hashRefs(readTool, "f.ts", ctx, ["func hello()"]);
      const sigRef = refs["func hello()"]!;

      await writeFile(abs, "func hello() {\n    }\n", "utf-8");

      // The merged line is a different line entity, so the served lease is retired with no live
      // unshifted bound: the refusal is [E_TARGET_LOST] with no rows (spec §3.1.1 line 89 / §5.3, ADR-0018).
      await expect(
        editTool.execute(
          "e1",
          {
            file: "f.ts",
            edits: [{ anchor_from: sigRef, anchor_to: sigRef, text: "func hello() /* marked */" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/\[MODEL\] \[E_TARGET_LOST\]/);
    });
  });

  it("chained edits through format churn apply without re-read", async () => {
    await withTempFile(
      "sample.ts",
      [
        "const alpha = 1;",
        "  const beta = 2;",
        "    const gamma = 3;",
        "      const delta = 4;",
        "",
      ].join("\n"),
      async ({ cwd }) => {
        const { handlers, getTool } = makeSeamPi();
        const readTool = getTool("read");
        const editTool = getTool("edit");
        const toolResultHandler = handlers.get("tool_result") as (
          event: ToolResultEvent,
          ctx: ToolResultCtx,
        ) => Promise<any>;
        expect(toolResultHandler).toBeDefined();
        const ctx = { cwd, sessionManager: testSessionManager };
        const abs = join(cwd, "sample.ts");

        const refs = await hashRefs(readTool, "sample.ts", ctx, ["const beta = 2;"]);
        const betaRef = refs["const beta = 2;"]!;

        const edit1: any = await editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [{ anchor_from: betaRef, anchor_to: betaRef, text: "const beta = 22;" }],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(getText(edit1)).toContain("Successfully edited");
        await toolResultHandler(
          {
            toolName: "edit",
            isError: false,
            input: { path: "sample.ts" },
            details: edit1.details,
            content: edit1.content,
          },
          ctx,
        );

        const diffLines = (edit1.details.diff as string).split("\n");
        const gammaRef = diffLines
          .find((l) => l.startsWith(" ") && l.includes("const gamma = 3;") && !l.startsWith("  "))!
          .slice(1, 5);

        await writeFile(
          abs,
          ["const alpha = 1;", "const beta = 22;", "const gamma = 3;", "const delta = 4;", ""].join(
            "\n",
          ),
          "utf-8",
        );

        const edit2: any = await editTool.execute(
          "e2",
          {
            file: "sample.ts",
            edits: [{ anchor_from: gammaRef, anchor_to: gammaRef, text: "const gamma = 33;" }],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(getText(edit2)).toContain("Successfully edited");
        expect(await readFile(abs, "utf-8")).toBe(
          [
            "const alpha = 1;",
            "const beta = 22;",
            "const gamma = 33;",
            "const delta = 4;",
            "",
          ].join("\n"),
        );
      },
    );
  });
});
