import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import { lineSpanForOffsets } from "../../src/read-expansion/line-arithmetic";
import { SPAN_CAP, TRIGGER_MAX, type SpanProvider } from "../../src/read-expansion/span-expansion";
import {
  anchorRows,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

type ReadResult = {
  content: Array<{ text?: string }>;
  details?: {
    expansion?: {
      kind: string;
      name: string;
      source: string;
      requested: { offset: number; limit: number };
      served: { startLine: number; endLine: number };
    };
  };
};

function readerWith(provider?: SpanProvider) {
  const { pi, getTool } = makeFakePiRegistry();
  regRead(pi, provider === undefined ? undefined : { spanProvider: provider });
  return getTool("read") as {
    execute(
      callId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ): Promise<ReadResult>;
  };
}

function runRead(
  tool: ReturnType<typeof readerWith>,
  cwd: string,
  params: unknown,
): Promise<ReadResult> {
  return tool.execute("read-expansion-test", params, undefined, undefined, {
    cwd,
    sessionManager: testSessionManager,
  });
}

function servedLines(text: string): string[] {
  return anchorRows(text).map((row) => row.slice(row.indexOf("│") + 1));
}

function noteLine(text: string): string | undefined {
  return text.split("\n").find((line) => line.includes("Read widened"));
}

function numbered(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
}

const fiveThroughTwenty: SpanProvider = {
  enclosingSpan: () => ({ start: 5, end: 20, kind: "function", name: "parseThing", source: "ast" }),
};

describe("read expansion: the fake-provider seam", () => {
  it("serves the exact same bytes when the provider declines", async () => {
    await withTempFile("decline.txt", numbered(40), async ({ cwd, path }) => {
      const params = { file: path, windows: [{ offset: 10, limit: 5 }] };
      const baseline = await runRead(readerWith(), cwd, params);
      const declined = await runRead(readerWith({ enclosingSpan: () => null }), cwd, params);

      expect(getText(declined)).toBe(getText(baseline));
      expect(servedLines(getText(declined))).toEqual(
        Array.from({ length: 5 }, (_, index) => `line ${10 + index}`),
      );
      expect(declined.details?.expansion).toBeUndefined();
    });
  });

  it("widens to the enclosing span and names kind, name and served range once", async () => {
    await withTempFile("widen.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fiveThroughTwenty), cwd, {
        file: path,
        windows: [{ offset: 10, limit: 5 }],
      });
      const text = getText(result);

      expect(servedLines(text)).toEqual(
        Array.from({ length: 16 }, (_, index) => `line ${5 + index}`),
      );
      const note = noteLine(text);
      expect(note).toContain("function");
      expect(note).toContain("parseThing");
      expect(note).toContain("lines 5-20");
      expect(text.split("\n").filter((line) => line.includes("Read widened"))).toHaveLength(1);
      expect(result.details?.expansion).toEqual({
        kind: "function",
        name: "parseThing",
        source: "ast",
        requested: { offset: 10, limit: 5 },
        served: { startLine: 5, endLine: 20 },
      });
    });
  });

  it("keeps every requested line when the span starts before and ends after the request", async () => {
    const enclosing: SpanProvider = {
      enclosingSpan: () => ({ start: 3, end: 25, kind: "method", name: "run", source: "ast" }),
    };
    await withTempFile("superset.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(enclosing), cwd, {
        file: path,
        windows: [{ offset: 10, limit: 5 }],
      });
      const lines = servedLines(getText(result));

      expect(lines[0]).toBe("line 3");
      expect(lines[lines.length - 1]).toBe("line 25");
      expect(lines).toContain("line 10");
      expect(lines).toContain("line 14");
    });
  });

  it("refuses a span that does not contain every requested line", async () => {
    const offTarget: SpanProvider = {
      enclosingSpan: () => ({ start: 20, end: 30, kind: "function", name: "other", source: "ast" }),
    };
    await withTempFile("not-superset.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(offTarget), cwd, {
        file: path,
        windows: [{ offset: 10, limit: 5 }],
      });

      expect(servedLines(getText(result))).toEqual([
        "line 10",
        "line 11",
        "line 12",
        "line 13",
        "line 14",
      ]);
      expect(noteLine(getText(result))).toBeUndefined();
      expect(result.details?.expansion).toBeUndefined();
    });
  });

  it("refuses a span past end of file and falls back to the requested window", async () => {
    const pastEof: SpanProvider = {
      enclosingSpan: () => ({ start: 1, end: 99, kind: "function", name: "ghost", source: "ast" }),
    };
    await withTempFile("past-eof.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(pastEof), cwd, {
        file: path,
        windows: [{ offset: 10, limit: 5 }],
      });

      expect(servedLines(getText(result))).toHaveLength(5);
      expect(noteLine(getText(result))).toBeUndefined();
    });
  });
  it("refuses a span larger than the cap, serving the requested window with no note", async () => {
    const tooLarge: SpanProvider = {
      enclosingSpan: () => ({
        start: 1,
        end: SPAN_CAP + 1,
        kind: "function",
        name: "flood",
        source: "ast",
      }),
    };
    await withTempFile("cap.txt", numbered(SPAN_CAP + 20), async ({ cwd, path }) => {
      const result = await runRead(readerWith(tooLarge), cwd, {
        file: path,
        windows: [{ offset: 100, limit: 5 }],
      });

      expect(servedLines(getText(result))).toEqual([
        "line 100",
        "line 101",
        "line 102",
        "line 103",
        "line 104",
      ]);
      expect(noteLine(getText(result))).toBeUndefined();
      expect(result.details?.expansion).toBeUndefined();
    });
  });

  it("serves a span exactly at the cap and never beyond it", async () => {
    const atCap: SpanProvider = {
      enclosingSpan: () => ({
        start: 1,
        end: SPAN_CAP,
        kind: "function",
        name: "large",
        source: "ast",
      }),
    };
    await withTempFile("at-cap.txt", numbered(SPAN_CAP + 20), async ({ cwd, path }) => {
      const result = await runRead(readerWith(atCap), cwd, {
        file: path,
        windows: [{ offset: 100, limit: 5 }],
      });
      const lines = servedLines(getText(result));

      expect(lines).toHaveLength(SPAN_CAP);
      expect(lines[0]).toBe("line 1");
      expect(lines[lines.length - 1]).toBe(`line ${SPAN_CAP}`);
      expect(noteLine(getText(result))).toContain(`served lines 1-${SPAN_CAP}`);
      expect(result.details?.expansion?.served).toEqual({
        startLine: 1,
        endLine: SPAN_CAP,
      });
    });
  });

  it("does not widen a requested window above the trigger threshold", async () => {
    const wide: SpanProvider = {
      enclosingSpan: () => ({ start: 1, end: 100, kind: "function", name: "big", source: "ast" }),
    };
    await withTempFile("trigger.txt", numbered(100), async ({ cwd, path }) => {
      const result = await runRead(readerWith(wide), cwd, {
        file: path,
        windows: [{ offset: 10, limit: TRIGGER_MAX + 1 }],
      });

      expect(servedLines(getText(result))).toEqual(
        Array.from({ length: TRIGGER_MAX + 1 }, (_, index) => `line ${10 + index}`),
      );
      expect(noteLine(getText(result))).toBeUndefined();
      expect(result.details?.expansion).toBeUndefined();
    });
  });

  it("widens a request exactly at the trigger threshold", async () => {
    const atTrigger: SpanProvider = {
      enclosingSpan: () => ({ start: 5, end: 49, kind: "function", name: "edge", source: "ast" }),
    };
    await withTempFile("trigger-edge.txt", numbered(100), async ({ cwd, path }) => {
      const result = await runRead(readerWith(atTrigger), cwd, {
        file: path,
        windows: [{ offset: 10, limit: TRIGGER_MAX }],
      });

      expect(servedLines(getText(result))[0]).toBe("line 5");
      expect(noteLine(getText(result))).toContain('function "edge"');
    });
  });

  it("treats a throwing provider as no boundary and leaves the read intact", async () => {
    const broken: SpanProvider = {
      enclosingSpan: () => {
        throw new Error("unbalanced syntax");
      },
    };
    await withTempFile("broken.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(broken), cwd, {
        file: path,
        windows: [{ offset: 10, limit: 5 }],
      });

      expect(servedLines(getText(result))).toEqual([
        "line 10",
        "line 11",
        "line 12",
        "line 13",
        "line 14",
      ]);
      expect(noteLine(getText(result))).toBeUndefined();
    });
  });

  it("does not widen in verbatim mode", async () => {
    await withTempFile("verbatim.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fiveThroughTwenty), cwd, {
        file: path,
        windows: [{ offset: 10, limit: 5 }],
        mode: "verbatim",
      });
      const text = getText(result);

      expect(text).toContain("line 10");
      expect(text).not.toContain("line 5");
      expect(text).not.toContain("line 20");
      expect(noteLine(text)).toBeUndefined();
    });
  });
});

describe("read expansion: line arithmetic fixtures", () => {
  it("ends a node on the previous line when the node ends at column 0", () => {
    const text = "one\ntwo\nthree\n";

    expect(lineSpanForOffsets(text, 0, 8)).toEqual({ startLine: 1, endLine: 2 });
  });

  it("ends a node on the last line when there is no trailing newline", () => {
    const text = "a\nb";

    expect(lineSpanForOffsets(text, 0, 3)).toEqual({ startLine: 1, endLine: 2 });
    expect(lineSpanForOffsets(text, 2, 3)).toEqual({ startLine: 2, endLine: 2 });
  });

  it("counts CRLF as one line break and excludes a trailing CRLF at column 0", () => {
    const text = "one\r\ntwo\r\nthree";

    expect(lineSpanForOffsets(text, 0, 5)).toEqual({ startLine: 1, endLine: 1 });
    expect(lineSpanForOffsets(text, 5, 8)).toEqual({ startLine: 2, endLine: 2 });
    expect(lineSpanForOffsets(text, 5, 10)).toEqual({ startLine: 2, endLine: 2 });
  });

  it("returns a one-line span for a one-line block and for an empty range", () => {
    expect(lineSpanForOffsets("only", 0, 4)).toEqual({ startLine: 1, endLine: 1 });
    expect(lineSpanForOffsets("a\nb\nc", 2, 3)).toEqual({ startLine: 2, endLine: 2 });
    expect(lineSpanForOffsets("a\nb\nc", 2, 2)).toEqual({ startLine: 2, endLine: 2 });
  });

  it("fails closed for offsets outside the text", () => {
    expect(lineSpanForOffsets("abc", -1, 2)).toBeNull();
    expect(lineSpanForOffsets("abc", 1.5, 2)).toBeNull();
    expect(lineSpanForOffsets("abc", 2, 1)).toBeNull();
    expect(lineSpanForOffsets("abc", 0, 4)).toBeNull();
  });
});
