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

// WHY: (F4) fault injection for the E_UNVERIFIED_RANGE arm of `shiftedBufferRejection`. That arm is
// WHY: reached by the retirement window (`lease-resolve.ts`) when an earlier item deleted one
// WHY: bound's line and the surviving bound stays live and unshifted. Its rows and first offending
// WHY: line are SERVED coordinates (lease.servedLineNumber), already current-file lines, so the
// WHY: rowless rewrite must NOT re-map them through `baselineLineOf` (that would double-map). The
// WHY: mock throws once the buffer is the grown (18-line) buffer, naming served lines 5-8.
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
      // WHY: served coordinates are already current-file lines — the read is named 5-8, never the
      // WHY: double-mapped buffer lines (which would land on 2-4 after the grow).
      expect(message).toContain(
        "An anchored read of current-file lines 5-8 would serve that range.",
      );
      expect(await readFile(path, "utf8")).toBe(SAMPLE);

      // WHY: the rejection left the served record untouched, so the standalone edit still applies.
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

// WHY: (F4) the E_STALE_ANCHOR arm of `shiftedBufferRejection` has no refutable coverage because it
// WHY: is provably unreachable through the batch-buffer path: its only row-carrying producer,
// WHY: `makeStaleAnchorRejection` (serve-render.ts), has no caller in src/ — the registry pins it as
// WHY: a producer only via direct unit tests. The one live `E_STALE_ANCHOR` site inside a batch,
// WHY: the foreign-source fallback in `foreignRejection`, carries `servedRows: []`, so it never
// WHY: reaches `shiftedBufferRejection` (which requires a non-empty `servedRows`). The arm is kept
// WHY: for forward-compatibility: if a row-carrying `E_STALE_ANCHOR` producer is ever added, the
// WHY: arm already re-anchors its headline and offending line like `E_STALE_RANGE`.
