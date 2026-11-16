/**
 * Batch-buffer rejection serving, by fault injection. `shiftedBufferRejection`'s E_UNVERIFIED_RANGE
 * arm is reached by the retirement window (`lease-resolve.ts`) when an earlier item deleted one
 * bound's line and the surviving bound stays live and unshifted. Its rows and first offending line
 * are SERVED coordinates (`lease.servedLineNumber`), already current-file lines, so the rowless
 * rewrite must not re-map them through `baselineLineOf`. The mock throws on the grown 18-line
 * buffer, naming served lines 5-8. E_STALE_ANCHOR has no refutable coverage: it is unreachable here
 * — its only row-carrying producer, `makeStaleAnchorRejection`, has no caller in src/, and the one
 * live site in a batch carries `servedRows: []`. The arm stays for forward compatibility and would
 * re-anchor its headline like `E_STALE_RANGE` if a row-carrying producer ever appears.
 */
import { describe, expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import { readEnvelope } from "../../src/error-envelope.js";
import { regEdit } from "../../src/edit";
import { regRead } from "../../src/read";
import {
  anchorRows,
  extractHash,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  useTestHome,
  withTempFile,
} from "../support/fixtures";

vi.mock("../../src/hashline/lease-resolve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hashline/lease-resolve.js")>();
  const { makeServedRejection, UNVERIFIED_HEADLINE } =
    await import("../../src/served-session/serve-render.js");
  return {
    ...actual,
    resolveLeasedEdit: (args: Parameters<typeof actual.resolveLeasedEdit>[0]) => {
      const { fileHashes } = args.snapshot;
      if (fileHashes.length === 18) {
        throw makeServedRejection({
          code: "E_UNVERIFIED_RANGE",
          headline: UNVERIFIED_HEADLINE,
          startLine: 5,
          endLine: 8,
          snapshot: args.snapshot,
          firstOffendingLine: 5,
          cause: "retirement",
        });
      }
      return actual.resolveLeasedEdit(args);
    },
  };
});

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
const LINES = SAMPLE.split("\n");

describe("unverified-range rejection inside a changed batch buffer (served-or-absent)", () => {
  it("serves no rows, names served (current-file) coordinates without double-mapping, and keeps a standalone edit valid", async () => {
    await withTempFile("sample.ts", SAMPLE, async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regRead(pi);
      regEdit(pi);
      const readTool = getTool("read") as Tool;
      const editTool = getTool("edit") as Tool;
      const ctx = { cwd, ui: { notify() {} }, sessionManager: testSessionManager };
      const text = getText(
        await readTool.execute("r", { file: "sample.ts" }, undefined, undefined, ctx),
      );
      const at = (n: number) => extractHash(anchorRows(text)[n - 1]!);
      const deleteRender = { anchor_from: at(5), anchor_to: at(8), text: "" };

      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [
              {
                anchor_from: at(1),
                anchor_to: at(1),
                text: "const A = 1;\n// a\n// b\n// c\n// d",
              },
              deleteRender,
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
      expect(readEnvelope(caught)?.code).toBe("E_UNVERIFIED_RANGE");
      expect(readEnvelope(caught)?.servedRows ?? []).toEqual([]);
      expect(message).not.toContain("Current range (fresh read):");
      expect(message).toContain("none grant leases and none were recorded as served");
      expect(message).toContain(
        "An anchored read of current-file lines 5-8 would serve that range.",
      );
      expect(await readFile(path, "utf8")).toBe(SAMPLE);

      const result = await editTool.execute(
        "e2",
        { file: "sample.ts", edits: [deleteRender] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf8")).toBe(
        [...LINES.slice(0, 4), ...LINES.slice(8)].join("\n"),
      );
    });
  });
});
