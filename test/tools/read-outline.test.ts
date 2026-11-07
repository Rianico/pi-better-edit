import { describe, expect, it } from "vitest";
import { Compile } from "typebox/compile";
import { MAX_READ_WINDOWS } from "../../src/constants";
import { OUTLINE_IGNORED_WINDOWS_WARNING } from "../../src/file-content/admission";
import { regEdit } from "../../src/edit";
import { readToolSchema, regRead } from "../../src/read";
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

function toolsWithOutline(symbols: readonly OutlineSymbol[] | undefined): {
  readTool: Tool;
  editTool: Tool;
} {
  const { pi, getTool } = makeFakePiRegistry();
  const provider = {
    enclosingChain: async () => null,
    ...(symbols === undefined ? {} : { outline: async () => symbols }),
  };
  regRead(pi, { spanProvider: provider });
  regEdit(pi);
  return { readTool: getTool("read") as Tool, editTool: getTool("edit") as Tool };
}

function ctxFor(cwd: string): unknown {
  return { cwd, ui: { notify() {} }, sessionManager: testSessionManager };
}

const SAMPLE = `const VERSION = "1.0";
function helper() {
  return VERSION;
}
export class Rectangle {
  area(): number {
    return 1;
  }
}
export function create(): number {
  return 1;
}
`;

const SYMBOLS: readonly OutlineSymbol[] = [
  { name: "VERSION", kind: "constant", line: 1 },
  { name: "helper", kind: "function", line: 2 },
  { name: "Rectangle", kind: "class", line: 5 },
  { name: "area", kind: "method", line: 6 },
  { name: "create", kind: "function", line: 10 },
];

describe("read mode outline", () => {
  it("serves declaration lines as leased point anchors, interiors unserved", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd }) => {
      const { readTool, editTool } = toolsWithOutline(SYMBOLS);
      const ctx = ctxFor(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "sample.ts", mode: "outline" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      // WHY: one served row per declaration line, byte-for-byte through the serve seam.
      expect(anchorRows(text).map((row) => row.slice(row.indexOf("│") + 1))).toEqual([
        'const VERSION = "1.0";',
        "function helper() {",
        "export class Rectangle {",
        "  area(): number {",
        "export function create(): number {",
      ]);
      // WHY: interiors stay unserved — no body line may appear as an anchored row.
      expect(text).not.toMatch(/^[A-Za-z0-9]{4}│  return /m);
      expect(text).not.toMatch(/^[A-Za-z0-9]{4}│\}/m);

      // WHY: the served rows are live leases — a single-line replacement on the first
      // WHY: declaration anchor applies cleanly.
      const [first] = anchorRows(text);
      const edited = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [
            {
              anchor_from: extractHash(first!),
              anchor_to: extractHash(first!),
              text: 'const VERSION = "2.0";',
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(edited.content[0]?.text).toContain("Successfully edited");
    });
  });

  it("dedupes symbols that share one declaration line", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd }) => {
      const { readTool } = toolsWithOutline([
        { name: "Rectangle", kind: "class", line: 5 },
        { name: "T", kind: "typeParameter", line: 5 },
        { name: "create", kind: "function", line: 10 },
      ]);
      const result = await readTool.execute(
        "r1",
        { file: "sample.ts", mode: "outline" },
        undefined,
        undefined,
        ctxFor(cwd),
      );
      const text = getText(result);
      expect(anchorRows(text)).toHaveLength(2);
      expect(text.match(/\[Lines 5-5 of \d+ total\]/g)).toHaveLength(1);
    });
  });

  it("ignores caller windows in outline mode", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd }) => {
      const { readTool } = toolsWithOutline(SYMBOLS);
      const result = await readTool.execute(
        "r1",
        { file: "sample.ts", mode: "outline", windows: [{ offset: 3, limit: 2 }] },
        undefined,
        undefined,
        ctxFor(cwd),
      );
      const text = getText(result);
      expect(anchorRows(text)).toHaveLength(SYMBOLS.length);
      expect(text).not.toMatch(/^[A-Za-z0-9]{4}│  return VERSION;/m);
      // WHY: the drop is never silent — one `[Window warning: ...]` line names it.
      expect(text).toContain(OUTLINE_IGNORED_WINDOWS_WARNING);
    });
  });

  it("admits a 17-window outline call the capped modes refuse", async () => {
    const validator = Compile(readToolSchema);
    const callerWindows = Array.from({ length: MAX_READ_WINDOWS + 1 }, (_, index) => ({
      offset: index + 1,
      limit: 1,
    }));
    // WHY: the fan-out cap still binds every mode except outline — the schema mirrors the
    // WHY: admission split per-variant, so a 17-window served call fails validation here.
    expect(validator.Check({ file: "sample.ts", windows: callerWindows })).toBe(false);
    expect(validator.Check({ file: "sample.ts", windows: callerWindows, mode: "served" })).toBe(
      false,
    );
    // WHY: outline ignores caller windows, so the same width validates and serves.
    expect(validator.Check({ file: "sample.ts", windows: callerWindows, mode: "outline" })).toBe(
      true,
    );
    await withTempFile("sample.ts", SAMPLE, async ({ cwd }) => {
      const { readTool } = toolsWithOutline(SYMBOLS);
      const result = await readTool.execute(
        "r1",
        { file: "sample.ts", mode: "outline", windows: callerWindows },
        undefined,
        undefined,
        ctxFor(cwd),
      );
      const text = getText(result);
      expect(anchorRows(text)).toHaveLength(SYMBOLS.length);
      expect(text).toContain(OUTLINE_IGNORED_WINDOWS_WARNING);
    });
  });

  it("serves nothing and names the miss when the outline is empty", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd }) => {
      const { readTool } = toolsWithOutline([]);
      const result = await readTool.execute(
        "r1",
        { file: "sample.ts", mode: "outline" },
        undefined,
        undefined,
        ctxFor(cwd),
      );
      const text = getText(result);
      expect(anchorRows(text)).toEqual([]);
      expect(text).toContain("[No symbols found.]");
    });
  });

  it("serves nothing when the provider has no outline seam", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd }) => {
      const { readTool } = toolsWithOutline(undefined);
      const result = await readTool.execute(
        "r1",
        { file: "sample.ts", mode: "outline" },
        undefined,
        undefined,
        ctxFor(cwd),
      );
      const text = getText(result);
      expect(anchorRows(text)).toEqual([]);
      expect(text).toContain("[No symbols found.]");
    });
  });

  it("serves more declaration lines than the caller-window cap", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `const A${index + 1} = ${index + 1};`);
    const symbols: OutlineSymbol[] = lines
      .slice(0, 18)
      .map((_, index) => ({ name: `A${index + 1}`, kind: "constant", line: index + 1 }));
    await withTempFile("many.ts", `${lines.join("\n")}\n`, async ({ cwd }) => {
      const { readTool } = toolsWithOutline(symbols);
      const result = await readTool.execute(
        "r1",
        { file: "many.ts", mode: "outline" },
        undefined,
        undefined,
        ctxFor(cwd),
      );
      const text = getText(result);
      // WHY: 18 > MAX_READ_WINDOWS (16) — derived outline rows are not caller fan-out.
      expect(anchorRows(text)).toHaveLength(18);
    });
  });
});
