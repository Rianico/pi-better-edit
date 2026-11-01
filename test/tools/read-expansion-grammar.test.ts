import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import { ensureGrammar, grammarCachePath } from "../../src/read-expansion/grammar-cache";
import {
  findEnclosingScope,
  type GrammarLanguageLoader,
  type SyntaxNodeLike,
} from "../../src/read-expansion/ast-span";
import { createAstSpanProvider } from "../../src/read-expansion/ast-provider";
import { TYPESCRIPT_SPAN_KINDS } from "../../src/read-expansion/typescript-decoration";
import { loadWebTreeSitterGrammar } from "../../src/read-expansion/grammar-runtime";
import type {
  GrammarManifest,
  GrammarManifestEntry,
} from "../../src/read-expansion/grammar-manifest";
import {
  anchorRows,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

const GOOD_BYTES = new TextEncoder().encode("verified-grammar-bytes");
const ENTRY: GrammarManifestEntry = {
  language: "typescript",
  version: "test",
  url: "https://example.invalid/tree-sitter-typescript.wasm",
  sha256: createHash("sha256").update(GOOD_BYTES).digest("hex"),
};
const MANIFEST: GrammarManifest = { typescript: ENTRY };

type ReadResult = {
  content: Array<{ text?: string }>;
  details?: { widened?: unknown };
};

function numbered(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
}

function expectBytes(bytes: Uint8Array | undefined): void {
  expect(bytes).toBeDefined();
  expect(Buffer.from(bytes!).equals(Buffer.from(GOOD_BYTES))).toBe(true);
}

function servedLines(text: string): string[] {
  return anchorRows(text).map((row) => row.slice(row.indexOf("│") + 1));
}

function widenedNotes(text: string): string[] {
  return text.split("\n").filter((line) => line.includes("[widened "));
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
    calls.count++;
    return { parse: () => ({ rootNode: fakeTree() }) };
  };
}

function fetchReturning(bytes: Uint8Array, calls: { count: number }): typeof fetch {
  return (async () => {
    calls.count++;
    // SAFETY: Node's fetch accepts a Uint8Array body at runtime; the DOM BodyInit union narrows it.
    return new Response(bytes as unknown as BodyInit);
  }) as typeof fetch;
}

function fetchFailing(calls: { count: number }): typeof fetch {
  return (async () => {
    calls.count++;
    throw new Error("offline");
  }) as typeof fetch;
}

function readToolWith(options: Parameters<typeof createAstSpanProvider>[0]) {
  const { pi, getTool } = makeFakePiRegistry();
  regRead(pi, { spanProvider: createAstSpanProvider(options) });
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
  tool: ReturnType<typeof readToolWith>,
  cwd: string,
  params: unknown,
): Promise<ReadResult> {
  return tool.execute("grammar-test", params, undefined, undefined, {
    cwd,
    sessionManager: testSessionManager,
  });
}

describe("read expansion grammar supply", () => {
  it("fetches once, verifies the digest, and reuses the cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "pbe-grammar-"));
    try {
      const fetches = { count: 0 };
      const first = await ensureGrammar("typescript", {
        cacheRoot: root,
        manifest: MANIFEST,
        fetchImpl: fetchReturning(GOOD_BYTES, fetches),
      });
      const path = grammarCachePath("typescript", ENTRY, root);

      expectBytes(first?.bytes);
      expect(fetches.count).toBe(1);
      expect(existsSync(path)).toBe(true);

      const second = await ensureGrammar("typescript", {
        cacheRoot: root,
        manifest: MANIFEST,
        fetchImpl: fetchFailing(fetches),
      });
      expectBytes(second?.bytes);
      expect(fetches.count).toBe(1);

      writeFileSync(path, Buffer.from("corrupt cache"));
      const third = await ensureGrammar("typescript", {
        cacheRoot: root,
        manifest: MANIFEST,
        fetchImpl: fetchReturning(GOOD_BYTES, fetches),
      });
      expectBytes(third?.bytes);
      expect(fetches.count).toBe(2);
      expect(readFileSync(path).equals(Buffer.from(GOOD_BYTES))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on an offline first use or a fetched digest mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pbe-grammar-"));
    try {
      const fetches = { count: 0 };
      const offline = await ensureGrammar("typescript", {
        cacheRoot: root,
        manifest: MANIFEST,
        fetchImpl: fetchFailing(fetches),
      });
      expect(offline).toBeUndefined();
      expect(existsSync(grammarCachePath("typescript", ENTRY, root))).toBe(false);

      const wrong = new TextEncoder().encode("wrong bytes");
      const mismatch = await ensureGrammar("typescript", {
        cacheRoot: root,
        manifest: MANIFEST,
        fetchImpl: fetchReturning(wrong, fetches),
      });
      expect(mismatch).toBeUndefined();
      expect(existsSync(grammarCachePath("typescript", ENTRY, root))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fetches one grammar on the first read, reuses it, and widens", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "pbe-grammar-"));
    const fetches = { count: 0 };
    const loads = { count: 0 };
    const fetchImpl = fetchReturning(GOOD_BYTES, fetches);
    const loadGrammar = fakeLoader(loads);
    try {
      await withTempFile("grammar.ts", numbered(20), async ({ cwd, path }) => {
        const tool = readToolWith({ cacheRoot, manifest: MANIFEST, fetchImpl, loadGrammar });
        const first = await runRead(tool, cwd, {
          file: path,
          windows: [{ offset: 3, limit: 2 }],
        });

        expect(servedLines(getText(first))).toHaveLength(10);
        expect(widenedNotes(getText(first))).toEqual(["[widened 3-4 -> 1-10, function fakeFn]"]);
        expect(first.details?.widened).toBeUndefined();
        expect(fetches.count).toBe(1);
        expect(loads.count).toBe(1);

        const second = await runRead(tool, cwd, {
          file: path,
          windows: [{ offset: 3, limit: 2 }],
        });
        expect(widenedNotes(getText(second))).toEqual(["[widened 3-4 -> 1-10, function fakeFn]"]);
        expect(fetches.count).toBe(1);
        expect(loads.count).toBe(1);

        const cachedTool = readToolWith({
          cacheRoot,
          manifest: MANIFEST,
          fetchImpl: fetchFailing(fetches),
          loadGrammar,
        });
        const third = await runRead(cachedTool, cwd, {
          file: path,
          windows: [{ offset: 3, limit: 2 }],
        });
        expect(widenedNotes(getText(third))).toEqual(["[widened 3-4 -> 1-10, function fakeFn]"]);
        expect(fetches.count).toBe(1);
        expect(loads.count).toBe(2);
      });
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("degrades to the exact read when the first grammar fetch is offline", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "pbe-grammar-"));
    const fetches = { count: 0 };
    const loads = { count: 0 };
    try {
      await withTempFile("offline.ts", numbered(20), async ({ cwd, path }) => {
        const tool = readToolWith({
          cacheRoot,
          manifest: MANIFEST,
          fetchImpl: fetchFailing(fetches),
          loadGrammar: fakeLoader(loads),
        });
        const result = await runRead(tool, cwd, {
          file: path,
          windows: [{ offset: 3, limit: 2 }],
        });

        expect(servedLines(getText(result))).toEqual(["line 3", "line 4"]);
        expect(widenedNotes(getText(result))).toEqual([]);
        expect(fetches.count).toBe(1);
        expect(loads.count).toBe(0);
      });
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("discards a corrupt cached grammar instead of crashing the read", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "pbe-grammar-"));
    const fetches = { count: 0 };
    const loads = { count: 0 };
    try {
      const seeded = await ensureGrammar("typescript", {
        cacheRoot,
        manifest: MANIFEST,
        fetchImpl: fetchReturning(GOOD_BYTES, fetches),
      });
      expect(seeded).toBeDefined();
      writeFileSync(seeded!.path, Buffer.from("corrupt wasm with the right name"));

      await withTempFile("corrupt.ts", numbered(20), async ({ cwd, path }) => {
        const tool = readToolWith({
          cacheRoot,
          manifest: MANIFEST,
          fetchImpl: fetchReturning(GOOD_BYTES, fetches),
          loadGrammar: fakeLoader(loads),
        });
        const result = await runRead(tool, cwd, {
          file: path,
          windows: [{ offset: 3, limit: 2 }],
        });

        expect(widenedNotes(getText(result))).toEqual(["[widened 3-4 -> 1-10, function fakeFn]"]);
        expect(fetches.count).toBe(2);
        expect(readFileSync(seeded!.path).equals(Buffer.from(GOOD_BYTES))).toBe(true);
      });
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("discards verified bytes that the runtime cannot load", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "pbe-grammar-"));
    try {
      const seeded = await ensureGrammar("typescript", {
        cacheRoot,
        manifest: MANIFEST,
        fetchImpl: fetchReturning(GOOD_BYTES, { count: 0 }),
      });
      expect(seeded).toBeDefined();

      await withTempFile("bad-wasm.ts", numbered(20), async ({ cwd, path }) => {
        const tool = readToolWith({
          cacheRoot,
          manifest: MANIFEST,
          fetchImpl: fetchFailing({ count: 0 }),
          loadGrammar: async () => undefined,
        });
        const result = await runRead(tool, cwd, {
          file: path,
          windows: [{ offset: 3, limit: 2 }],
        });

        expect(servedLines(getText(result))).toEqual(["line 3", "line 4"]);
        expect(widenedNotes(getText(result))).toEqual([]);
        expect(existsSync(seeded!.path)).toBe(false);
      });
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the wasm runtime cannot load verified bytes", async () => {
    await expect(loadWebTreeSitterGrammar(new Uint8Array([0, 97, 115, 109]))).resolves.toBe(
      undefined,
    );
  });

  it("picks the smallest scope and leaves header lines exact", async () => {
    const tree = fakeTree();
    expect(findEnclosingScope(tree, 3, 4, TYPESCRIPT_SPAN_KINDS)?.type).toBe(
      "function_declaration",
    );
    expect(findEnclosingScope(tree, 15, 16, TYPESCRIPT_SPAN_KINDS)).toBeNull();
  });
});
