/** The one provider the read tool receives: Markdown, paragraphs, data or AST by path. */
import { createAstSpanProvider, type AstSpanProviderOptions } from "./ast-provider.js";
import { createMarkdownSpanProvider, isMarkdownPath } from "./markdown-provider.js";
import { createParagraphSpanProvider, isDataPath, isPlainTextPath } from "./paragraph-provider.js";
import type { SpanProvider } from "./span-expansion.js";

/** Compose the Markdown, paragraph, data and AST providers behind the existing read seam. */
export function createReadSpanProvider(options: AstSpanProviderOptions = {}): SpanProvider {
  const ast = createAstSpanProvider(options);
  const markdown = createMarkdownSpanProvider(
    options.readTextFile === undefined ? {} : { readTextFile: options.readTextFile },
  );
  const paragraph = createParagraphSpanProvider(
    options.readTextFile === undefined ? {} : { readTextFile: options.readTextFile },
  );
  return {
    enclosingSpan(file, window) {
      if (isMarkdownPath(file)) return markdown.enclosingSpan(file, window);
      if (isDataPath(file)) return null;
      if (isPlainTextPath(file)) return paragraph.enclosingSpan(file, window);
      return ast.enclosingSpan(file, window);
    },
  };
}
