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
  findEnclosingChain,
  type GrammarHandle,
  type GrammarLanguageLoader,
  type SyntaxNodeLike,
} from "./ast-span.js";
import { discardCachedGrammar, requestGrammar, type GrammarCacheOptions } from "./grammar-cache.js";
import { GRAMMAR_MANIFEST, grammarLanguageForFile } from "./grammar-manifest.js";
import { hasWebTreeSitterRuntime, loadWebTreeSitterGrammar } from "./grammar-runtime.js";
import type { OffsetWindow, SpanDecline, SpanProvider, SpanWindow } from "./provider-contract.js";
import { createScopeDecorator, type ScopeDecorator } from "./scope-decoration.js";
import type { SpanKind, SpanKindTable } from "./span-kind.js";
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

/**
 * One outline row: a named symbol and its 1-indexed physical declaration line. The line is the
 * scope node's own start row, never the decorated span start, so leading documentation and
 * decorators never move the row and no text beyond the name is pulled. Tranche 2 derives point
 * anchors from these raw lines (ADR-0013).
 */
export interface OutlineSymbol {
  readonly name: string;
  readonly kind: SpanKind;
  readonly line: number;
}

/**
 * The AST provider with the outline seam. `outline` stays off the shared `SpanProvider`
 * contract: only the grammar provider can answer it, and the text/markdown/bash providers
 * must keep compiling unchanged.
 */
export interface AstSpanProvider extends SpanProvider {
  outline(file: string): Promise<readonly OutlineSymbol[]>;
}

/**
 * The tranche-1 outline vocabulary, in LSP `SymbolKind` terms: containers, executable
 * definitions, top-level constants, and type parameters. Anything else the tables produce
 * (`arrow`, `impl`, `trait`, `typeAlias`) is a real scope but not an outline row. `module`
 * stays out: LSP vocabulary no tranche-1 table emits, so no row can pin it.
 */
const OUTLINE_KINDS: ReadonlySet<SpanKind> = new Set<SpanKind>([
  "class",
  "interface",
  "struct",
  "enum",
  "namespace",
  "function",
  "method",
  "constructor",
  "constant",
  "typeParameter",
]);

/** Wrappers a TypeScript top-level declaration may hide behind (`export`, `declare`). */
const TS_OUTLINE_WRAPPERS: ReadonlySet<string> = new Set([
  "export_statement",
  "ambient_declaration",
]);

/** File roots across the five languages (`program` is TypeScript/TSX, `source_file` is Go/Rust, `module` is Python). */
const OUTLINE_ROOTS: ReadonlySet<string> = new Set(["program", "source_file", "module"]);

/**
 * Named function values report through their own scope node (`const g = function () {}` is a
 * `function` row), so the declarator must not also claim them as `constant`. Arrow values have
 * no outline row of their own, so their declarator keeps the `constant` row.
 */
const TS_FUNCTION_VALUES: ReadonlySet<string> = new Set([
  "function_expression",
  "generator_function",
]);

/** The declaration statement a TypeScript declarator belongs to, through export/declare wrappers. */
function tsOutlineStatement(node: SyntaxNodeLike): SyntaxNodeLike | undefined {
  const lexical = node.parent;
  if (lexical === null || lexical === undefined || lexical.type !== "lexical_declaration")
    return undefined;
  // WHY: one grammar node type covers const/let/var, so only the keyword proves a constant.
  if (!/^\s*const\b/.test(lexical.text ?? "")) return undefined;
  if (node.namedChildren.some((child) => TS_FUNCTION_VALUES.has(child.type))) return undefined;
  let current = lexical.parent;
  while (current !== null && current !== undefined && TS_OUTLINE_WRAPPERS.has(current.type)) {
    current = current.parent;
  }
  return current ?? undefined;
}

/** A TypeScript `const` declarator is an outline row only at file or namespace top level. */
function isTopLevelConstDeclarator(node: SyntaxNodeLike): boolean {
  const statement = tsOutlineStatement(node);
  if (statement === undefined) return false;
  if (OUTLINE_ROOTS.has(statement.type)) return true;
  // WHY: namespace members are module API while function bodies hold locals, so only a block owned by a namespace module passes.
  if (statement.type !== "statement_block") return false;
  const owner = statement.parent;
  return owner?.type === "internal_module" || owner?.type === "module";
}

/**
 * One Go `type_spec` covers structs, interfaces, and plain aliases; only the first two are
 * outline rows. The rest keep the table's `typeAlias`, which the outline filter drops.
 */
function goTypeSpecKind(node: SyntaxNodeLike): SpanKind | undefined {
  let sawInterface = false;
  for (const child of node.namedChildren) {
    if (child.type === "struct_type") return "struct";
    if (child.type === "interface_type") sawInterface = true;
  }
  return sawInterface ? "interface" : undefined;
}

/** A Go `const_spec` is an outline row only directly under a file-level `const` block. */
function isTopLevelGoConst(node: SyntaxNodeLike): boolean {
  const declaration = node.parent;
  if (
    declaration === null ||
    declaration === undefined ||
    declaration.type !== "const_declaration"
  ) {
    return false;
  }
  const scope = declaration.parent;
  return scope !== null && scope !== undefined && scope.type === "source_file";
}

/**
 * Contract kinds the per-language decoration tables do not cover, grounded against the pinned
 * grammars: TypeScript `const` declarators and type parameters, Go structs/interfaces and file
 * constants, Rust structs/enums and file constants. Python has no `const` signal in its grammar
 * (every module assignment would qualify), so it ships no supplement in this tranche.
 */
function supplementOutlineKind(language: string, node: SyntaxNodeLike): SpanKind | undefined {
  switch (language) {
    case "typescript":
    case "tsx": {
      if (node.type === "type_parameter") return "typeParameter";
      if (node.type === "variable_declarator" && isTopLevelConstDeclarator(node)) return "constant";
      return undefined;
    }
    case "go": {
      if (node.type === "type_spec") return goTypeSpecKind(node);
      if (node.type === "const_spec" && isTopLevelGoConst(node)) return "constant";
      return undefined;
    }
    case "rust": {
      if (node.type === "struct_item") return "struct";
      if (node.type === "enum_item") return "enum";
      if (node.type === "const_item") {
        const scope = node.parent;
        return scope?.type === "source_file" ? "constant" : undefined;
      }
      return undefined;
    }
    default: {
      return undefined;
    }
  }
}

/**
 * Every named outline symbol in the file, in line order. Each row maps strictly to its scope
 * node's own start row — the physical declaration line — so leading documentation and
 * decorators never move the row, and no text beyond the name is pulled.
 */
function collectOutlineSymbols(
  root: SyntaxNodeLike,
  scope: LanguageScope,
  language: string,
): OutlineSymbol[] {
  const rows: OutlineSymbol[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node !== root) {
      const decorated = scope.decorate(node);
      // WHY: a Go struct is a table typeAlias but an outline struct, and the supplement only fires on its own node types.
      const kind = supplementOutlineKind(language, node) ?? decorated.kind;
      if (kind !== undefined && OUTLINE_KINDS.has(kind) && decorated.name !== undefined) {
        // WHY: the grammar parses a constructor as a method literally named constructor, while LSP names it Constructor.
        rows.push({
          name: decorated.name,
          kind: kind === "method" && decorated.name === "constructor" ? "constructor" : kind,
          line: node.startPosition.row + 1,
        });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  // WHY: the walk is source-ordered, but a stable line sort keeps injected trees deterministic for the tranche-2 anchor seam.
  rows.sort((a, b) => a.line - b.line);
  return rows;
}

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
export function createAstSpanProvider(options: AstSpanProviderOptions = {}): AstSpanProvider {
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
    async enclosingChain(file: string, window: SpanWindow) {
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
        const chain = findEnclosingChain(tree.rootNode, window.offset, languageScope.kinds);
        if (chain.length === 0) return decline("boundary_crossing", language);
        const spans: Array<{
          start: number;
          end: number;
          kind: NonNullable<ReturnType<ScopeDecorator>["kind"]>;
          name: string;
          source: "ast";
        }> = [];
        for (const node of chain) {
          const decorated = languageScope.decorate(node);
          if (decorated.kind === undefined || decorated.name === undefined) continue;
          spans.push({
            start: decorated.startLine,
            end: decorated.endLine,
            kind: decorated.kind,
            name: decorated.name,
            source: "ast",
          });
        }
        if (spans.length === 0) return decline("provider_declined", language);
        return { spans };
      } catch {
        outcome.handle.onFailure?.();
        return decline("provider_declined", language);
      } finally {
        tree.delete?.();
      }
    },
    async outline(file: string): Promise<readonly OutlineSymbol[]> {
      try {
        const language = grammarLanguageForFile(file);
        if (language === undefined) return [];
        const source = await readText(file);
        if (source === undefined) return [];
        const languageScope = LANGUAGES[language];
        if (languageScope === undefined) return [];
        const outcome = await handleFor(language);
        if (outcome.kind === "decline") return [];
        const tree = outcome.handle.parse(source);
        if (tree === null) return [];
        try {
          return collectOutlineSymbols(tree.rootNode, languageScope, language);
        } finally {
          tree.delete?.();
        }
      } catch {
        // SAFETY: a symbol-free or unparseable file yields an empty list, never a throw.
        return [];
      }
    },
  };
}
