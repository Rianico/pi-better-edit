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

// WHY: (R3) drives the REAL fold gate in a changed batch buffer to pin the range-end relabel. A
// WHY: same-file `text_ref` copy is not a destructive span, so the baseline disjointness gate only
// WHY: resolves its target — its SOURCE is resolved later, inside the mutate loop, after the
// WHY: preceding item grew line 1. The source (tail, served lines 9-14) has the unread outline fold
// WHY: 10-13 in its interior, so `verifyRebasedSpan` emits `line 14-17` in working-buffer
// WHY: coordinates (shift +4); the rowless rewrite must re-anchor BOTH ends to current-file 10-13.
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
const GROWN = "const A = 1;\n// a\n// b\n// c\n// d";

describe("fold-range rejection inside a changed batch buffer (range-end relabel)", () => {
  it("re-anchors both ends of the outline-fold range and keeps a standalone edit valid", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      const provider = { enclosingChain: async () => null, outline: async () => SYMBOLS };
      regRead(pi, { spanProvider: provider });
      regEdit(pi);
      const readTool = getTool("read") as Tool;
      const editTool = getTool("edit") as Tool;
      const ctx = { cwd, ui: { notify() {} }, sessionManager: testSessionManager };
      const anchors = new Map<string, string>();
      const text = getText(
        await readTool.execute(
          "r",
          { file: "sample.ts", mode: "outline" },
          undefined,
          undefined,
          ctx,
        ),
      );
      for (const row of anchorRows(text))
        anchors.set(row.slice(row.indexOf("│") + 1), extractHash(row));
      const at = (n: number) => {
        const anchor = anchors.get(LINES[n - 1]!);
        expect(anchor, `line ${n} served`).toBeDefined();
        return anchor!;
      };

      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [
              { anchor_from: at(1), anchor_to: at(1), text: GROWN },
              {
                anchor_from: at(14),
                anchor_to: at(14),
                text_ref: { anchor_from: at(9), anchor_to: at(14), mode: "copy" },
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error;
      }
      const message = (caught as Error).message;
      expect(readEnvelope(caught)?.code).toBe("E_STALE_RANGE");
      expect(readEnvelope(caught)?.servedRows ?? []).toEqual([]);
      expect(message).not.toContain("Current range (fresh read):");
      expect(message).toContain("is hidden by an outline fold");
      expect(message).toContain("none grant leases and none were recorded as served");
      // WHY: the buffer range 14-17 is re-anchored to current-file 10-13 — BOTH ends, so neither a
      // WHY: whole buffer range nor a start-only relabel (`line 10-17`) leaks.
      expect(message).toContain("line 10-13");
      expect(message).not.toContain("line 14-17");
      expect(message).not.toContain("line 10-17");
      expect(await readFile(path, "utf8")).toBe(SAMPLE);

      // WHY: the rejection left the served record untouched, so a standalone edit still applies.
      const result = await editTool.execute(
        "e2",
        {
          file: "sample.ts",
          edits: [{ anchor_from: at(1), anchor_to: at(1), text: "const A = 42;" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf8")).toBe(["const A = 42;", ...LINES.slice(1)].join("\n"));
    });
  });
});
