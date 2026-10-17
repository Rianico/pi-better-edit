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

  it("does not throw when args or context.args are missing (hardening)", () => {
    const tool = readTool();
    expect(() => tool.renderCall(undefined, theme, { cwd: "/tmp", expanded: false })).not.toThrow();
    const result = { content: [{ type: "text", text: "alpha" }], isError: false };
    expect(() =>
      tool.renderResult(result, { expanded: true }, theme, {
        cwd: "/tmp",
        args: undefined,
        showImages: true,
        isError: false,
      }),
    ).not.toThrow();
  });

  it("resolves the language for highlighting through the renderResult remap", () => {
    const tool = readTool();
    const calls: string[] = [];
    const recordingTheme = {
      fg: (name: string, text: string) => {
        calls.push(name);
        return text;
      },
      bold: (text: string) => text,
    };
    const args = { file: "notes.ts" };
    const context = {
      args,
      cwd: "/tmp",
      showImages: true,
      isError: false,
      lastComponent: undefined,
    };
    const result = { content: [{ type: "text", text: "const x = 1;\n" }], isError: false };

    tool.renderResult(result, { expanded: true }, recordingTheme, context);

    // WHY: the remap lets the builtin resolve getLanguageFromPath("notes.ts") and highlight via
    // WHY: ANSI, so it does not wrap each body line in theme.fg("toolOutput", ...).
    expect(calls).not.toContain("toolOutput");
  });

  it("qualifies the windows serve claim with the served default (fix 2)", () => {
    const tool = readTool();
    // WHY: the flat shape (ADR-0041 D1) carries its own `windows` description — the serve
    // WHY: claim lives on the call's windows array, not a nested file target.
    const params = tool.parameters.properties as {
      windows: { description: string };
    };
    const description = params.windows.description;
    expect(description).toContain("in the default `served` mode every window's rows are served");
  });

  it("keeps highlighting and call rendering for a legacy path payload (fix 4)", () => {
    const tool = readTool();
    const calls: string[] = [];
    const recordingTheme = {
      fg: (name: string, text: string) => {
        calls.push(name);
        return text;
      },
      bold: (text: string) => text,
    };
    const legacyArgs = { path: "notes.ts" };
    const context = {
      args: legacyArgs,
      cwd: "/tmp",
      showImages: true,
      isError: false,
      lastComponent: undefined,
    };
    const result = { content: [{ type: "text", text: "const x = 1;\n" }], isError: false };

    const call = tool.renderCall(legacyArgs, recordingTheme, { cwd: "/tmp", expanded: false });
    expect(call.render(80).join("\n")).toContain("notes.ts");

    calls.length = 0;
    tool.renderResult(result, { expanded: true }, recordingTheme, context);
    expect(calls).not.toContain("toolOutput");
  });
});

describe("read tool — TUI renderers for the flat {file} payload (#147)", () => {
  it("renders the filename on the call line for { file } without mutating args", () => {
    const tool = readTool();
    const args = { file: "notes.txt" };
    const context = { args, cwd: "/tmp", lastComponent: undefined, expanded: false };

    const call = tool.renderCall(args, theme, context);

    const line = call.render(80).join("\n");
    expect(line).toContain("notes.txt");
    // WHY: whole-file reads render the bare path — no range, no window count.
    expect(line).not.toMatch(/:\d/);
    expect(line).not.toContain("windows)");
    expect(args).toEqual({ file: "notes.txt" });
    expect("path" in args).toBe(false);
  });

  it("renders filename and :start-end for { file, windows: [{ offset, limit }] }", () => {
    const tool = readTool();
    const args = { file: "notes.txt", windows: [{ offset: 3, limit: 5 }] };
    const context = { args, cwd: "/tmp", lastComponent: undefined, expanded: false };

    const call = tool.renderCall(args, theme, context);

    // WHY: the builtin renders `:offset-(offset+limit-1)`, so offset 3 limit 5 shows `:3-7`.
    const line = call.render(80).join("\n");
    expect(line).toContain("notes.txt");
    expect(line).toContain(":3-7");
    expect(args).toEqual({ file: "notes.txt", windows: [{ offset: 3, limit: 5 }] });
  });

  it("renders the retired files shape from history via the D5 fallback (first entry)", () => {
    const tool = readTool();
    const args = {
      files: [{ file: "old.txt", windows: [{ offset: 2, limit: 4 }] }, { file: "new.txt" }],
    };
    const context = { args, cwd: "/tmp", lastComponent: undefined, expanded: false };

    const call = tool.renderCall(args, theme, context);

    // WHY: ADR-0041 D5 — recorded transcripts render: `file ?? path ?? files?.[0]?.file`, so the
    // WHY: history entry shows the first file's path even though the shape is retired.
    const line = call.render(80).join("\n");
    expect(line).toContain("old.txt");
    expect(line).not.toContain("new.txt");
  });

  it("shows the path with (N windows) and no range for a multi-window call", () => {
    const tool = readTool();
    const args = {
      file: "a.txt",
      windows: [
        { offset: 2, limit: 4 },
        { offset: 20, limit: 4 },
      ],
    };
    const context = { args, cwd: "/tmp", lastComponent: undefined, expanded: false };

    const line = tool.renderCall(args, theme, context).render(80).join("\n");

    // WHY: ADR-0041 D4 — the builtin has no multi-window chrome, so the call line carries the
    // WHY: count itself; a range is never fabricated from two windows.
    expect(line).toContain("a.txt");
    expect(line).toContain("(2 windows)");
    expect(line).not.toContain(":2-5");
  });

  it("derives no range from an around_anchor window", () => {
    const tool = readTool();
    const args = { file: "a.txt", windows: [{ around_anchor: "deadbeef", radius: 3 }] };
    const context = { args, cwd: "/tmp", lastComponent: undefined, expanded: false };

    const line = tool.renderCall(args, theme, context).render(80).join("\n");

    // WHY: an anchor window has no offset/limit to project — bare path, no range, no count.
    expect(line).toContain("a.txt");
    expect(line).not.toMatch(/:\d/);
    expect(line).not.toContain("windows)");
  });

  it("renders the filename for { file, mode: verbatim } (mode is header-neutral)", () => {
    const tool = readTool();
    const args = { file: "notes.txt", mode: "verbatim" };
    const context = { args, cwd: "/tmp", lastComponent: undefined, expanded: false };

    const call = tool.renderCall(args, theme, context);

    expect(call.render(80).join("\n")).toContain("notes.txt");
  });
});
