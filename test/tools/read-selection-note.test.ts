import { existsSync, readFileSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import { createReadSpanProvider } from "../../src/read-expansion/read-provider";
import {
  readExpansionLogPath,
  resetReadExpansionLogStateForTests,
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

const ENV_VAR = "PI_BETTER_EDIT_READ_EXPANSION";

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
  const path = readExpansionLogPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function clearLog(): void {
  rmSync(readExpansionLogPath(), { force: true });
  resetReadExpansionLogStateForTests();
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
      expect(headerOf(result)).toContain('; in section "Language", lines 5-13)]');
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

  it("names a paragraph's extent without a name", async () => {
    await withTempFile("note.txt", "one\ntwo\n\nthree\nfour\n", async ({ cwd, path }) => {
      const oneLine = await run(reader(), cwd, { file: path, windows: [{ offset: 1, limit: 1 }] });
      expect(rowsOf(oneLine)).toEqual(["one"]);
      expect(headerOf(oneLine)).toContain("; in paragraph, lines 1-2)]");

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
      expect(headerOf(result)).toContain('; in section "Language", lines 5-13)]');
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
      enclosingSpan() {
        onCall();
        return { start: 1, end: 5, kind: "function", name: "f", source: "ast" };
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

  it("stays silent on a multi-window page until the section rule owns it", async () => {
    let calls = 0;
    await withTempFile("app.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const result = await run(reader(spy(() => (calls += 1))), cwd, {
        file: path,
        windows: [
          { offset: 1, limit: 1 },
          { offset: 4, limit: 1 },
        ],
      });
      expect(calls).toBe(0);
      expect(getText(result)).not.toContain("; in ");
    });
  });
});

describe("selection-range note: failures are silent, logged once, and never break the read", () => {
  it("keeps the read complete and records one row when the provider throws", async () => {
    const provider: SpanProvider = {
      enclosingSpan() {
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
    const provider: SpanProvider = { enclosingSpan: () => ({ refusal: "boundary_crossing" }) };
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
      enclosingSpan: () => ({ start: 1, end: 3, kind: "function", name: "", source: "ast" }),
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
      provider: { enclosingSpan: () => new Promise(() => {}) },
      enabled: true,
      timeoutMs: 5,
    });
    expect(note).toEqual({ failure: { source: "ast", reason: "provider_error" } });
  });
});

describe("selection-range note: one bracket grammar", () => {
  it("sanitizes brackets and newlines out of a span name", async () => {
    const provider: SpanProvider = {
      enclosingSpan: () => ({
        start: 1,
        end: 3,
        kind: "function",
        name: "run[fast]\nnow",
        source: "ast",
      }),
    };
    await withTempFile("app.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const result = await run(reader(provider), cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });
      const header = headerOf(result);
      expect(header).toContain("; in function runfast now, lines 1-3)]");
      expect(header.match(/\[/g)).toHaveLength(1);
      expect(header.match(/\]/g)).toHaveLength(1);
    });
  });
});
