import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import { createReadSpanProvider } from "../../src/read-expansion/read-provider";
import {
  withQualifiedNames,
  type QualifiedNameRequest,
} from "../../src/read-expansion/qualified-names";
import type { SpanProvider } from "../../src/read-expansion/span-expansion";
import {
  anchorRows,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

type ReadResult = {
  content: Array<{ text?: string }>;
};

function readerWith(provider: SpanProvider) {
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

function runRead(
  tool: ReturnType<typeof readerWith>,
  cwd: string,
  params: unknown,
): Promise<ReadResult> {
  return tool.execute("read-expansion-qualified-name", params, undefined, undefined, {
    cwd,
    sessionManager: testSessionManager,
  });
}

function lines(result: ReadResult): string[] {
  return anchorRows(getText(result)).map((row) => row.slice(row.indexOf("│") + 1));
}

function notes(result: ReadResult): string[] {
  return getText(result)
    .split("\n")
    .filter((line) => line.includes("[widened "));
}

const BASE: SpanProvider = {
  enclosingSpan: () => ({ start: 2, end: 5, kind: "function", name: "parserName", source: "ast" }),
};

const SOURCE = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");

describe("read expansion: optional qualified names", () => {
  it("uses the parser name when no resolver is attached", async () => {
    expect(withQualifiedNames(BASE, undefined)).toBe(BASE);
    await withTempFile("plain.txt", SOURCE, async ({ cwd, path }) => {
      const result = await runRead(readerWith(BASE), cwd, {
        file: path,
        windows: [{ offset: 3, limit: 1 }],
      });

      expect(lines(result)).toEqual(["line 2", "line 3", "line 4", "line 5"]);
      expect(notes(result)).toEqual(["[widened 3-3 -> 2-5, function parserName]"]);
    });
  });

  it("uses a qualified name without changing the parser span", async () => {
    const calls: QualifiedNameRequest[] = [];
    const provider = withQualifiedNames(BASE, (request) => {
      calls.push(request);
      return "pkg::parserName";
    });
    await withTempFile("qualified.txt", SOURCE, async ({ cwd, path }) => {
      const result = await runRead(readerWith(provider), cwd, {
        file: path,
        windows: [{ offset: 3, limit: 1 }],
      });

      expect(lines(result)).toEqual(["line 2", "line 3", "line 4", "line 5"]);
      expect(notes(result)).toEqual(["[widened 3-3 -> 2-5, function pkg::parserName]"]);
      expect(calls).toEqual([{ file: path, name: "parserName", startLine: 2, endLine: 5 }]);
    });
  });

  it("keeps the AST kind when the resolver replaces only the name", async () => {
    const methodProvider: SpanProvider = {
      enclosingSpan: () => ({
        start: 2,
        end: 5,
        kind: "method",
        name: "parserName",
        source: "ast",
      }),
    };
    const provider = withQualifiedNames(methodProvider, () => "pkg::run");
    await withTempFile("kind.txt", SOURCE, async ({ cwd, path }) => {
      const result = await runRead(readerWith(provider), cwd, {
        file: path,
        windows: [{ offset: 3, limit: 1 }],
      });
      expect(notes(result)).toEqual(["[widened 3-3 -> 2-5, method pkg::run]"]);
    });
  });

  it("keeps the parser name when the symbol is absent or the resolver throws", async () => {
    for (const resolver of [
      () => undefined,
      () => {
        throw new Error("no symbol");
      },
    ]) {
      const provider = withQualifiedNames(BASE, resolver);
      await withTempFile("absent.txt", SOURCE, async ({ cwd, path }) => {
        const result = await runRead(readerWith(provider), cwd, {
          file: path,
          windows: [{ offset: 3, limit: 1 }],
        });
        expect(notes(result)).toEqual(["[widened 3-3 -> 2-5, function parserName]"]);
      });
    }
  });

  it("times out a hanging resolver and keeps the parser name and span", async () => {
    const provider = withQualifiedNames(BASE, () => new Promise<string | undefined>(() => {}), 10);
    await withTempFile("slow.txt", SOURCE, async ({ cwd, path }) => {
      const started = Date.now();
      const result = await runRead(readerWith(provider), cwd, {
        file: path,
        windows: [{ offset: 3, limit: 1 }],
      });
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(500);
      expect(lines(result)).toEqual(["line 2", "line 3", "line 4", "line 5"]);
      expect(notes(result)).toEqual(["[widened 3-3 -> 2-5, function parserName]"]);
    });
  });

  it("exposes the resolver through the composed provider", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    regRead(pi, {
      spanProvider: createReadSpanProvider({ qualifiedNameResolver: () => "pkg::foo" }),
    });
    const tool = getTool("read") as ReturnType<typeof readerWith>;
    await withTempFile("foo.sh", `foo() {\n  echo hi\n}\n`, async ({ cwd, path }) => {
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });

      expect(notes(result)).toEqual(["[widened 2-2 -> 1-3, function pkg::foo]"]);
    });
  });

  it("honours the default timeout through the composed provider", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    regRead(pi, {
      spanProvider: createReadSpanProvider({
        qualifiedNameResolver: () => new Promise<string | undefined>(() => {}),
      }),
    });
    const tool = getTool("read") as ReturnType<typeof readerWith>;
    await withTempFile("slow.sh", `foo() {\n  echo hi\n}\n`, async ({ cwd, path }) => {
      const started = Date.now();
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });

      expect(Date.now() - started).toBeLessThan(500);
      expect(notes(result)).toEqual(["[widened 2-2 -> 1-3, function foo]"]);
    });
  });

  it("does not enrich a non-AST source", async () => {
    let called = false;
    const textProvider: SpanProvider = {
      enclosingSpan: () => ({
        start: 2,
        end: 5,
        kind: "paragraph",
        name: "lines 2-5",
        source: "text",
      }),
    };
    const provider = withQualifiedNames(textProvider, () => {
      called = true;
      return "should-not-replace";
    });
    await withTempFile("plain.txt", SOURCE, async ({ cwd, path }) => {
      const result = await runRead(readerWith(provider), cwd, {
        file: path,
        windows: [{ offset: 3, limit: 1 }],
      });

      expect(called).toBe(false);
      expect(notes(result)).toEqual(["[widened 3-3 -> 2-5, paragraph]"]);
    });
  });
});
