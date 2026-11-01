/**
 * The AST boundary provider: every supported grammar through the shared lazy supply and decoration seams.
 *
 * The provider owns the boundary policy and the per-language handle cache; the grammar cache owns
 * fetch/verify and the runtime owns `web-tree-sitter`. A typed decline keeps "no provider",
 * "grammar unavailable" and "cold grammar" distinguishable at the audit seam, while every failure
 * still degrades to today's exact window.
 */
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  findEnclosingScope,
  scopeLineRange,
  type GrammarHandle,
  type GrammarLanguageLoader,
} from "./ast-span.js";
import { discardCachedGrammar, requestGrammar, type GrammarCacheOptions } from "./grammar-cache.js";
import { GRAMMAR_MANIFEST, grammarLanguageForFile } from "./grammar-manifest.js";
import { hasWebTreeSitterRuntime, loadWebTreeSitterGrammar } from "./grammar-runtime.js";
import type { OffsetWindow, SpanDecline, SpanProvider, SpanWindow } from "./span-expansion.js";
import { createScopeDecorator, type ScopeDecorator } from "./scope-decoration.js";
import type { SpanKindTable } from "./span-kind.js";
import { TYPESCRIPT_DECORATION } from "./typescript-decoration.js";
import { PYTHON_DECORATION } from "./python-decoration.js";
import { GO_DECORATION } from "./go-decoration.js";
import { RUST_DECORATION } from "./rust-decoration.js";

interface LanguageScope {
  readonly decorate: ScopeDecorator;
  readonly kinds: SpanKindTable;
}

export const LANGUAGES: Readonly<Record<string, LanguageScope>> = {
  typescript: {
    decorate: createScopeDecorator(TYPESCRIPT_DECORATION),
    kinds: TYPESCRIPT_DECORATION.kinds,
  },
  tsx: {
    decorate: createScopeDecorator(TYPESCRIPT_DECORATION),
    kinds: TYPESCRIPT_DECORATION.kinds,
  },
  python: {
    decorate: createScopeDecorator(PYTHON_DECORATION),
    kinds: PYTHON_DECORATION.kinds,
  },
  go: { decorate: createScopeDecorator(GO_DECORATION), kinds: GO_DECORATION.kinds },
  rust: { decorate: createScopeDecorator(RUST_DECORATION), kinds: RUST_DECORATION.kinds },
};

export interface AstSpanProviderOptions extends GrammarCacheOptions {
  /** Override the wasm loader (tests inject a parser-free tree). */
  loadGrammar?: GrammarLanguageLoader;
  /** Override file reading (tests can supply source directly). */
  readTextFile?: (path: string) => Promise<string | undefined>;
  /** Probe the optional wasm host; tests inject a resolution failure here. */
  runtimeAvailable?: () => Promise<boolean>;
}

type HandleOutcome =
  | { readonly kind: "ready"; readonly handle: GrammarHandle }
  | { readonly kind: "decline"; readonly decline: SpanDecline };

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

function grammarLanguagesForCwd(cwd: string): string[] {
  try {
    const languages = new Set<string>();
    for (const entry of readdirSync(cwd, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const language = grammarLanguageForFile(entry.name);
      if (language !== undefined) languages.add(language);
    }
    return [...languages];
  } catch {
    return [];
  }
}

function decline(refusal: SpanDecline["refusal"], language?: string): SpanDecline {
  return { refusal, ...(language === undefined ? {} : { language }) };
}

/**
 * Build a provider over one grammar manifest and one cache root. The handle cache is per provider,
 * so two reads in one session parse with one loaded grammar; a new provider still reuses the
 * verified file without a network call.
 */
export function createAstSpanProvider(options: AstSpanProviderOptions = {}): SpanProvider {
  const handles = new Map<string, Promise<HandleOutcome>>();
  const loadGrammar = options.loadGrammar ?? loadWebTreeSitterGrammar;
  const readText = options.readTextFile ?? defaultReadText;
  const runtimeAvailable = options.runtimeAvailable ?? hasWebTreeSitterRuntime;
  const usesDefaultRuntime = options.loadGrammar === undefined;
  let runtimeAbsent = false;

  const probeRuntime = async (): Promise<boolean> => {
    if (!usesDefaultRuntime) return true;
    try {
      return await runtimeAvailable();
    } catch {
      // SAFETY: an unresolvable optional module is an absent runtime, not a read failure.
      return false;
    }
  };

  const handleFor = (language: string): Promise<HandleOutcome> => {
    const existing = handles.get(language);
    if (existing !== undefined) return existing;
    const pending = (async (): Promise<HandleOutcome> => {
      try {
        if (!(await probeRuntime())) {
          runtimeAbsent = true;
          return { kind: "decline", decline: decline("runtime_absent", language) };
        }
        const fetched = await requestGrammar(language, options);
        if (fetched.status === "cold") {
          return { kind: "decline", decline: decline("cold_grammar", language) };
        }
        if (fetched.status === "unavailable") {
          return { kind: "decline", decline: decline("grammar_unavailable", language) };
        }
        const handle = await loadGrammar(fetched.artifact.bytes);
        if (handle === undefined) {
          if (!(await probeRuntime())) runtimeAbsent = true;
          discardCachedGrammar(fetched.artifact.path);
          return {
            kind: "decline",
            decline: decline(runtimeAbsent ? "runtime_absent" : "grammar_unavailable", language),
          };
        }
        return {
          kind: "ready",
          handle: {
            parse(source: string) {
              try {
                return handle.parse(source);
              } catch {
                handle.onFailure?.();
                discardCachedGrammar(fetched.artifact.path);
                return null;
              }
            },
            onFailure: () => {
              handle.onFailure?.();
              discardCachedGrammar(fetched.artifact.path);
            },
          },
        };
      } catch {
        // SAFETY: load failures are the same answer as no boundary; the read stays exact.
        return { kind: "decline", decline: decline("grammar_unavailable", language) };
      }
    })();
    handles.set(language, pending);
    // WHY: a failed or cold load is not memoized, so a later read can retry once the fetch lands.
    void pending.then((outcome) => {
      if (outcome.kind !== "ready") handles.delete(language);
    });
    return pending;
  };

  const prefetch = async (cwd?: string): Promise<void> => {
    const languages =
      cwd === undefined
        ? Object.keys(options.manifest ?? GRAMMAR_MANIFEST)
        : grammarLanguagesForCwd(cwd);
    if (languages.length === 0) return;
    if (!(await probeRuntime())) {
      runtimeAbsent = true;
      return;
    }
    // WHY: start every fetch now; the read path still waits only its own budget.
    await Promise.allSettled(languages.map((language) => requestGrammar(language, options)));
  };

  return {
    get runtimeAbsent() {
      return runtimeAbsent;
    },
    prefetch,
    async enclosingSpan(file: string, window: SpanWindow) {
      if (!isOffsetWindow(window)) return decline("provider_declined");
      const language = grammarLanguageForFile(file);
      if (language === undefined) return decline("no_provider");
      const source = await readText(file);
      if (source === undefined) return decline("provider_declined", language);
      const languageScope = LANGUAGES[language];
      if (languageScope === undefined) return decline("no_provider", language);
      const outcome = await handleFor(language);
      if (outcome.kind === "decline") return outcome.decline;
      const tree = outcome.handle.parse(source);
      if (tree === null) return decline("grammar_unavailable", language);
      try {
        if (tree.rootNode.hasError) return decline("provider_declined", language);
        const requestedEnd = window.offset + window.limit - 1;
        const node = findEnclosingScope(
          tree.rootNode,
          window.offset,
          requestedEnd,
          languageScope.kinds,
        );
        if (node === null) return decline("boundary_crossing", language);
        const range = scopeLineRange(node);
        if (range.startLine > window.offset || range.endLine < requestedEnd) {
          return decline("boundary_crossing", language);
        }
        const decorated = languageScope.decorate(node);
        if (decorated.kind === undefined || decorated.name === undefined) {
          return decline("provider_declined", language);
        }
        return {
          start: decorated.startLine,
          end: decorated.endLine,
          kind: decorated.kind,
          name: decorated.name,
          source: "ast",
        };
      } catch {
        outcome.handle.onFailure?.();
        return decline("provider_declined", language);
      } finally {
        tree.delete?.();
      }
    },
  };
}
