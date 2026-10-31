/**
 * Committed grammar manifest — the pin every fetched grammar is verified against.
 *
 * WHY hashes and versions live in source: a lazy download is only trustworthy when the expected
 * bytes are pinned in the repository, not inferred from the response. `version` also names the
 * cache file, so a manifest bump cannot keep serving the previous grammar.
 *
 * WHY nothing here is imported as a module: the runtime (`web-tree-sitter`) is the only dependency;
 * grammar `.wasm` files are fetched on first use and are never part of the published package.
 */
export interface GrammarManifestEntry {
  readonly language: string;
  readonly version: string;
  readonly url: string;
  /** Lowercase hex SHA-256 of the exact `.wasm` bytes. */
  readonly sha256: string;
}

export type GrammarManifest = Readonly<Record<string, GrammarManifestEntry>>;

/**
 * TypeScript/TSX grammars from the pinned tree-sitter-typescript release. Both are fetched from a
 * versioned URL and verified against the committed digest before they reach the parser.
 */
export const GRAMMAR_MANIFEST: GrammarManifest = {
  typescript: {
    language: "typescript",
    version: "0.23.2",
    url: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-typescript.wasm",
    sha256: "778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d",
  },
  tsx: {
    language: "tsx",
    version: "0.23.2",
    url: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm",
    sha256: "79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8",
  },
};

const LANGUAGE_BY_EXTENSION = new Map([
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
]);

/** The manifest entry for a source path, or undefined when no grammar is supported yet. */
export function grammarLanguageForFile(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return undefined;
  return LANGUAGE_BY_EXTENSION.get(filePath.slice(dot).toLowerCase());
}
