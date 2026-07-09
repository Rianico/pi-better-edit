import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import register from "../../index";

describe("extension registration", () => {
  it("registers the read and replace tools", () => {
    const toolNames: string[] = [];
    const eventNames: string[] = [];
    const commandNames: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        toolNames.push(tool.name);
      },
      registerCommand(name: string) {
        commandNames.push(name);
      },
      on(name: string) {
        eventNames.push(name);
      },
    } as any;

    register(pi);

    expect(toolNames.sort()).toEqual(["read", "replace", "undo_last_replace"]);

    expect(eventNames).toEqual(["session_start", "tool_result"]);
  });
});

describe("tool prompt file references", () => {
  it("replace.ts (shared factory) loads both bulk and flat prompts", () => {
    const source = readFileSync(
      new URL("../../src/replace.ts", import.meta.url),
      "utf-8",
    );
    expect(source).toContain("../prompts/replace-bulk.md");
    expect(source).toContain("../prompts/replace-bulk-snippet.md");
    expect(source).toContain("../prompts/replace-bulk-guidelines.md");
    expect(source).toContain("../prompts/replace-flat.md");
    expect(source).toContain("../prompts/replace-flat-snippet.md");
    expect(source).toContain("../prompts/replace-flat-guidelines.md");
  });

  it("replace-flat.ts delegates to replace.ts (no prompt references)", () => {
    const source = readFileSync(
      new URL("../../src/replace-flat.ts", import.meta.url),
      "utf-8",
    );
    expect(source).not.toContain("../prompts/");
    expect(source).toContain("buildToolDef");
    expect(source).toContain("regReplaceFlat");
  });
});
