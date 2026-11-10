import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { readEnvelope } from "../../src/error-envelope.js";
import { regEdit } from "../../src/edit";
import { regRead } from "../../src/read";
import { createSessionHandle } from "../../src/served-session/session";
import {
  anchorRows,
  extractHash,
  getText,
  makeFakePiRegistry,
  TEST_SESSION_ID,
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

// WHY: a same-file `text_ref` copy source is not a destructive span, so the baseline disjointness
// WHY: check lets a later item copy lines an earlier item already rewrote. Its source verification
// WHY: then refuses with rows rendered from the changed (uncommitted) batch buffer — reached through
// WHY: public input alone, with no outline read and no mock.
describe("copy-source rejection inside a changed batch buffer (served-or-absent)", () => {
  it("serves and records no buffer rows, names a current-file read, and keeps a standalone edit valid", async () => {
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
      const mirror = createSessionHandle(TEST_SESSION_ID, path);
      const servedBefore = await mirror.load();

      let caught: unknown;
      try {
        await editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [
              // WHY: rewrites line 6 into five lines, changing the buffer the copy source is read from.
              {
                anchor_from: at(6),
                anchor_to: at(6),
                text: "  const x = 10;\n// a\n// b\n// c\n// d",
              },
              {
                anchor_from: at(14),
                anchor_to: at(14),
                text_ref: { anchor_from: at(5), anchor_to: at(8), mode: "copy" },
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
      expect(message).toContain("none grant leases and none were recorded as served");
      expect(message).toContain(
        "An anchored read of current-file lines 5-8 would serve that range.",
      );
      expect(await readFile(path, "utf8")).toBe(SAMPLE);
      // WHY: the rejection left the persistent served record exactly as the read wrote it.
      expect(await mirror.load()).toEqual(servedBefore);

      const result = await editTool.execute(
        "e2",
        { file: "sample.ts", edits: [{ anchor_from: at(5), anchor_to: at(8), text: "" }] },
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
