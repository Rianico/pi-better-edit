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

const SAMPLE = `aaa
bbb
ccc
ddd
eee
`;

describe("noop-loop rejection inside a changed batch buffer (served-or-absent)", () => {
  it("shows and records no buffer rows and keeps a standalone edit valid", async () => {
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

      const batch = {
        file: "sample.ts",
        edits: [
          { anchor_from: at(1), anchor_to: at(1), text: "AAA\nBBB" },
          { anchor_from: at(3), anchor_to: at(3), text: "ccc" },
          { anchor_from: at(4), anchor_to: at(5), at: "before", text: "X" },
        ],
      };

      for (let round = 0; round < 2; round++) {
        let caught: unknown;
        try {
          await editTool.execute(`e${round + 1}`, batch, undefined, undefined, ctx);
        } catch (error) {
          caught = error;
        }
        expect(readEnvelope(caught)?.code).toBe("E_BAD_PAYLOAD");
      }

      let caught: unknown;
      try {
        await editTool.execute("e3", batch, undefined, undefined, ctx);
      } catch (error) {
        caught = error;
      }
      const message = (caught as Error).message;
      expect(readEnvelope(caught)?.code).toBe("E_NOOP_LOOP");
      expect(readEnvelope(caught)?.servedRows ?? []).toEqual([]);
      expect(message).not.toContain("Current range:");
      expect(message).toContain("shows no rows and none were recorded as served");
      expect(message).toContain(
        "An anchored read of current-file lines 3-3 would serve that range.",
      );
      expect(await readFile(path, "utf8")).toBe(SAMPLE);
      expect(await mirror.load()).toEqual(servedBefore);

      const result = await editTool.execute(
        "e4",
        { file: "sample.ts", edits: [{ anchor_from: at(3), anchor_to: at(3), text: "CCC" }] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf8")).toBe("aaa\nbbb\nCCC\nddd\neee\n");
    });
  });
});
