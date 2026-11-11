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

// WHY: fault injection for the served-or-absent envelope of a row-carrying rejection inside a batch
// WHY: buffer that earlier items already changed. A later same-file `text_ref` copy reaches it
// WHY: publicly (see `batch-copy-source-rejection-serve.test.ts`); here the leased resolver refuses
// WHY: only inside the grown (18-line) buffer, with rows rendered from it — exactly the shape the
// WHY: v2.18.0 fold false positive produced — and every other call is the real one.
vi.mock("../../src/hashline/lease-resolve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hashline/lease-resolve.js")>();
  const { makeServedRejection } = await import("../../src/served-session/serve-render.js");
  return {
    ...actual,
    resolveLeasedEdit: (args: Parameters<typeof actual.resolveLeasedEdit>[0]) => {
      const { fileHashes } = args.snapshot;
      if (fileHashes.length === 18) {
        const start = fileHashes.indexOf(args.edit.hash_bounds[0].hash) + 1;
        const end = fileHashes.indexOf(args.edit.hash_bounds[1].hash) + 1;
        throw makeServedRejection({
          code: "E_STALE_RANGE",
          headline: `line ${start} injected refusal.`,
          startLine: start,
          endLine: end,
          snapshot: args.snapshot,
          firstOffendingLine: start,
          cause: "served-range staleness",
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

describe("rejection inside a changed batch buffer (served-or-absent)", () => {
  it("serves no buffer rows, says so, names a bounded read, and keeps a standalone edit valid", async () => {
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
      expect(readEnvelope(caught)?.code).toBe("E_STALE_RANGE");
      expect(readEnvelope(caught)?.servedRows ?? []).toEqual([]);
      expect(message).not.toContain("Current range (fresh read):");
      expect(message).toContain("none grant leases and none were recorded as served");
      // WHY: the bounded read is named in current-file coordinates, not the buffer's 9-12.
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
