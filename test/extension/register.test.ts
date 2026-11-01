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

    // WHY: the extension's own subscriptions, one entry per `pi.on` site in `index.ts`'s factory.
    // WHY: THREE `session_start` here — (#165) regEdit captures the session for the preview pane,
    // WHY: the lifecycle hook does the session-start work, and regRead warms expansion grammars; the
    // WHY: janitor's is the fourth, and comes from `JANITOR_EVENTS` below. TWO `tool_call`: the pre-write served hash echo guard and the
    // WHY: search line-number injection (spec §3.1); they filter by tool name independently, so order
    // WHY: is not load-bearing.
    const extensionSubscriptions = [
      "session_start",
      "session_start",
      "session_start",
      "tool_call",
      "tool_call",
      "tool_result",
    ];
    // WHY exact equality and not containment: this case IS the registration contract, in the same
    // WHY shape as the tool and command assertions above. A new subscription widens the extension's
    // WHY surface, so it must fail here and be added deliberately rather than arrive unnoticed.
    // WHY the janitor's half is read from `JANITOR_EVENTS` instead of written out again: those two
    // WHY registrations are the module's own export, and a second literal here could disagree with
    // WHY the module's loop while both stayed green.
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
