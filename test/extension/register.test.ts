import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import register from "../../index";
import { JANITOR_EVENTS } from "../../src/store-janitor";

describe("extension registration", () => {
  it("registers the read and edit tools", () => {
    const toolNames: string[] = [];
    const eventNames: string[] = [];
    const commandNames: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        toolNames.push(tool.name);
      },
      on(name: string) {
        eventNames.push(name);
      },
      registerCommand(name: string) {
        commandNames.push(name);
      },
    } as any;

    register(pi);

    expect(toolNames.sort()).toEqual(["edit", "read", "undo_last_edit"]);
    expect(commandNames).toEqual(["pi-better-edit"]);

    const extensionSubscriptions = [
      "session_start",
      "session_start",
      "session_start",
      "session_start",
      "session_shutdown",
      "tool_call",
      "tool_call",
      "tool_result",
    ];
    expect(eventNames.sort()).toEqual([...extensionSubscriptions, ...JANITOR_EVENTS].sort());
  });
});

describe("tool prompt file references", () => {
  it("edit.ts consolidates payload via payload-contract (single source)", () => {
    const source = readFileSync(new URL("../../src/edit.ts", import.meta.url), "utf-8");
    expect(source).toContain("payload-contract");
    expect(source).toContain("EDIT_DESCRIPTION");
  });
});
