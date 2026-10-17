import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { loadHashStore } from "../../src/hash-store";
import { getServed } from "../../src/served-session/index.js";
import { lineHashes } from "../../src/hashline";
import { useTestHome, withTempDir } from "../support/fixtures";

useTestHome();

function makeFakePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools = new Map<string, any>();
  return {
    pi: {
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
    } as any,
    handlers,
    getTool(name: string) {
      return tools.get(name);
    },
  };
}

describe("edit tool_result handler", () => {
  it("records edit diff rows as serves and lets a follow-up edit verify against them", async () => {
    await withTempDir("edit-served-", async (dir) => {
      const aPath = join(dir, "a.txt");
      await writeFile(aPath, "alpha\nbeta\ngamma\n", "utf-8");

      const { pi, handlers, getTool } = makeFakePi();
      register(pi);
      const readTool = getTool("read");
      const editTool = getTool("edit");
      const handler = handlers.get("tool_result");
      expect(handler).toBeDefined();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "test-session" } };

      await readTool.execute("r1", { file: "a.txt" }, undefined, undefined, ctx);
      const aHashes = await lineHashes("alpha\nbeta\ngamma\n", aPath);

      const result = await editTool.execute(
        "e1",
        {
          file: "a.txt",
          edits: [
            { anchor_from: aHashes[1]!, anchor_to: aHashes[1]!, text: "BETA" },
            { anchor_from: aHashes[2]!, anchor_to: aHashes[2]!, text: "GAMMA" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.servedByPath).toHaveLength(1);

      const handlerResult = await handler!(
        {
          toolName: "edit",
          isError: false,
          input: {
            file: "a.txt",
            edits: [
              { anchor_from: aHashes[1]!, anchor_to: aHashes[1]!, text: "BETA" },
              { anchor_from: aHashes[2]!, anchor_to: aHashes[2]!, text: "GAMMA" },
            ],
          },
          details: result.details,
          content: result.content,
        },
        ctx,
      );
      expect(handlerResult).toBeDefined();

      const store = await loadHashStore();
      expect(getServed(store, "test-session", aPath)).toEqual(
        await lineHashes("alpha\nBETA\nGAMMA\n", aPath),
      );

      const betaRow = result.details.diff.split("\n").find((l: string) => l.includes("│BETA"))!;
      const betaHash = betaRow.split("│")[0]!.replace("+", "");

      const followUp = await editTool.execute(
        "e2",
        { file: "a.txt", edits: [{ anchor_from: betaHash, anchor_to: betaHash, text: "BETA2" }] },
        undefined,
        undefined,
        ctx,
      );
      expect(followUp.isError).toBeFalsy();
      const text = (followUp.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("Successfully edited");
    });
  });
});
