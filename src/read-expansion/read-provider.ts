/** The one provider the read tool receives: Markdown, paragraphs, data, shell or AST by path. */
import {
  createAstSpanProvider,
  type AstSpanProviderOptions,
  type OutlineSymbol,
} from "./ast-provider.js";
import { createBashSpanProvider, isShellPath } from "./bash-provider.js";
import { grammarLanguageForFile } from "./grammar-manifest.js";
import { createMarkdownSpanProvider, isMarkdownPath } from "./markdown-provider.js";
import { createParagraphSpanProvider, isDataPath, isPlainTextPath } from "./paragraph-provider.js";
import type { SpanProvider, SpanSource } from "./provider-contract.js";
import {
  DEFAULT_QUALIFIED_NAME_TIMEOUT_MS,
  withQualifiedNames,
  type QualifiedNameResolver,
} from "./qualified-names.js";

/**
 * The source this path's provider answers with, or `undefined` when no provider is registered.
 *
 * The read's pre-lookup gate uses this to decline a data file or an unregistered extension before a
 * provider is called, so an ordinary read pays no parse work and writes no log row.
 */
export function providerSourceFor(file: string): SpanSource | undefined {
  if (isMarkdownPath(file)) return "md";
  if (isDataPath(file)) return undefined;
  if (isPlainTextPath(file)) return "text";
  if (isShellPath(file)) return "ast";
  return grammarLanguageForFile(file) === undefined ? undefined : "ast";
}

export interface ReadSpanProviderOptions extends AstSpanProviderOptions {
  /** An already-attached server resolver, or undefined when no server is attached. */
  qualifiedNameResolver?: QualifiedNameResolver;
  /** Upper bound on the optional resolver; ignored when no resolver is injected. */
  qualifiedNameTimeoutMs?: number;
}

/** The read provider plus the tranche-1 outline seam (kept off the shared `SpanProvider` contract). */
export interface OutlineCapableProvider extends SpanProvider {
  outline(file: string): Promise<readonly OutlineSymbol[]>;
}

/** Compose the text-shaped and AST providers behind the existing read seam. */
export function createReadSpanProvider(
  options: ReadSpanProviderOptions = {},
): OutlineCapableProvider {
  const ast = createAstSpanProvider(options);
  const markdown = createMarkdownSpanProvider(
    options.readTextFile === undefined ? {} : { readTextFile: options.readTextFile },
  );
  const paragraph = createParagraphSpanProvider(
    options.readTextFile === undefined ? {} : { readTextFile: options.readTextFile },
  );
  const bash = createBashSpanProvider(
    options.readTextFile === undefined ? {} : { readTextFile: options.readTextFile },
  );
  const base: SpanProvider = {
    get runtimeAbsent() {
      return ast.runtimeAbsent === true;
    },
    prefetch(cwd?: string) {
      return ast.prefetch?.(cwd);
    },
    enclosingChain(file, window) {
      if (isMarkdownPath(file)) return markdown.enclosingChain(file, window);
      if (isDataPath(file)) return { refusal: "no_provider" };
      if (isPlainTextPath(file)) return paragraph.enclosingChain(file, window);
      if (isShellPath(file)) return bash.enclosingChain(file, window);
      return ast.enclosingChain(file, window);
    },
  };
  const outline = (file: string): Promise<readonly OutlineSymbol[]> => ast.outline(file);
  const wrapped = withQualifiedNames(
    base,
    options.qualifiedNameResolver,
    options.qualifiedNameTimeoutMs ?? DEFAULT_QUALIFIED_NAME_TIMEOUT_MS,
  );
  if (wrapped === base) return Object.assign(base, { outline });
  // WHY: the qualified-name wrapper rebuilds the provider object, so the outline seam is
  // WHY: re-attached by delegation instead of spreading `wrapped` (which would freeze the live
  // WHY: `runtimeAbsent` getter into one reading).
  return {
    get runtimeAbsent() {
      return wrapped.runtimeAbsent === true;
    },
    prefetch(cwd?: string) {
      return wrapped.prefetch?.(cwd);
    },
    enclosingChain(file, window) {
      return wrapped.enclosingChain(file, window);
    },
    outline,
  };
}
