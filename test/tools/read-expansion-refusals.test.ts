import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import { createAstSpanProvider } from "../../src/read-expansion/ast-provider";
import {
  readExpansionLogPath,
  resetReadExpansionLogStateForTests,
} from "../../src/read-expansion/audit";
import { DEFAULT_GRAMMAR_READ_BUDGET_MS } from "../../src/read-expansion/grammar-cache";
import type { GrammarLanguageLoader, SyntaxNodeLike } from "../../src/read-expansion/ast-span";
import type {
  GrammarManifest,
  GrammarManifestEntry,
} from "../../src/read-expansion/grammar-manifest";
import { createReadSpanProvider } from "../../src/read-expansion/read-provider";
import type { SpanKind } from "../../src/read-expansion/span-kind";
import { READ_EXPANSION_ENV_VAR } from "../../src/read-expansion-config";
import {
  REFUSAL_REASONS,
  widenWindow,
  type SpanProvider,
} from "../../src/read-expansion/span-expansion";
import {
  anchorRows,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  withTempDir,
  withTempFile,
} from "../support/fixtures";

type ReadResult = { content: Array<{ text?: string }> };

const GOOD_BYTES = new TextEncoder().encode("refusal-test-grammar");
const ENTRY: GrammarManifestEntry = {
  language: "typescript",
  version: "test",
  url: "https://example.invalid/typescript.wasm",
  sha256: createHash("sha256").update(GOOD_BYTES).digest("hex"),
};
const MANIFEST: GrammarManifest = { typescript: ENTRY };

function clearAuditLog(): void {
  const path = readExpansionLogPath();
  rmSync(path, { force: true });
  rmSync(`${path}.1`, { force: true });
  resetReadExpansionLogStateForTests();
}

function auditRecords(): Array<Record<string, unknown>> {
  try {
    return readFileSync(readExpansionLogPath(), "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

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
  return tool.execute("read-refusal", params, undefined, undefined, {
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

function numbered(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

function fixedSpan(start: number, end: number, source: "ast" | "text" = "ast"): SpanProvider {
  return {
    enclosingSpan: () => ({
      start,
      end,
      kind: source === "text" ? "paragraph" : "function",
      name: "fixed",
      source,
    }),
  };
}

function fakeTree(): SyntaxNodeLike {
  const name: SyntaxNodeLike = {
    type: "identifier",
    startPosition: { row: 0, column: 9 },
    endPosition: { row: 0, column: 15 },
    hasError: false,
    namedChildren: [],
    text: "fakeFn",
  };
  const fn: SyntaxNodeLike = {
    type: "function_declaration",
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 9, column: 1 },
    hasError: false,
    namedChildren: [name],
    childForFieldName: (field) => (field === "name" ? name : null),
  };
  return {
    type: "program",
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 19, column: 0 },
    hasError: false,
    namedChildren: [fn],
  };
}

function fakeLoader(calls: { count: number }): GrammarLanguageLoader {
  return async () => {
    calls.count += 1;
    return { parse: () => ({ rootNode: fakeTree() }) };
  };
}

describe("read expansion refusal reasons", () => {
  it("keeps the refusal vocabulary stable", () => {
    expect(REFUSAL_REASONS).toEqual([
      "above_trigger",
      "past_eof",
      "not_text",
      "toggle_off",
      "no_provider",
      "boundary_crossing",
      "grammar_unavailable",
      "cold_grammar",
      "runtime_absent",
      "provider_declined",
      "provider_error",
      "invalid_answer",
      "not_superset",
      "over_cap",
    ]);
  });

  it("reports past_eof before asking a provider", async () => {
    const decision = await widenWindow({
      file: "/repo/short.ts",
      totalLines: 5,
      window: { offset: 10, limit: 2 },
      provider: fixedSpan(1, 10),
    });
    expect(decision).toMatchObject({ outcome: "refused", reason: "past_eof" });
  });
  it("rejects a raw grammar node type as invalid_answer", async () => {
    clearAuditLog();
    const provider: SpanProvider = {
      enclosingSpan: () => ({
        start: 1,
        end: 10,
        kind: "function_declaration" as SpanKind,
        name: "fake",
        source: "ast",
      }),
    };
    await withTempFile("raw.ts", numbered(12), async ({ cwd, path }) => {
      const result = await runRead(readerWith(provider), cwd, {
        file: path,
        windows: [{ offset: 3, limit: 2 }],
      });
      expect(lines(result)).toEqual(["line 3", "line 4"]);
      expect(notes(result)).toEqual([]);
    });
    expect(auditRecords()).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "invalid_answer" }),
    ]);
  });

  it("records no_provider for a data file with no expansion provider", async () => {
    clearAuditLog();
    await withTempFile("events.log", numbered(10), async ({ cwd, path }) => {
      const result = await runRead(readerWith(createReadSpanProvider()), cwd, {
        file: path,
        windows: [{ offset: 3, limit: 2 }],
      });
      expect(lines(result)).toEqual(["line 3", "line 4"]);
      expect(notes(result)).toEqual([]);
    });
    expect(auditRecords()).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "no_provider" }),
    ]);
  });

  it("records above_trigger before any provider call", async () => {
    clearAuditLog();
    let calls = 0;
    const provider: SpanProvider = {
      enclosingSpan: () => {
        calls += 1;
        return { start: 1, end: 30, kind: "function", name: "tooBig", source: "ast" };
      },
    };
    await withTempFile("wide.txt", numbered(40), async ({ cwd, path }) => {
      const result = await runRead(readerWith(provider), cwd, {
        file: path,
        windows: [{ offset: 1, limit: 30 }],
      });
      expect(lines(result)).toHaveLength(30);
      expect(notes(result)).toEqual([]);
    });
    expect(calls).toBe(0);
    expect(auditRecords()).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "above_trigger" }),
    ]);
  });

  it("records over_cap with the full block size", async () => {
    clearAuditLog();
    await withTempFile("big.txt", numbered(120), async ({ cwd, path }) => {
      const result = await runRead(readerWith(fixedSpan(1, 100)), cwd, {
        file: path,
        windows: [{ offset: 20, limit: 5 }],
      });
      expect(lines(result)).toEqual(["line 20", "line 21", "line 22", "line 23", "line 24"]);
      expect(notes(result)).toEqual([]);
    });
    expect(auditRecords()).toEqual([
      expect.objectContaining({
        outcome: "refused",
        reason: "over_cap",
        blockSize: 100,
        section: { startLine: 1, endLine: 100 },
      }),
    ]);
  });

  it("records boundary_crossing when a text window spans two paragraphs", async () => {
    clearAuditLog();
    await withTempFile("two-paragraphs.txt", "first\n\nsecond\n", async ({ cwd, path }) => {
      const result = await runRead(readerWith(createReadSpanProvider()), cwd, {
        file: path,
        windows: [{ offset: 2, limit: 2 }],
      });
      expect(notes(result)).toEqual([]);
    });
    expect(auditRecords()).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "boundary_crossing" }),
    ]);
  });

  it("records the residual provider reasons", async () => {
    const scenarios: Array<[string, SpanProvider]> = [
      ["provider_declined", { enclosingSpan: () => null }],
      [
        "provider_error",
        {
          enclosingSpan: () => {
            throw new Error("parser failed");
          },
        },
      ],
      [
        "invalid_answer",
        {
          enclosingSpan: () => ({ start: 0, end: 2, kind: "function", name: "bad", source: "ast" }),
        },
      ],
      [
        "not_superset",
        {
          enclosingSpan: () => ({
            start: 5,
            end: 6,
            kind: "function",
            name: "miss",
            source: "ast",
          }),
        },
      ],
    ];

    for (const [reason, provider] of scenarios) {
      clearAuditLog();
      await withTempFile("residual.txt", numbered(10), async ({ cwd, path }) => {
        const result = await runRead(readerWith(provider), cwd, {
          file: path,
          windows: [{ offset: 3, limit: 2 }],
        });
        expect(notes(result), reason).toEqual([]);
      });
      expect(auditRecords(), reason).toEqual([
        expect.objectContaining({ outcome: "refused", reason }),
      ]);
    }
  });

  it("records grammar_unavailable with the language when the fetch is permanent", async () => {
    clearAuditLog();
    const cacheRoot = await mkdtemp(join(tmpdir(), "pbe-refusal-unavailable-"));
    try {
      const provider = createAstSpanProvider({
        cacheRoot,
        manifest: MANIFEST,
        runtimeAvailable: async () => true,
        fetchImpl: (async () => {
          throw new Error("offline");
        }) as typeof fetch,
        loadGrammar: fakeLoader({ count: 0 }),
      });
      await withTempFile("unavailable.ts", numbered(20), async ({ cwd, path }) => {
        const result = await runRead(readerWith(provider), cwd, {
          file: path,
          windows: [{ offset: 3, limit: 2 }],
        });
        expect(lines(result)).toEqual(["line 3", "line 4"]);
        expect(notes(result)).toEqual([]);
      });
      expect(auditRecords()).toEqual([
        expect.objectContaining({
          outcome: "refused",
          reason: "grammar_unavailable",
          language: "typescript",
        }),
      ]);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("records cold_grammar, then widens when the shared fetch lands", async () => {
    clearAuditLog();
    const cacheRoot = await mkdtemp(join(tmpdir(), "pbe-refusal-cold-"));
    try {
      const loads = { count: 0 };
      let fetches = 0;
      const provider = createAstSpanProvider({
        cacheRoot,
        manifest: MANIFEST,
        timeoutMs: 10,
        runtimeAvailable: async () => true,
        fetchImpl: (async () => {
          fetches += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          // SAFETY: Node's fetch accepts a Uint8Array body at runtime; the DOM BodyInit union narrows it.
          return new Response(GOOD_BYTES as unknown as BodyInit);
        }) as typeof fetch,
        loadGrammar: fakeLoader(loads),
      });

      await withTempFile("cold.ts", numbered(20), async ({ cwd, path }) => {
        const first = await runRead(readerWith(provider), cwd, {
          file: path,
          windows: [{ offset: 3, limit: 2 }],
        });
        expect(lines(first)).toEqual(["line 3", "line 4"]);
        expect(notes(first)).toEqual([]);

        await new Promise((resolve) => setTimeout(resolve, 80));

        const second = await runRead(readerWith(provider), cwd, {
          file: path,
          windows: [{ offset: 3, limit: 2 }],
        });
        expect(notes(second)).toEqual(["[widened 3-4 -> 1-10, function fakeFn]"]);
      });

      expect(fetches).toBe(1);
      expect(loads.count).toBe(1);
      expect(auditRecords()).toEqual([
        expect.objectContaining({
          outcome: "refused",
          reason: "cold_grammar",
          language: "typescript",
        }),
        expect.objectContaining({ outcome: "applied" }),
      ]);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("prefetches on session_start so the first read can widen", async () => {
    clearAuditLog();
    const cacheRoot = await mkdtemp(join(tmpdir(), "pbe-refusal-prefetch-"));
    try {
      const loads = { count: 0 };
      let fetches = 0;
      let releaseFetch: (() => void) | undefined;
      const release = new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      const provider = createAstSpanProvider({
        cacheRoot,
        manifest: MANIFEST,
        timeoutMs: 5,
        runtimeAvailable: async () => true,
        fetchImpl: (async () => {
          fetches += 1;
          await release;
          // SAFETY: Node's fetch accepts a Uint8Array body at runtime; the DOM BodyInit union narrows it.
          return new Response(GOOD_BYTES as unknown as BodyInit);
        }) as typeof fetch,
        loadGrammar: fakeLoader(loads),
      });

      const { pi, getTool } = makeFakePiRegistry();
      regRead(pi, { spanProvider: provider });
      const tool = getTool("read") as ReturnType<typeof readerWith>;
      pi.startSession({ cwd: process.cwd() });

      for (let attempt = 0; attempt < 20 && fetches === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(fetches).toBe(1);
      releaseFetch?.();
      await new Promise((resolve) => setTimeout(resolve, 50));

      await withTempFile("prefetched.ts", numbered(20), async ({ cwd, path }) => {
        const result = await runRead(tool, cwd, {
          file: path,
          windows: [{ offset: 3, limit: 2 }],
        });
        expect(notes(result)).toEqual(["[widened 3-4 -> 1-10, function fakeFn]"]);
      });
      expect(loads.count).toBe(1);
      expect(auditRecords()).toEqual([expect.objectContaining({ outcome: "applied" })]);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("pins the production grammar read budget", () => {
    expect(DEFAULT_GRAMMAR_READ_BUDGET_MS).toBe(250);
  });

  it("does not prefetch a subdirectory-only workspace, then widens on first use", async () => {
    clearAuditLog();
    let fetches = 0;
    const provider = createAstSpanProvider({
      manifest: MANIFEST,
      runtimeAvailable: async () => true,
      fetchImpl: (async () => {
        fetches += 1;
        // SAFETY: Node's fetch accepts a Uint8Array body at runtime; the DOM BodyInit union narrows it.
        return new Response(GOOD_BYTES as unknown as BodyInit);
      }) as typeof fetch,
      loadGrammar: fakeLoader({ count: 0 }),
    });
    const { pi, getTool } = makeFakePiRegistry();
    regRead(pi, { spanProvider: provider });
    const tool = getTool("read") as ReturnType<typeof readerWith>;

    await withTempDir("pbe-subdir-prefetch-", async (cwd) => {
      await mkdir(join(cwd, "sub"));
      const nested = join(cwd, "sub", "nested.ts");
      await writeFile(nested, numbered(20), "utf-8");

      pi.startSession({ cwd });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetches).toBe(0);

      const result = await runRead(tool, cwd, {
        file: nested,
        windows: [{ offset: 3, limit: 2 }],
      });
      expect(notes(result)).toEqual(["[widened 3-4 -> 1-10, function fakeFn]"]);
    });

    expect(fetches).toBe(1);
  });

  it("does not prefetch while read.expansion is off", async () => {
    const previous = process.env[READ_EXPANSION_ENV_VAR];
    process.env[READ_EXPANSION_ENV_VAR] = "off";
    let fetches = 0;
    const provider = createAstSpanProvider({
      manifest: MANIFEST,
      runtimeAvailable: async () => true,
      fetchImpl: (async () => {
        fetches += 1;
        // SAFETY: Node's fetch accepts a Uint8Array body at runtime; the DOM BodyInit union narrows it.
        return new Response(GOOD_BYTES as unknown as BodyInit);
      }) as typeof fetch,
      loadGrammar: fakeLoader({ count: 0 }),
    });
    const { pi } = makeFakePiRegistry();
    regRead(pi, { spanProvider: provider });

    try {
      await withTempDir("pbe-prefetch-off-", async (cwd) => {
        await writeFile(join(cwd, "top.ts"), numbered(20), "utf-8");
        pi.startSession({ cwd });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(fetches).toBe(0);
      });
    } finally {
      if (previous === undefined) delete process.env[READ_EXPANSION_ENV_VAR];
      else process.env[READ_EXPANSION_ENV_VAR] = previous;
    }
  });
});
