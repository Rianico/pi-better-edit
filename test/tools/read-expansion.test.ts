import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import { lineSpanForOffsets } from "../../src/read-expansion/line-arithmetic";
import {
  SPAN_CAP_CODE,
  SPAN_CAP_MARKDOWN,
  SPAN_CAP_TEXT,
  TRIGGER_MAX,
  type SpanProvider,
  type SpanWindow,
} from "../../src/read-expansion/span-expansion";
import { EXPANSION_AUDIT_LOG_NAME, expansionAuditLogPath } from "../../src/read-expansion/audit";
import { loadHashStore } from "../../src/hash-store";
import {
  anchorRows,
  extractHash,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

type ReadResult = {
  content: Array<{ text?: string }>;
  details?: { widened?: unknown };
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

function widenedNotes(text: string): string[] {
  return text.split("\n").filter((line) => line.includes("[widened "));
}

function numbered(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
}

function clearAuditLog(): void {
  rmSync(expansionAuditLogPath(), { force: true });
}

function auditRecords(): Array<Record<string, unknown>> {
  try {
    return readFileSync(expansionAuditLogPath(), "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const fiveThroughTwenty: SpanProvider = {
  enclosingSpan: () => ({
    start: 5,
    end: 20,
    kind: "function",
    name: "parseThing",
    source: "ast",
  }),
};

function fixedSpan(
  start: number,
  end: number,
  kind: string,
  name: string,
  source: "ast" | "md" | "text",
): SpanProvider {
  return { enclosingSpan: () => ({ start, end, kind, name, source }) };
}

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
      expect(declined.details?.widened).toBeUndefined();
    });
  });

  it("widens with the R3 note chrome and no details payload", async () => {
    await withTempFile("widen.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fiveThroughTwenty), cwd, {
        file: path,
        windows: [{ offset: 10, limit: 5 }],
      });
      const text = getText(result);

      expect(servedLines(text)).toEqual(
        Array.from({ length: 16 }, (_, index) => `line ${5 + index}`),
      );
      expect(widenedNotes(text)).toEqual(["[widened 10-14 -> 5-20, function parseThing]"]);
      expect(result.details?.widened).toBeUndefined();
    });
  });

  it("keeps every requested line when the span starts before and ends after the request", async () => {
    await withTempFile("superset.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fixedSpan(3, 25, "method", "run", "ast")), cwd, {
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
    await withTempFile("not-superset.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fixedSpan(20, 30, "function", "other", "ast")), cwd, {
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
      expect(widenedNotes(getText(result))).toEqual([]);
      expect(result.details?.widened).toBeUndefined();
    });
  });

  it("widens a request exactly at the 24-line trigger", async () => {
    await withTempFile("trigger-edge.txt", numbered(60), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fixedSpan(5, 35, "function", "edge", "ast")), cwd, {
        file: path,
        windows: [{ offset: 10, limit: TRIGGER_MAX }],
      });

      expect(servedLines(getText(result))[0]).toBe("line 5");
      expect(widenedNotes(getText(result))).toEqual(["[widened 10-33 -> 5-35, function edge]"]);
    });
  });

  it("does not widen a 25-line request above the trigger", async () => {
    await withTempFile("trigger-above.txt", numbered(60), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fixedSpan(1, 40, "function", "big", "ast")), cwd, {
        file: path,
        windows: [{ offset: 10, limit: TRIGGER_MAX + 1 }],
      });

      expect(servedLines(getText(result))).toEqual(
        Array.from({ length: TRIGGER_MAX + 1 }, (_, index) => `line ${10 + index}`),
      );
      expect(widenedNotes(getText(result))).toEqual([]);
      expect(result.details?.widened).toBeUndefined();
    });
  });

  it("folds adjacent requests before the trigger, so 16 x 24 does not expand", async () => {
    const counting: SpanProvider = {
      enclosingSpan: () => ({ start: 1, end: 384, kind: "function", name: "wide", source: "ast" }),
    };
    await withTempFile("fold-trigger.txt", numbered(384), async ({ cwd, path }) => {
      const windows = Array.from({ length: 16 }, (_, index) => ({
        offset: 1 + index * TRIGGER_MAX,
        limit: TRIGGER_MAX,
      }));
      const result = await runRead(readerWith(counting), cwd, { file: path, windows });
      const lines = servedLines(getText(result));

      expect(lines).toHaveLength(384);
      expect(new Set(lines).size).toBe(384);
      expect(widenedNotes(getText(result))).toEqual([]);
    });
  });

  it("serves a code span exactly at the 80-line cap and refuses 81", async () => {
    await withTempFile("code-cap.txt", numbered(SPAN_CAP_CODE + 40), async ({ cwd, path }) => {
      const atCap = await runRead(
        readerWith(fixedSpan(1, SPAN_CAP_CODE, "function", "large", "ast")),
        cwd,
        { file: path, windows: [{ offset: 50, limit: 5 }] },
      );
      expect(servedLines(getText(atCap))).toHaveLength(SPAN_CAP_CODE);
      expect(widenedNotes(getText(atCap))).toEqual([
        `[widened 50-54 -> 1-${SPAN_CAP_CODE}, function large]`,
      ]);

      const overCap = await runRead(
        readerWith(fixedSpan(1, SPAN_CAP_CODE + 1, "function", "flood", "ast")),
        cwd,
        { file: path, windows: [{ offset: 50, limit: 5 }] },
      );
      expect(servedLines(getText(overCap))).toEqual(
        Array.from({ length: 5 }, (_, index) => `line ${50 + index}`),
      );
      expect(widenedNotes(getText(overCap))).toEqual([]);
      expect(overCap.details?.widened).toBeUndefined();
    });
  });

  it("clamps an over-cap Markdown section to 80 lines and reports the full extent", async () => {
    await withTempFile(
      "markdown-clamp.txt",
      numbered(SPAN_CAP_MARKDOWN + 40),
      async ({ cwd, path }) => {
        const result = await runRead(
          readerWith(fixedSpan(1, 120, "section", "Language", "md")),
          cwd,
          { file: path, windows: [{ offset: 20, limit: 5 }] },
        );

        expect(servedLines(getText(result))).toHaveLength(SPAN_CAP_MARKDOWN);
        expect(widenedNotes(getText(result))).toEqual([
          '[widened 20-24 -> 1-80, section "Language" (section 1-120)]',
        ]);
      },
    );
  });

  it("clamps a Markdown ask past the first cap window without losing the ask", async () => {
    await withTempFile("markdown-slide.txt", numbered(120), async ({ cwd, path }) => {
      const result = await runRead(
        readerWith(fixedSpan(1, 120, "section", "Language", "md")),
        cwd,
        { file: path, windows: [{ offset: 100, limit: 5 }] },
      );
      const lines = servedLines(getText(result));

      expect(lines).toHaveLength(SPAN_CAP_MARKDOWN);
      expect(lines).toContain("line 100");
      expect(lines).toContain("line 104");
      expect(widenedNotes(getText(result))).toEqual([
        '[widened 100-104 -> 25-104, section "Language" (section 1-120)]',
      ]);
    });
  });

  it("caps plain-text spans at 40 lines and refuses 41", async () => {
    await withTempFile("text-cap.txt", numbered(SPAN_CAP_TEXT + 30), async ({ cwd, path }) => {
      const atCap = await runRead(
        readerWith(fixedSpan(1, SPAN_CAP_TEXT, "paragraph", "note", "text")),
        cwd,
        { file: path, windows: [{ offset: 20, limit: 5 }] },
      );
      expect(servedLines(getText(atCap))).toHaveLength(SPAN_CAP_TEXT);
      expect(widenedNotes(getText(atCap))).toEqual(['[widened 20-24 -> 1-40, paragraph "note"]']);

      const overCap = await runRead(
        readerWith(fixedSpan(1, SPAN_CAP_TEXT + 1, "paragraph", "long", "text")),
        cwd,
        { file: path, windows: [{ offset: 20, limit: 5 }] },
      );
      expect(servedLines(getText(overCap))).toEqual([
        "line 20",
        "line 21",
        "line 22",
        "line 23",
        "line 24",
      ]);
      expect(widenedNotes(getText(overCap))).toEqual([]);
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
      expect(widenedNotes(getText(result))).toEqual([]);
    });
  });

  it("widens in verbatim mode with a note and records no lease", async () => {
    await withTempFile("verbatim.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fiveThroughTwenty), cwd, {
        file: path,
        windows: [{ offset: 10, limit: 5 }],
        mode: "verbatim",
      });
      const text = getText(result);

      expect(text).toContain("[widened 10-14 -> 5-20, function parseThing]");
      expect(text).toContain("line 5");
      expect(text).toContain("line 20");
      expect(anchorRows(text)).toHaveLength(0);

      const store = await loadHashStore();
      const row = store.db
        .prepare("SELECT COUNT(*) AS count FROM served_leases WHERE file_path = ?")
        .get(path) as { count: number };
      expect(row.count).toBe(0);
    });
  });

  it("does not widen a whole-file read with no windows", async () => {
    await withTempFile("whole-file.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fiveThroughTwenty), cwd, { file: path });

      expect(servedLines(getText(result))).toHaveLength(30);
      expect(widenedNotes(getText(result))).toEqual([]);
    });
  });

  it("widens an around_anchor window after admission resolves it", async () => {
    await withTempFile("anchor-shape.txt", numbered(30), async ({ cwd, path }) => {
      const first = await runRead(readerWith(), cwd, {
        file: path,
        windows: [{ offset: 10, limit: 1 }],
      });
      const row = anchorRows(getText(first)).find((line) => line.includes("│line 10"));
      expect(row).toBeDefined();
      const anchor = extractHash(row!);

      const result = await runRead(readerWith(fiveThroughTwenty), cwd, {
        file: path,
        windows: [{ around_anchor: anchor, radius: 2 }],
      });

      expect(servedLines(getText(result))).toHaveLength(16);
      expect(widenedNotes(getText(result))).toEqual([
        "[widened 8-12 -> 5-20, function parseThing]",
      ]);
    });
  });

  it("widens a recorded flat path/offset/limit payload", async () => {
    await withTempFile("flat-payload.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fiveThroughTwenty), cwd, {
        path,
        offset: 10,
        limit: 5,
      });

      expect(servedLines(getText(result))).toHaveLength(16);
      expect(widenedNotes(getText(result))).toEqual([
        "[widened 10-14 -> 5-20, function parseThing]",
      ]);
    });
  });

  it("unions two probes that answer with the same span into one block and one merged note", async () => {
    await withTempFile("union-one-span.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fiveThroughTwenty), cwd, {
        file: path,
        windows: [
          { offset: 6, limit: 3 },
          { offset: 14, limit: 3 },
        ],
      });
      const lines = servedLines(getText(result));

      expect(lines).toHaveLength(16);
      expect(new Set(lines).size).toBe(16);
      expect(widenedNotes(getText(result))).toEqual([
        "[widened 6-8, 14-16 -> 5-20, function parseThing]",
      ]);
    });
  });

  it("collapses more than three asked windows to the count-and-ranges note", async () => {
    await withTempFile("union-four.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fiveThroughTwenty), cwd, {
        file: path,
        windows: [
          { offset: 6, limit: 2 },
          { offset: 9, limit: 2 },
          { offset: 12, limit: 2 },
          { offset: 15, limit: 2 },
        ],
      });

      expect(servedLines(getText(result))).toHaveLength(16);
      expect(widenedNotes(getText(result))).toEqual(["[widened 4 windows: 5-20]"]);
    });
  });

  it("serves disjoint widened blocks once each and notes both", async () => {
    const byProbe: SpanProvider = {
      enclosingSpan: (_file: string, window: SpanWindow) => {
        if (!("offset" in window)) return null;
        return window.offset <= 10
          ? { start: 1, end: 10, kind: "function", name: "first", source: "ast" }
          : { start: 15, end: 25, kind: "function", name: "second", source: "ast" };
      },
    };
    await withTempFile("disjoint.txt", numbered(30), async ({ cwd, path }) => {
      const result = await runRead(readerWith(byProbe), cwd, {
        file: path,
        windows: [
          { offset: 5, limit: 2 },
          { offset: 20, limit: 2 },
        ],
      });
      const lines = servedLines(getText(result));

      expect(lines).toHaveLength(21);
      expect(lines[0]).toBe("line 1");
      expect(lines[10]).toBe("line 15");
      expect(widenedNotes(getText(result))).toEqual([
        "[widened 5-6 -> 1-10, function first]",
        "[widened 20-21 -> 15-25, function second]",
      ]);
    });
  });
});

describe("read expansion: audit log", () => {
  it("records applied and refused attempts with their fields", async () => {
    clearAuditLog();
    await withTempFile("audit-applied.txt", numbered(30), async ({ cwd, path }) => {
      await runRead(readerWith(fiveThroughTwenty), cwd, {
        file: path,
        windows: [{ offset: 10, limit: 5 }],
      });
    });
    await withTempFile("audit-refused.txt", numbered(120), async ({ cwd, path }) => {
      await runRead(readerWith(fixedSpan(1, SPAN_CAP_CODE + 1, "function", "flood", "ast")), cwd, {
        file: path,
        windows: [{ offset: 50, limit: 5 }],
      });
    });

    const records = auditRecords();
    const applied = records.find((record) => record["outcome"] === "applied");
    const refused = records.find(
      (record) => record["outcome"] === "refused" && record["reason"] === "over_cap",
    );

    expect(expansionAuditLogPath()).toContain(EXPANSION_AUDIT_LOG_NAME);
    expect(applied).toMatchObject({
      mode: "served",
      outcome: "applied",
      asked: [{ startLine: 10, endLine: 14 }],
      served: { startLine: 5, endLine: 20 },
      label: "function parseThing",
      kind: "function",
      name: "parseThing",
      source: "ast",
    });
    expect(refused).toMatchObject({
      mode: "served",
      outcome: "refused",
      reason: "over_cap",
      asked: [{ startLine: 50, endLine: 54 }],
      label: "function flood",
    });
    expect(refused?.["served"]).toBeUndefined();
  });

  it("records the verbatim mode on an applied expansion", async () => {
    clearAuditLog();
    await withTempFile("audit-verbatim.txt", numbered(30), async ({ cwd, path }) => {
      await runRead(readerWith(fiveThroughTwenty), cwd, {
        file: path,
        windows: [{ offset: 10, limit: 5 }],
        mode: "verbatim",
      });
    });

    expect(auditRecords().find((record) => record["outcome"] === "applied")).toMatchObject({
      mode: "verbatim",
      outcome: "applied",
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
