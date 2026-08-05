import { describe, expect, it } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import { buildToolDef } from "../../src/replace";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
};

function renderApplied(autoRead: boolean): string {
  const tool = buildToolDef({ autoRead });
  const result = {
    content: [
      { type: "text", text: "Successfully replaced in x.ts. Added 1 line(s), removed 1 line(s)." },
    ],
    details: {
      diff: "+ABC│BBB\n-   │bbb",
      metrics: {
        classification: "applied" as const,
        edits_attempted: 1,
        edits_noop: 0,
        warnings: 0,
        added_lines: 1,
        removed_lines: 1,
      },
    },
  };
  const context = {
    args: undefined,
    toolCallId: "t1",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/tmp",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  };
  const renderResult = tool.renderResult;
  if (!renderResult) throw new Error("renderResult missing");
  const out = renderResult(
    result as any,
    { isPartial: false, expanded: false },
    theme as any,
    context as any,
  );
  expect(out).toBeInstanceOf(Text);
  return (out as any).text as string;
}

describe("replace renderResult with auto-read", () => {
  it("shows the post-edit diff when auto-read is on", () => {
    const text = renderApplied(true);
    expect(text).toContain("+ABC│BBB");
    expect(text).toContain("-   │bbb");
    expect(text).not.toContain("Successfully replaced");
  });

  it("shows the summary instead of the diff when auto-read is off", () => {
    const text = renderApplied(false);
    expect(text).toContain(
      "Successfully replaced in x.ts. Added 1 line(s), removed 1 line(s).",
    );
    expect(text).not.toContain("+ABC│BBB");
  });
});
