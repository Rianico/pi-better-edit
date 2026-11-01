/**
 * The default grammar runtime: `web-tree-sitter` plus digest-verified grammar bytes.
 *
 * WHY the runtime stays behind a dynamic import: it is an optional dependency. A package install
 * without it must still load the extension, so this module may not carry a static value import of
 * the wasm host. `hasWebTreeSitterRuntime` is the cheap preflight; grammar bytes are only fetched
 * after it answered yes, and a resolution failure is the same answer as an offline grammar.
 *
 * WHY the runtime is the only dependency: grammars are fetched bytes, so the package grows only by
 * the wasm host, never by a grammar set. `Language.load` accepts the verified bytes directly, so no
 * second disk read is needed after the cache check.
 */
import type { GrammarHandle, SyntaxNodeLike } from "./ast-span.js";

type WebTreeSitter = typeof import("web-tree-sitter");

let runtime: Promise<WebTreeSitter | undefined> | undefined;
let parserInit: Promise<void> | undefined;

async function loadRuntime(): Promise<WebTreeSitter | undefined> {
  if (runtime !== undefined) return runtime;
  const pending = import("web-tree-sitter").catch(() => undefined);
  runtime = pending;
  const loaded = await pending;
  // WHY: a failed resolution is retried on the next probe rather than poisoning the process.
  if (loaded === undefined) runtime = undefined;
  return loaded;
}

/** Whether the optional wasm host can be resolved right now. Never throws. */
export async function hasWebTreeSitterRuntime(): Promise<boolean> {
  return (await loadRuntime()) !== undefined;
}

async function initializeParser(module: WebTreeSitter): Promise<void> {
  parserInit ??= module.Parser.init();
  try {
    await parserInit;
  } catch {
    // WHY: a failed host init is retried on the next read rather than poisoning the process.
    parserInit = undefined;
    throw new Error("web-tree-sitter init failed");
  }
}

/**
 * Turn verified bytes into a parser handle. Any failure (missing module, incompatible wasm, corrupt
 * bytes after a digest match) returns undefined; the provider discards the cache entry.
 */
export async function loadWebTreeSitterGrammar(
  bytes: Uint8Array,
): Promise<GrammarHandle | undefined> {
  const module = await loadRuntime();
  if (module === undefined) return undefined;
  try {
    await initializeParser(module);
    const grammar = await module.Language.load(bytes);
    const parser = new module.Parser();
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
