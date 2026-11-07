import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { readEnvelope } from "../../src/error-envelope.js";
import { regEdit } from "../../src/edit";
import { parseText } from "../../src/hashline/parse.js";
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

function toolsWithOutline(symbols: readonly OutlineSymbol[]): {
  readTool: Tool;
  editTool: Tool;
} {
  const { pi, getTool } = makeFakePiRegistry();
  const provider = {
    enclosingChain: async () => null,
    outline: async () => symbols,
  };
  regRead(pi, { spanProvider: provider });
  regEdit(pi);
  return { readTool: getTool("read") as Tool, editTool: getTool("edit") as Tool };
}

function ctxFor(cwd: string): unknown {
  return { cwd, ui: { notify() {} }, sessionManager: testSessionManager };
}

// WHY: the same declaration sample as `test/tools/read-outline.test.ts`, so the fold under test is
// WHY: the body the outline hides: lines 3-4 (`return VERSION;`, `}`) sit between the served
// WHY: declaration rows for line 2 (`function helper() {`) and line 5 (`export class Rectangle {`).
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

/** The outline's served rows keyed by rendered content, so each edit names declaration anchors. */
function anchorsByContent(text: string): Map<string, string> {
  const rows = anchorRows(text);
  return new Map(rows.map((row) => [row.slice(row.indexOf("│") + 1), extractHash(row)]));
}

describe("outline fold gate (acceptance for #263)", () => {
  it("refuses a multi-line replacement spanning an unserved fold with [E_STALE_RANGE] and writes nothing", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd, path }) => {
      const { readTool, editTool } = toolsWithOutline(SYMBOLS);
      const ctx = ctxFor(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { file: "sample.ts", mode: "outline" },
          undefined,
          undefined,
          ctx,
        ),
      );
      const anchors = anchorsByContent(text);
      // WHY: both bounds are live declaration leases, so only the unserved fold between them —
      // WHY: lines 3-4, never shown by the outline — can refuse this span.
      const from = anchors.get("function helper() {");
      const to = anchors.get("export class Rectangle {");
      expect(from).toBeDefined();
      expect(to).toBeDefined();

      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [{ anchor_from: from, anchor_to: to, text: "const REPLACED = 1;" }],
          },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      // WHY: the tool seam throws `instanceof Error`-plain with the envelope stamped on (the
      // WHY: documented error-envelope design) — the code rides `readEnvelope`, never the class.
      const envelope = readEnvelope(caught);
      expect(envelope?.code).toBe("E_STALE_RANGE");
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toMatch(/\[MODEL\] \[E_STALE_RANGE\]/);
      // WHY: the range-family contract serves the current range for a fresh read — the model
      // WHY: re-decides from visible rows instead of blindly retrying over the hidden fold.
      expect(message).toContain("Current range (fresh read):");
      // WHY: fail-closed — the refusal lands before any write, so the bytes never move.
      expect(await readFile(path, "utf8")).toBe(SAMPLE);
    });
  });

  it("applies a single-line replacement on a declaration anchor byte-exactly", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd, path }) => {
      const { readTool, editTool } = toolsWithOutline(SYMBOLS);
      const ctx = ctxFor(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { file: "sample.ts", mode: "outline" },
          undefined,
          undefined,
          ctx,
        ),
      );
      const version = anchorsByContent(text).get('const VERSION = "1.0";');
      expect(version).toBeDefined();

      // WHY: `parseText` is the edit path's own text semantics (`src/hashline/parse.ts`): one
      // WHY: string becomes the replacement lines, so the expected bytes spell the same splice the
      // WHY: replace arm of `resToSpan` (`src/hashline/apply.ts`) computes — line 1 swapped in place.
      const replacement = 'const VERSION = "2.0";';
      expect(parseText(replacement)).toEqual([replacement]);
      const edited = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: version, anchor_to: version, text: replacement }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(edited.content[0]?.text).toContain("Successfully edited");
      const endOfLine1 = SAMPLE.indexOf("\n");
      expect(await readFile(path, "utf8")).toBe(`${replacement}${SAMPLE.slice(endOfLine1)}`);
    });
  });

  it('applies an "after" point insertion on a declaration anchor byte-exactly', async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd, path }) => {
      const { readTool, editTool } = toolsWithOutline(SYMBOLS);
      const ctx = ctxFor(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { file: "sample.ts", mode: "outline" },
          undefined,
          undefined,
          ctx,
        ),
      );
      const helper = anchorsByContent(text).get("function helper() {");
      expect(helper).toBeDefined();

      // WHY: the `after` arm of `insertionSpan` (`src/hashline/apply.ts`) splices zero-width after
      // WHY: the target line's content — `replacement` is `"\n" + inserted` at the line end — so the
      // WHY: expected bytes name that same position; `parseText` pins the inserted lines first.
      const note = "// outline-visible note";
      expect(parseText(note)).toEqual([note]);
      const edited = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: helper, anchor_to: helper, at: "after", text: note }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(edited.content[0]?.text).toContain("Successfully edited");
      const lineStart = SAMPLE.indexOf("function helper() {");
      const lineEnd = lineStart + "function helper() {".length;
      expect(await readFile(path, "utf8")).toBe(
        `${SAMPLE.slice(0, lineEnd)}\n${note}${SAMPLE.slice(lineEnd)}`,
      );
    });
  });

  it('applies a "before" point insertion on a declaration anchor byte-exactly', async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd, path }) => {
      const { readTool, editTool } = toolsWithOutline(SYMBOLS);
      const ctx = ctxFor(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { file: "sample.ts", mode: "outline" },
          undefined,
          undefined,
          ctx,
        ),
      );
      const rectangle = anchorsByContent(text).get("export class Rectangle {");
      expect(rectangle).toBeDefined();

      // WHY: the `before` arm of `insertionSpan` splices zero-width before the target line —
      // WHY: `replacement` is `inserted + "\n"` at the line start — so the expected bytes name that
      // WHY: same position; `parseText` pins the inserted lines first.
      const note = "// outline-visible note";
      expect(parseText(note)).toEqual([note]);
      const edited = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: rectangle, anchor_to: rectangle, at: "before", text: note }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(edited.content[0]?.text).toContain("Successfully edited");
      const lineStart = SAMPLE.indexOf("export class Rectangle {");
      expect(await readFile(path, "utf8")).toBe(
        `${SAMPLE.slice(0, lineStart)}${note}\n${SAMPLE.slice(lineStart)}`,
      );
    });
  });

  it("keeps ADR-0004 interior acceptance for a non-outline partial read (no folds recorded)", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd, path }) => {
      const { readTool, editTool } = toolsWithOutline(SYMBOLS);
      const ctx = ctxFor(cwd);
      // WHY: a served (non-outline) partial read leases lines 1-2 and 5 while leaving the interior
      // WHY: lines 3-4 unserved — the exact ADR-0024 shape. No outline read ran, so no fold is recorded
      // WHY: and the fold-gate stays inert: the multi-line replacement below must still apply.
      const text = getText(
        await readTool.execute(
          "r1",
          {
            file: "sample.ts",
            windows: [
              { offset: 1, limit: 2 },
              { offset: 5, limit: 1 },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      const anchors = anchorsByContent(text);
      const from = anchors.get('const VERSION = "1.0";');
      const to = anchors.get("export class Rectangle {");
      expect(from).toBeDefined();
      expect(to).toBeDefined();

      const replacement = "const REPLACED = 1;";
      const edited = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: from, anchor_to: to, text: replacement }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(edited.content[0]?.text).toContain("Successfully edited");
      // WHY: the replace arm of `resToSpan` (`src/hashline/apply.ts`) swaps lines 1-5 for the
      // WHY: replacement lines in place — the expected bytes spell that same splice.
      const rest = SAMPLE.split("\n").slice(5).join("\n");
      expect(await readFile(path, "utf8")).toBe(`${replacement}\n${rest}`);
    });
  });
});
