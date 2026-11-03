import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAstSpanProvider } from "../../src/read-expansion/ast-provider";
import type { GrammarHandle, SyntaxNodeLike } from "../../src/read-expansion/ast-span";
import { createBashSpanProvider } from "../../src/read-expansion/bash-provider";
import { primeGrammarForTests } from "../../src/read-expansion/grammar-cache";
import { createMarkdownSpanProvider } from "../../src/read-expansion/markdown-provider";
import { createParagraphSpanProvider } from "../../src/read-expansion/paragraph-provider";
import { withTempFile } from "../support/fixtures";

const reader = (text: string) => async () => text;

// WHY the expectations below wrap in `{ spans: [...] }`: the seam now answers an
// innermost-first chain anchored on the window's first line (selectionRange), not one span.

describe("provider witnesses: enclosingChain answers per source", () => {
  it("markdown answers the heading section", async () => {
    const text = "# Guide\n\nIntro.\n\n## Language\n\nAlpha.\nBeta.\n\n## Next\n\ntail\n";
    await withTempFile("guide.md", text, async ({ path }) => {
      const provider = createMarkdownSpanProvider({ readTextFile: reader(text) });
      expect(await provider.enclosingChain(path, { offset: 7, limit: 1 })).toEqual({
        spans: [
          {
            start: 5,
            end: 9,
            kind: "section",
            name: "Language",
            source: "md",
          },
        ],
      });
    });
  });

  it("paragraph answers the blank-line block", async () => {
    const text = "one\ntwo\n\nthree\nfour\n";
    await withTempFile("note.txt", text, async ({ path }) => {
      const provider = createParagraphSpanProvider({ readTextFile: reader(text) });
      expect(await provider.enclosingChain(path, { offset: 1, limit: 1 })).toEqual({
        spans: [
          {
            start: 1,
            end: 2,
            kind: "paragraph",
            name: "lines 1-2",
            source: "text",
          },
        ],
      });
    });
  });

  it("shell answers the function", async () => {
    const text = "#!/bin/sh\nfoo() {\n  echo hi\n}\nbar() {\n  :\n}\n";
    await withTempFile("run.sh", text, async ({ path }) => {
      const provider = createBashSpanProvider({ readTextFile: reader(text) });
      const chain = await provider.enclosingChain(path, { offset: 3, limit: 1 });
      expect(chain).toMatchObject({
        spans: [
          {
            start: 2,
            end: 4,
            kind: "function",
            name: "foo",
            source: "ast",
          },
        ],
      });
    });
  });

  it("a data path declines", async () => {
    const provider = createMarkdownSpanProvider({ readTextFile: reader("a,b\n1,2\n") });
    expect(await provider.enclosingChain("rows.csv", { offset: 1, limit: 1 })).toEqual({
      refusal: "no_provider",
    });
  });
});

describe("provider witness: AST through a primed grammar fixture", () => {
  type Node = SyntaxNodeLike & { parent?: SyntaxNodeLike | null };

  function node(spec: {
    type: string;
    start: number;
    end: number;
    text?: string;
    children?: SyntaxNodeLike[];
    name?: SyntaxNodeLike;
  }): Node {
    return {
      type: spec.type,
      startPosition: { row: spec.start, column: 0 },
      endPosition: { row: spec.end, column: 1 },
      hasError: false,
      namedChildren: spec.children ?? [],
      ...(spec.text === undefined ? {} : { text: spec.text }),
      ...(spec.name === undefined
        ? {}
        : { childForFieldName: (field: string) => (field === "name" ? spec.name! : null) }),
    };
  }

  it("answers the enclosing function chain from a fake tree", async () => {
    const text = "function parseArgs() {\n  return 1;\n}\n";
    await withTempFile("app.tsx", text, async ({ path }) => {
      const identifier = node({ type: "identifier", start: 0, end: 0, text: "parseArgs" });
      const fn = node({
        type: "function_declaration",
        start: 0,
        end: 2,
        text,
        children: [identifier],
        name: identifier,
      });
      const root = node({ type: "program", start: 0, end: 2, children: [fn] });
      identifier.parent = fn;
      fn.parent = root;
      const handle: GrammarHandle = { parse: () => ({ rootNode: root }) };
      const bytes = gunzipSync(
        readFileSync(join("test", "fixtures", "grammars", "tree-sitter-tsx.wasm.gz")),
      );
      // WHY inside withTempFile: the cache path derives from HOME, which the fixture repoints.
      primeGrammarForTests("tsx", bytes);
      const provider = createAstSpanProvider({
        loadGrammar: async () => handle,
        runtimeAvailable: async () => true,
        readTextFile: reader(text),
      });
      const chain = await provider.enclosingChain(path, { offset: 2, limit: 1 });
      expect(chain, JSON.stringify(chain)).toMatchObject({
        spans: [
          {
            start: 1,
            end: 3,
            kind: "function",
            name: "parseArgs",
            source: "ast",
          },
        ],
      });
    });
  });
});
