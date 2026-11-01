/** The one provider the read tool receives: Markdown, paragraphs, data, shell or AST by path. */
import { createAstSpanProvider, type AstSpanProviderOptions } from "./ast-provider.js";
import { createMarkdownSpanProvider, isMarkdownPath } from "./markdown-provider.js";
import { createBashSpanProvider, isShellPath } from "./bash-provider.js";
import { createParagraphSpanProvider, isDataPath, isPlainTextPath } from "./paragraph-provider.js";
import type { SpanProvider } from "./span-expansion.js";
import {
  DEFAULT_QUALIFIED_NAME_TIMEOUT_MS,
  withQualifiedNames,
  type QualifiedNameResolver,
} from "./qualified-names.js";

export interface ReadSpanProviderOptions extends AstSpanProviderOptions {
  /** An already-attached server resolver, or undefined when no server is attached. */
  qualifiedNameResolver?: QualifiedNameResolver;
  /** Upper bound on the optional resolver; ignored when no resolver is injected. */
  qualifiedNameTimeoutMs?: number;
}

/** Compose the text-shaped and AST providers behind the existing read seam. */
export function createReadSpanProvider(options: ReadSpanProviderOptions = {}): SpanProvider {
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
    enclosingSpan(file, window) {
      if (isMarkdownPath(file)) return markdown.enclosingSpan(file, window);
      if (isDataPath(file)) return null;
      if (isPlainTextPath(file)) return paragraph.enclosingSpan(file, window);
      if (isShellPath(file)) return bash.enclosingSpan(file, window);
      return ast.enclosingSpan(file, window);
    },
  };
  return withQualifiedNames(
    base,
    options.qualifiedNameResolver,
    options.qualifiedNameTimeoutMs ?? DEFAULT_QUALIFIED_NAME_TIMEOUT_MS,
  );
}
