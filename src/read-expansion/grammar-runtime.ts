/**
 * The default grammar runtime: `web-tree-sitter` plus digest-verified grammar bytes.
 *
 * WHY the runtime is the only dependency: grammars are fetched bytes, so the package grows only by
 * the wasm host, never by a grammar set. `Language.load` accepts the verified bytes directly, so no
 * second disk read is needed after the cache check.
 */
import { Language, Parser } from "web-tree-sitter";
import type { GrammarHandle, SyntaxNodeLike } from "./ast-span.js";

let parserInit: Promise<void> | undefined;

async function initializeParser(): Promise<void> {
  parserInit ??= Parser.init();
  try {
    await parserInit;
  } catch {
    // WHY: a failed host init is retried on the next read rather than poisoning the process.
    parserInit = undefined;
    throw new Error("web-tree-sitter init failed");
  }
}

/**
 * Turn verified bytes into a parser handle. Any failure (incompatible wasm, corrupt bytes after a
 * digest match) returns undefined; the provider discards the cache entry.
 */
export async function loadWebTreeSitterGrammar(
  bytes: Uint8Array,
): Promise<GrammarHandle | undefined> {
  try {
    await initializeParser();
    const grammar = await Language.load(bytes);
    const parser = new Parser();
    parser.setLanguage(grammar);
    return {
      parse(source: string) {
        const tree = parser.parse(source);
        if (tree === null) return null;
        return {
          // SAFETY: the parser-neutral shape is a structural subset of web-tree-sitter's Node; the
          // SAFETY: runtime owns this adapter, so no grammar-specific type crosses the seam.
          rootNode: tree.rootNode as unknown as SyntaxNodeLike,
          delete: () => tree.delete(),
        };
      },
    };
  } catch {
    return undefined;
  }
}
