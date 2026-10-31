/**
 * The AST boundary provider: every supported grammar through the shared lazy supply and decoration seams.
 *
 * The provider owns the boundary policy and the per-language handle cache; the grammar cache owns
 * fetch/verify and the runtime owns `web-tree-sitter`. Any failure on any layer returns null, which
 * the read seam turns into today's exact window.
 */
import { readFile } from "node:fs/promises";
import {
  findEnclosingScope,
  scopeKind,
  scopeLineRange,
  scopeName,
  type GrammarHandle,
  type GrammarLanguageLoader,
} from "./ast-span.js";
import { discardCachedGrammar, ensureGrammar, type GrammarCacheOptions } from "./grammar-cache.js";
import { grammarLanguageForFile } from "./grammar-manifest.js";
import { loadWebTreeSitterGrammar } from "./grammar-runtime.js";
import type { OffsetWindow, SpanProvider, SpanWindow } from "./span-expansion.js";
import { createScopeDecorator, type ScopeDecorator } from "./scope-decoration.js";
import { TYPESCRIPT_DECORATION } from "./typescript-decoration.js";
import { PYTHON_DECORATION } from "./python-decoration.js";
import { GO_DECORATION } from "./go-decoration.js";
import { RUST_DECORATION } from "./rust-decoration.js";

const DECORATIONS: Readonly<Record<string, ScopeDecorator>> = {
  typescript: createScopeDecorator(TYPESCRIPT_DECORATION),
  tsx: createScopeDecorator(TYPESCRIPT_DECORATION),
  python: createScopeDecorator(PYTHON_DECORATION),
  go: createScopeDecorator(GO_DECORATION),
  rust: createScopeDecorator(RUST_DECORATION),
};

export interface AstSpanProviderOptions extends GrammarCacheOptions {
  /** Override the wasm loader (tests inject a parser-free tree). */
  loadGrammar?: GrammarLanguageLoader;
  /** Override file reading (tests can supply source directly). */
  readTextFile?: (path: string) => Promise<string | undefined>;
}

function isOffsetWindow(window: SpanWindow): window is OffsetWindow {
  return "offset" in window && "limit" in window;
}

async function defaultReadText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Build a provider over one grammar manifest and one cache root. The handle cache is per provider,
 * so two reads in one session parse with one loaded grammar; a new provider still reuses the
 * verified file without a network call.
 */
export function createAstSpanProvider(options: AstSpanProviderOptions = {}): SpanProvider {
  const handles = new Map<string, Promise<GrammarHandle | undefined>>();
  const loadGrammar = options.loadGrammar ?? loadWebTreeSitterGrammar;
  const readText = options.readTextFile ?? defaultReadText;

  const handleFor = (language: string): Promise<GrammarHandle | undefined> => {
    const existing = handles.get(language);
    if (existing !== undefined) return existing;
    const pending = (async (): Promise<GrammarHandle | undefined> => {
      try {
        const artifact = await ensureGrammar(language, options);
        if (artifact === undefined) return undefined;
        const handle = await loadGrammar(artifact.bytes);
        if (handle === undefined) {
          discardCachedGrammar(artifact.path);
          return undefined;
        }
        return {
          parse(source: string) {
            try {
              return handle.parse(source);
            } catch {
              handle.onFailure?.();
              discardCachedGrammar(artifact.path);
              return null;
            }
          },
          onFailure: () => {
            handle.onFailure?.();
            discardCachedGrammar(artifact.path);
          },
        };
      } catch {
        // SAFETY: load failures are the same answer as no boundary; the read stays exact.
        return undefined;
      }
    })();
    handles.set(language, pending);
    // WHY: a failed load is not memoized, so a later read can retry once the network returns.
    void pending.then((handle) => {
      if (handle === undefined) handles.delete(language);
    });
    return pending;
  };

  return {
    async enclosingSpan(file: string, window: SpanWindow) {
      if (!isOffsetWindow(window)) return null;
      const language = grammarLanguageForFile(file);
      if (language === undefined) return null;
      const source = await readText(file);
      if (source === undefined) return null;
      const decorate = DECORATIONS[language];
      if (decorate === undefined) return null;
      const handle = await handleFor(language);
      if (handle === undefined) return null;
      const tree = handle.parse(source);
      if (tree === null) return null;
      try {
        if (tree.rootNode.hasError) return null;
        const requestedEnd = window.offset + window.limit - 1;
        const node = findEnclosingScope(tree.rootNode, window.offset, requestedEnd);
        if (node === null) return null;
        const range = scopeLineRange(node);
        if (range.startLine > window.offset || range.endLine < requestedEnd) return null;
        const decorated = decorate(node);
        return {
          start: decorated.startLine,
          end: decorated.endLine,
          kind: decorated.kind ?? scopeKind(node),
          name: decorated.name ?? scopeName(node),
          source: "ast",
        };
      } catch {
        handle.onFailure?.();
        return null;
      } finally {
        tree.delete?.();
      }
    },
  };
}
