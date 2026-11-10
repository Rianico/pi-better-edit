import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { readEnvelope } from "../../src/error-envelope.js";
import { regEdit } from "../../src/edit";
import { regRead } from "../../src/read";
import type { OutlineSymbol } from "../../src/read-expansion/ast-provider";
import {
  anchorRows,
  extractHash,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  useTestHome,
  withTempFile,
} from "../support/fixtures";

useTestHome();

type Tool = {
  execute(
    callId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<{ content: Array<{ text?: string }> }>;
};

// WHY: the outline serves lines 1, 2, 5, 9 and 14, so it records folds 3-4, 6-8 and 10-13. Tests
// WHY: serve the `render` body (5-8) with an explicit anchored read; the `tail` body (10-13) stays
// WHY: genuinely unread.
const SAMPLE = `const A = 1;
function first() {
  return A;
}
function render() {
  const x = 1;
  return x;
}
function tail() {
  const y = 2;
  const z = 3;
  return y + z;
}
export const END = 0;
`;
const SYMBOLS: readonly OutlineSymbol[] = [
  { name: "A", kind: "constant", line: 1 },
  { name: "first", kind: "function", line: 2 },
  { name: "render", kind: "function", line: 5 },
  { name: "tail", kind: "function", line: 9 },
  { name: "END", kind: "constant", line: 14 },
];
const LINES = SAMPLE.split("\n");
// WHY: the size-changing preceding item: line 1 grows by four lines, shifting every later item.
const GROWN = "const A = 1;\n// a\n// b\n// c\n// d";
const WITHOUT_RENDER = [...LINES.slice(0, 4), ...LINES.slice(8)].join("\n");

function setup(cwd: string) {
  const { pi, getTool } = makeFakePiRegistry();
  // WHY: a variable, as in outline-fold-gate.test.ts: `outline` is an optional provider capability.
  const provider = { enclosingChain: async () => null, outline: async () => SYMBOLS };
  regRead(pi, { spanProvider: provider });
  regEdit(pi);
  const readTool = getTool("read") as Tool;
  const editTool = getTool("edit") as Tool;
  const ctx = { cwd, ui: { notify() {} }, sessionManager: testSessionManager };
  const anchors = new Map<string, string>();
  const read = async (params: Record<string, unknown>) => {
    const text = getText(
      await readTool.execute("r", { file: "sample.ts", ...params }, undefined, undefined, ctx),
    );
    for (const row of anchorRows(text))
      anchors.set(row.slice(row.indexOf("│") + 1), extractHash(row));
    return text;
  };
  const edit = (edits: unknown[]) =>
    editTool.execute("e", { file: "sample.ts", edits }, undefined, undefined, ctx);
  /** The anchor served for 1-based line `n` of SAMPLE. */
  const at = (n: number) => {
    const anchor = anchors.get(LINES[n - 1]!);
    expect(anchor, `line ${n} served`).toBeDefined();
    return anchor!;
  };
  return { read, edit, at };
}

async function rejection(
  run: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await run;
  } catch (error) {
    return { code: readEnvelope(error)?.code, message: (error as Error).message };
  }
  throw new Error("expected the edit to be rejected");
}

describe("outline fold after an explicit served read (batch coordinates)", () => {
  it("unchanged-file recovery: a served read of the folded body makes it editable", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd, path }) => {
      const { read, edit, at } = setup(cwd);
      await read({ mode: "outline" });
      // WHY: both bounds are outline declaration rows; the folded `render` interior (6-8) sits between.
      const deleteRender = { anchor_from: at(5), anchor_to: at(9), text: LINES[8] };
      const refused = await rejection(edit([deleteRender]));
      expect(refused.code).toBe("E_STALE_RANGE");
      expect(refused.message).toContain("is hidden by an outline fold");
      await read({ windows: [{ offset: 5, limit: 4 }] });
      expect(getText(await edit([deleteRender]))).toContain("Successfully edited");
      expect(await readFile(path, "utf8")).toBe(WITHOUT_RENDER);
    });
  });

  it("accepts a served body after a size-changing preceding batch item", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd, path }) => {
      const { read, edit, at } = setup(cwd);
      await read({ mode: "outline" });
      await read({ windows: [{ offset: 5, limit: 4 }] });
      const result = await edit([
        { anchor_from: at(1), anchor_to: at(1), text: GROWN },
        { anchor_from: at(5), anchor_to: at(8), text: "" },
      ]);
      expect(getText(result)).toContain("2 of 2 edit(s) applied");
      expect(await readFile(path, "utf8")).toBe(WITHOUT_RENDER.replace(LINES[0]!, GROWN));
    });
  });

  it("leaves state coherent after an atomic rejection, so a standalone edit applies", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd, path }) => {
      const { read, edit, at } = setup(cwd);
      await read({ mode: "outline" });
      await read({ windows: [{ offset: 5, limit: 4 }] });
      // WHY: the third item spans the genuinely unread `tail` body, so the whole call is refused.
      const refused = await rejection(
        edit([
          { anchor_from: at(1), anchor_to: at(1), text: GROWN },
          { anchor_from: at(5), anchor_to: at(8), text: "" },
          { anchor_from: at(9), anchor_to: at(14), text: "export const END = 0;" },
        ]),
      );
      expect(refused.code).toBe("E_STALE_RANGE");
      // WHY: the refusal names the unread interior in current-file coordinates, never the shifted
      // WHY: temporary batch positions, and never the served `render` body.
      expect(refused.message).toContain("line 10-13");
      expect(refused.message).toContain("is hidden by an outline fold");
      expect(refused.message).toContain("NOTHING was written");
      expect(await readFile(path, "utf8")).toBe(SAMPLE);
      const result = await edit([{ anchor_from: at(5), anchor_to: at(8), text: "" }]);
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf8")).toBe(WITHOUT_RENDER);
    });
  });

  it("keeps refusing a genuinely unserved folded interior, standalone and after a shift", async () => {
    const replaceTail = (at: (n: number) => string) => ({
      anchor_from: at(9),
      anchor_to: at(14),
      text: "export const END = 0;",
    });
    await withTempFile("sample.ts", SAMPLE, async ({ cwd, path }) => {
      const { read, edit, at } = setup(cwd);
      await read({ mode: "outline" });
      await read({ windows: [{ offset: 5, limit: 4 }] });
      const refused = await rejection(edit([replaceTail(at)]));
      expect(refused.code).toBe("E_STALE_RANGE");
      expect(refused.message).toContain("line 10-13");
      expect(await readFile(path, "utf8")).toBe(SAMPLE);
    });
    await withTempFile("sample.ts", SAMPLE, async ({ cwd, path }) => {
      const { read, edit, at } = setup(cwd);
      await read({ mode: "outline" });
      await read({ windows: [{ offset: 5, limit: 4 }] });
      const refused = await rejection(
        edit([{ anchor_from: at(1), anchor_to: at(1), text: GROWN }, replaceTail(at)]),
      );
      expect(refused.code).toBe("E_STALE_RANGE");
      expect(refused.message).toContain("line 10-13");
      expect(await readFile(path, "utf8")).toBe(SAMPLE);
    });
  });
});
