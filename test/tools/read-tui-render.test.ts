import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
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

describe("read tool — multi-window component contract (#157)", () => {
  it("keeps a multi-window title within its render budget", () => {
    const tool = readTool();
    const args = {
      file: "a.txt",
      windows: [
        { offset: 1, limit: 2 },
        { offset: 20, limit: 2 },
      ],
    };
    const call = tool.renderCall(args, theme, {
      args,
      cwd: "/tmp",
      expanded: false,
      lastComponent: undefined,
    });

    expect(Math.max(...call.render(207).map(visibleWidth))).toBeLessThanOrEqual(207);
  });

  it("does not mutate cached title lines across repeated renders", () => {
    const tool = readTool();
    const args = { file: "a.txt", windows: [{ offset: 1 }, { offset: 20 }] };
    const call = tool.renderCall(args, theme, { args, cwd: "/tmp", expanded: false });
    const first = [...call.render(207)];

    expect(call.render(207)).toEqual(first);
  });

  it("reuses and invalidates the builtin component across window-count changes", () => {
    const tool = readTool();
    const args = { file: "a.txt", windows: [{ offset: 1 }, { offset: 20 }] };
    const initial = tool.renderCall(args, theme, { args, cwd: "/tmp", expanded: false });
    const nextArgs = {
      file: "b.txt",
      windows: [{ offset: 1 }, { offset: 20 }, { offset: 40 }],
    };
    const next = tool.renderCall(nextArgs, theme, {
      args: nextArgs,
      cwd: "/tmp",
      expanded: false,
      lastComponent: initial,
    });

    next.invalidate();
    const title = next.render(80).join("\n");
    expect(title).toContain("b.txt");
    expect(title).toContain("(3 windows)");
    expect(Math.max(...next.render(80).map(visibleWidth))).toBeLessThanOrEqual(80);

    const singleArgs = { file: "single.txt", windows: [{ offset: 3, limit: 5 }] };
    const single = tool.renderCall(singleArgs, theme, {
      args: singleArgs,
      cwd: "/tmp",
      expanded: false,
      lastComponent: next,
    });
    expect(stripTerminalSequences(single.render(80).join("\n"))).toContain("single.txt:3-7");
    expect(single.render(80).join("\n")).not.toContain("windows)");

    const again = tool.renderCall(args, theme, {
      args,
      cwd: "/tmp",
      expanded: true,
      lastComponent: single,
    });
    expect(again.render(80).join("\n")).toContain("a.txt");
    expect(again.render(80).join("\n")).toContain("(2 windows)");
    expect(again.render(80).join("\n")).not.toContain("single.txt");
  });

  it("delegates render and invalidation to the reused builtin component", () => {
    const tool = readTool();
    const singleArgs = { file: "AGENTS.md", windows: [{ offset: 1, limit: 2 }] };
    const builtin = tool.renderCall(singleArgs, theme, {
      args: singleArgs,
      cwd: "/tmp",
      expanded: false,
    });
    const render = vi.spyOn(builtin, "render");
    const invalidate = vi.spyOn(builtin, "invalidate");
    try {
      const args = { file: "AGENTS.md", windows: [{ offset: 1 }, { offset: 20 }] };
      const wrapped = tool.renderCall(args, theme, {
        args,
        cwd: "/tmp",
        expanded: true,
        lastComponent: builtin,
      });
      expect(wrapped.render(80).join("\n")).toContain("(2 windows)");
      expect(render).toHaveBeenCalled();
      wrapped.invalidate();
      expect(invalidate).toHaveBeenCalledOnce();
    } finally {
      render.mockRestore();
      invalidate.mockRestore();
    }
  });

  it.each([0, 1, 2, 8, 11, 12, 13, 14, 20, 80, 207])(
    "fits styled, wide and wrapped titles at width %i through resize and invalidation",
    (width) => {
      const tool = readTool();
      const linkedTheme = {
        fg: (_name: string, text: string) =>
          `\x1b]8;;file:///tmp/source\x1b\\\x1b[36m${text}\x1b[39m\x1b]8;;\x1b\\`,
        bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
      };
      for (const file of [
        "a.txt",
        "long/".repeat(30) + "a.txt",
        "目录/音楽.txt",
        "e\u0301/👩‍💻.txt",
        "AGENTS.md",
      ]) {
        for (const count of [2, 10, 16]) {
          for (const currentTheme of [theme, linkedTheme]) {
            const args = { file, windows: Array.from({ length: count }, () => ({ offset: 1 })) };
            const call = tool.renderCall(args, currentTheme, {
              args,
              cwd: "/tmp",
              expanded: false,
            });
            const first = [...call.render(width)];

            expect(first.every((line: string) => visibleWidth(line) <= width)).toBe(true);
            expect(call.render(width)).toEqual(first);
            expect(call.render(207).join("\n")).toContain(`(${count} windows)`);
            call.invalidate();
            expect(call.render(width)).toEqual(first);
          }
        }
      }
    },
  );
});
