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

    expect(toolNames.sort()).toEqual(["read", "replace"]);
    expect(commandNames.sort()).toEqual(["toggle-auto-read", "toggle-replace-mode"]);

    expect(eventNames).toEqual(["session_start", "tool_result"]);
  });
});

describe("tool prompt file references", () => {
  it("bulk mode tool (replace.ts) loads bulk-specific prompts", () => {
    const source = readFileSync(
      new URL("../../src/replace.ts", import.meta.url),
      "utf-8",
    );
    expect(source).toContain("../prompts/replace-bulk.md");
    expect(source).toContain("../prompts/replace-bulk-snippet.md");
    expect(source).toContain("../prompts/replace-bulk-guidelines.md");
    expect(source).not.toContain("../prompts/replace-flat");
  });

  it("flat mode tool (replace-flat.ts) loads flat-specific prompts", () => {
    const source = readFileSync(
      new URL("../../src/replace-flat.ts", import.meta.url),
      "utf-8",
    );
    expect(source).toContain("../prompts/replace-flat.md");
    expect(source).toContain("../prompts/replace-flat-snippet.md");
    expect(source).toContain("../prompts/replace-flat-guidelines.md");
    expect(source).not.toContain("../prompts/replace-bulk");
  });
});
