// WHY the mocks below answer `{ spans: [...] }`: the seam now returns an innermost-first chain
// anchored on the window's first line. Single-level chains render exactly as the old single span,
// so no expectation moved — only the answer shape did.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import { createReadSpanProvider } from "../../src/read-expansion/read-provider";
import {
  resetSelectionRangeLogStateForTests,
  selectionRangeLogPath,
} from "../../src/read-expansion/audit";
import type { SpanProvider } from "../../src/read-expansion/provider-contract";
import { selectionRangeNote } from "../../src/read-expansion/selection-range-note";
import {
  anchorRows,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

type ReadResult = { content: Array<{ text?: string }> };

const ENV_VAR = "PI_BETTER_EDIT_READ_SELECTION_RANGE";

function reader(provider: SpanProvider = createReadSpanProvider()) {
  const { pi, getTool } = makeFakePiRegistry();
  regRead(pi, { spanProvider: provider });
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

function run(tool: ReturnType<typeof reader>, cwd: string, params: unknown): Promise<ReadResult> {
  return tool.execute("read-note", params, undefined, undefined, {
    cwd,
    sessionManager: testSessionManager,
  });
}

function headerOf(result: ReadResult): string {
  return getText(result).split("\n")[0] ?? "";
}

function rowsOf(result: ReadResult): string[] {
  return anchorRows(getText(result)).map((row) => row.slice(row.indexOf("│") + 1));
}

/** Every log row written this session, oldest first. */
function logRows(): Array<Record<string, unknown>> {
  const path = selectionRangeLogPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function clearLog(): void {
  for (const path of [selectionRangeLogPath(), `${selectionRangeLogPath()}.1`]) {
    rmSync(path, { force: true });
  }
  // WHY: the retired name is cleared too — a leftover would be adopted by the next write and add a
  // WHY: row this suite never asked for.
  const retired = join(dirname(selectionRangeLogPath()), "read-expansion.log");
  for (const path of [retired, `${retired}.1`]) rmSync(path, { force: true });
  resetSelectionRangeLogStateForTests();
}

const MARKDOWN = `# Guide\n\nIntro.\n\n## Language\n\nAlpha.\nBeta.\n\n### Nested\n\nGamma.\n\n## Next\n\nDelta.\n`;

beforeEach(() => {
  delete process.env[ENV_VAR];
  clearLog();
});

describe("selection-range note: exact window plus a header clause", () => {
  it("serves exactly the requested lines and names the enclosing span", async () => {
    await withTempFile("guide.md", MARKDOWN, async ({ cwd, path }) => {
      const result = await run(reader(), cwd, { file: path, windows: [{ offset: 7, limit: 1 }] });

      expect(rowsOf(result)).toEqual(["Alpha."]);
      expect(headerOf(result)).toMatch(/^\[.* \(lines 7-7 of \d+ total; /);
      expect(headerOf(result)).toContain('; in section "Language" (span 5-13))]');
      expect(logRows()).toEqual([]);
    });
  });

  it("serves byte-identical rows to the same read with the note turned off", async () => {
    await withTempFile("guide.md", MARKDOWN, async ({ cwd, path }) => {
      const noted = await run(reader(), cwd, { file: path, windows: [{ offset: 7, limit: 1 }] });
      process.env[ENV_VAR] = "off";
      try {
        const bare = await run(reader(), cwd, { file: path, windows: [{ offset: 7, limit: 1 }] });
        expect(rowsOf(bare)).toEqual(rowsOf(noted));
        expect(headerOf(bare)).not.toContain("; in ");
      } finally {
        delete process.env[ENV_VAR];
      }
    });
  });

  it("ignores the retired environment variable: the note still fires", async () => {
    await withTempFile("guide.md", MARKDOWN, async ({ cwd, path }) => {
      process.env.PI_BETTER_EDIT_READ_EXPANSION = "off";
      try {
        const result = await run(reader(), cwd, { file: path, windows: [{ offset: 7, limit: 1 }] });
        expect(headerOf(result)).toContain('; in section "Language" (span 5-13))]');
      } finally {
        delete process.env.PI_BETTER_EDIT_READ_EXPANSION;
      }
    });
  });

  it("names a paragraph's extent without a name", async () => {
    await withTempFile("note.txt", "one\ntwo\n\nthree\nfour\n", async ({ cwd, path }) => {
      const oneLine = await run(reader(), cwd, { file: path, windows: [{ offset: 1, limit: 1 }] });
      expect(rowsOf(oneLine)).toEqual(["one"]);
      expect(headerOf(oneLine)).toContain("; in paragraph (span 1-2))]");

      const wholeSpan = await run(reader(), cwd, {
        file: path,
        windows: [{ offset: 1, limit: 2 }],
      });
      expect(rowsOf(wholeSpan)).toEqual(["one", "two"]);
      expect(headerOf(wholeSpan)).not.toContain("; in ");
    });
  });

  it("carries the same note in verbatim mode, with no anchors and no lease", async () => {
    await withTempFile("guide.md", MARKDOWN, async ({ cwd, path }) => {
      const result = await run(reader(), cwd, {
        file: path,
        mode: "verbatim",
        windows: [{ offset: 7, limit: 1 }],
      });

      expect(getText(result)).not.toContain("│");
      expect(headerOf(result)).toContain("(verbatim, lines 7-7 of ");
      expect(headerOf(result)).toContain('; in section "Language" (span 5-13))]');
      // WHY: the clause is chrome, not a row — the served window is still exactly one line.
      expect(
        getText(result)
          .split("\n")
          .filter((line) => line !== ""),
      ).toHaveLength(2);
    });
  });
});

describe("selection-range note: the pre-lookup gate reaches no provider", () => {
  function spy(onCall: () => void): SpanProvider {
    return {
      enclosingChain() {
        onCall();
        return { spans: [{ start: 1, end: 5, kind: "function", name: "f", source: "ast" }] };
      },
    };
  }

  it("never calls a provider for a whole-file read", async () => {
    let calls = 0;
    await withTempFile("app.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const result = await run(reader(spy(() => (calls += 1))), cwd, { file: path });
      expect(calls).toBe(0);
      expect(headerOf(result)).not.toContain("; in ");
      expect(logRows()).toEqual([]);
    });
  });

  it("never calls a provider for a data path and writes no row", async () => {
    let calls = 0;
    await withTempFile("rows.csv", "a,b\n1,2\n", async ({ cwd, path }) => {
      const result = await run(reader(spy(() => (calls += 1))), cwd, {
        file: path,
        windows: [{ offset: 1, limit: 1 }],
      });
      expect(calls).toBe(0);
      expect(headerOf(result)).not.toContain("; in ");
      expect(logRows()).toEqual([]);
    });
  });

  it("never calls a provider for an extension with no registered provider", async () => {
    let calls = 0;
    await withTempFile("blob.xyz", "a\nb\nc\n", async ({ cwd, path }) => {
      const result = await run(reader(spy(() => (calls += 1))), cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });
      expect(calls).toBe(0);
      expect(headerOf(result)).not.toContain("; in ");
    });
  });

  it("never calls a provider for a window that covers its file", async () => {
    let calls = 0;
    await withTempFile("app.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const result = await run(reader(spy(() => (calls += 1))), cwd, {
        file: path,
        windows: [{ offset: 1, limit: 3 }],
      });
      expect(calls).toBe(0);
      expect(headerOf(result)).not.toContain("; in ");
    });
  });

  it("keeps the multi-window page header bare while sections carry the notes", async () => {
    const provider: SpanProvider = {
      enclosingChain: () => ({
        spans: [{ start: 1, end: 5, kind: "function", name: "f", source: "ast" }],
      }),
    };
    await withTempFile("app.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const result = await run(reader(provider), cwd, {
        file: path,
        windows: [
          { offset: 1, limit: 1 },
          { offset: 4, limit: 1 },
        ],
      });
      const text = getText(result);
      expect(text.split("\n")[0]).toBe(`[${path} (5 lines total)]`);
      expect(text.split("\n")[0]).not.toContain("; in ");
      expect(text).toContain("[Lines 1-1 of 5 total; in function f (span 1-5)]");
      expect(text).toContain("[Lines 4-4 of 5 total]\n");
      expect(text.match(/; in function f \(span 1-5\)/g)).toHaveLength(1);
      expect(logRows()).toEqual([]);
    });
  });
});
describe("selection-range note: one note per span on a multi-window page", () => {
  it("carries section notes with no anchors in verbatim mode", async () => {
    await withTempFile("guide.md", MARKDOWN, async ({ cwd, path }) => {
      const result = await run(reader(), cwd, {
        file: path,
        mode: "verbatim",
        windows: [
          { offset: 7, limit: 1 },
          { offset: 15, limit: 1 },
        ],
      });
      const text = getText(result);
      expect(text).not.toContain("│");
      const headers = text.split("\n").filter((line) => line.startsWith("[Lines "));
      expect(headers).toEqual([
        '[Lines 7-7 of 16 total; in section "Language" (span 5-13)]',
        '[Lines 15-15 of 16 total; in section "Next" (span 14-16)]',
      ]);
    });
  });

  it("names a span once when two sections sit inside it", async () => {
    await withTempFile("guide.md", MARKDOWN, async ({ cwd, path }) => {
      const result = await run(reader(), cwd, {
        file: path,
        windows: [
          { offset: 7, limit: 1 },
          { offset: 8, limit: 1 },
        ],
      });
      const text = getText(result);
      expect(text.match(/; in section "Language" \(span 5-13\)/g)).toHaveLength(1);
      const headers = text.split("\n").filter((line) => line.startsWith("[Lines "));
      expect(headers).toHaveLength(2);
      expect(headers[0]).toContain('; in section "Language" (span 5-13');
      expect(headers[1]).not.toContain("; in ");
    });
  });

  it("places one note per span and leaves an unenclosed window undisturbed", async () => {
    const provider: SpanProvider = {
      enclosingChain: (_file, window) => {
        const offset = "offset" in window ? window.offset : 0;
        return offset === 3
          ? { refusal: "boundary_crossing" }
          : {
              spans: [
                {
                  start: offset <= 2 ? 1 : 4,
                  end: offset <= 2 ? 2 : 5,
                  kind: "function",
                  name: offset <= 2 ? "first" : "second",
                  source: "ast",
                },
              ],
            };
      },
    };
    await withTempFile("app.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const result = await run(reader(provider), cwd, {
        file: path,
        windows: [
          { offset: 1, limit: 1 },
          { offset: 3, limit: 1 },
          { offset: 4, limit: 1 },
        ],
      });
      const headers = getText(result)
        .split("\n")
        .filter((line) => line.startsWith("[Lines "));
      const rows = anchorRows(getText(result)).map((row) => row.slice(row.indexOf("│") + 1));
      expect(rows).toEqual(["a", "c", "d"]);
      expect(headers).toEqual([
        "[Lines 1-1 of 5 total; in function first (span 1-2)]",
        "[Lines 3-3 of 5 total]",
        "[Lines 4-4 of 5 total; in function second (span 4-5)]",
      ]);
    });
  });
});

describe("selection-range note: failures are silent, logged once, and never break the read", () => {
  it("keeps the read complete and records one row when the provider throws", async () => {
    const provider: SpanProvider = {
      enclosingChain() {
        throw new Error("boom");
      },
    };
    await withTempFile("guide.md", MARKDOWN, async ({ cwd, path }) => {
      const result = await run(reader(provider), cwd, {
        file: path,
        windows: [{ offset: 7, limit: 1 }],
      });

      expect(rowsOf(result)).toEqual(["Alpha."]);
      expect(headerOf(result)).not.toContain("; in ");
      const logged = logRows();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ file: path, source: "md", reason: "provider_error" });
    });
  });

  it("writes no row for an ordinary decline", async () => {
    const provider: SpanProvider = { enclosingChain: () => ({ refusal: "boundary_crossing" }) };
    await withTempFile("guide.md", MARKDOWN, async ({ cwd, path }) => {
      const result = await run(reader(provider), cwd, {
        file: path,
        windows: [{ offset: 7, limit: 1 }],
      });
      expect(rowsOf(result)).toEqual(["Alpha."]);
      expect(headerOf(result)).not.toContain("; in ");
      expect(logRows()).toEqual([]);
    });
  });

  it("records invalid_answer once for a malformed provider answer", async () => {
    const provider: SpanProvider = {
      enclosingChain: () => ({
        spans: [{ start: 1, end: 3, kind: "function", name: "", source: "ast" }],
      }),
    };
    await withTempFile("app.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const result = await run(reader(provider), cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });
      expect(rowsOf(result)).toEqual(["b"]);
      expect(headerOf(result)).not.toContain("; in ");
      const logged = logRows();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ file: path, source: "ast", reason: "invalid_answer" });
    });
  });

  it("treats a hanging provider as a failure without holding the read", async () => {
    const note = await selectionRangeNote({
      file: "app.ts",
      windows: [{ offset: 2, limit: 1 }],
      totalLines: 5,
      provider: { enclosingChain: () => new Promise(() => {}) },
      enabled: true,
      timeoutMs: 5,
    });
    expect(note).toEqual({
      clauses: [undefined],
      failure: { source: "ast", reason: "provider_error" },
    });
  });
});

describe("selection-range note: one bracket grammar", () => {
  it("sanitizes brackets and newlines out of a span name", async () => {
    const provider: SpanProvider = {
      enclosingChain: () => ({
        spans: [{ start: 1, end: 3, kind: "function", name: "run[fast]\nnow", source: "ast" }],
      }),
    };
    await withTempFile("app.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const result = await run(reader(provider), cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });
      const header = headerOf(result);
      expect(header).toContain("; in function runfast now (span 1-3))]");
      expect(header.match(/\[/g)).toHaveLength(1);
      expect(header.match(/\]/g)).toHaveLength(1);
    });
  });
});

describe("selection-range note: hardening", () => {
  it("logs invalid_answer for a non-object provider answer", async () => {
    const provider: SpanProvider = { enclosingChain: () => null };
    await withTempFile("guide.md", MARKDOWN, async ({ cwd, path }) => {
      const result = await run(reader(provider), cwd, {
        file: path,
        windows: [{ offset: 7, limit: 1 }],
      });
      expect(headerOf(result)).not.toContain("; in ");
      const logged = logRows();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ file: path, source: "md", reason: "invalid_answer" });
    });
  });

  it("strips C0 control characters from a span name", async () => {
    const provider: SpanProvider = {
      enclosingChain: () => ({
        spans: [{ start: 1, end: 3, kind: "function", name: "run\u0001fast", source: "ast" }],
      }),
    };
    await withTempFile("app.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const result = await run(reader(provider), cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });
      expect(headerOf(result)).toContain("; in function runfast (span 1-3))]");
      expect(headerOf(result)).not.toContain("\u0001");
    });
  });

  it("collapses a newline to one space before stripping C0 controls", async () => {
    const provider: SpanProvider = {
      enclosingChain: () => ({
        spans: [{ start: 1, end: 3, kind: "function", name: "run\nfast\u0001now", source: "ast" }],
      }),
    };
    await withTempFile("app.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const result = await run(reader(provider), cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });
      const header = headerOf(result);
      expect(header).toContain("; in function run fastnow (span 1-3))]");
      expect(header).not.toContain("\u0001");
      expect(header).not.toContain("\n");
    });
  });
});
