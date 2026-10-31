/** The one provider the read tool receives: Markdown by path, AST grammars otherwise. */
import { createAstSpanProvider, type AstSpanProviderOptions } from "./ast-provider.js";
import { createMarkdownSpanProvider, isMarkdownPath } from "./markdown-provider.js";
import type { SpanProvider } from "./span-expansion.js";

/** Compose the Markdown and AST providers behind the existing read seam. */
export function createReadSpanProvider(options: AstSpanProviderOptions = {}): SpanProvider {
  const ast = createAstSpanProvider(options);
  const markdown = createMarkdownSpanProvider(
    options.readTextFile === undefined ? {} : { readTextFile: options.readTextFile },
  );
  return {
    enclosingSpan(file, window) {
      return isMarkdownPath(file)
        ? markdown.enclosingSpan(file, window)
        : ast.enclosingSpan(file, window);
    },
  };
}
