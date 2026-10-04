import { describe, expect, it } from "vitest";
import register from "../../index";
import { makeFakePiRegistry } from "../support/fixtures";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

function readTool() {
  const { pi, getTool } = makeFakePiRegistry();
  register(pi);
  return getTool("read");
}

describe("read tool — TUI renderers for the {file} payload", () => {
  it("renders the filename on the call line without mutating args", () => {
    const tool = readTool();
    const args = { file: "notes.txt" };
    const context = { args, cwd: "/tmp", lastComponent: undefined, expanded: false };

    const call = tool.renderCall(args, theme, context);

    expect(call.render(80).join("\n")).toContain("notes.txt");
    expect(args).toEqual({ file: "notes.txt" });
    expect("path" in args).toBe(false);
  });

  it("routes a compact-classifiable {file} payload through the builtin classifier", () => {
    const tool = readTool();
    const args = { file: "AGENTS.md" };
    const context = { args, cwd: "/tmp/repo", lastComponent: undefined, expanded: false };

    const call = tool.renderCall(args, theme, context);

    expect(call.render(80).join("\n")).toContain("AGENTS.md");
    expect(args).toEqual({ file: "AGENTS.md" });
  });

  it("renders expanded results for a {file} payload without mutating context args", () => {
    const tool = readTool();
    const args = { file: "notes.txt" };
    const context = {
      args,
      cwd: "/tmp",
      showImages: true,
      isError: false,
      lastComponent: undefined,
    };
    const result = { content: [{ type: "text", text: "alpha\nbeta" }], isError: false };

    const expanded = tool.renderResult(result, { expanded: true }, theme, context);

    expect(expanded.render(80).join("\n")).toContain("alpha");
    expect(args).toEqual({ file: "notes.txt" });
    expect("path" in args).toBe(false);
  });
});
