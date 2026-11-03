/**
 * Parser-neutral syntax tree shapes and the scope walk shared by the grammar provider.
 *
 * WHY the provider depends on these minimal interfaces instead of `web-tree-sitter` types: tests can
 * inject a tree at the boundary, and the seam stays testable without a grammar binary. The default
 * loader adapts `web-tree-sitter` nodes to this shape.
 */
import type { LineRange } from "./provider-contract.js";
import type { SpanKindTable } from "./span-kind.js";

/** A zero-based parser position. */
interface SyntaxPosition {
  readonly row: number;
  readonly column: number;
}

/** The node surface the scope walk needs. */
export interface SyntaxNodeLike {
  readonly type: string;
  readonly startPosition: SyntaxPosition;
  readonly endPosition: SyntaxPosition;
  readonly hasError: boolean;
  readonly namedChildren: readonly SyntaxNodeLike[];
  readonly text?: string;
  childForFieldName?(field: string): SyntaxNodeLike | null;
  /** The node's parent; the default runtime supplies this, tests may omit it. */
  readonly parent?: SyntaxNodeLike | null;
  /** The nearest preceding named sibling, used to attach leading documentation. */
  readonly previousNamedSibling?: SyntaxNodeLike | null;
}

/** A parsed tree plus the optional handle that frees parser resources. */
interface ParsedTreeLike {
  readonly rootNode: SyntaxNodeLike;
  delete?(): void;
}

/** One loaded grammar: parse source text into a tree, or null when the parser declined. */
export interface GrammarHandle {
  parse(source: string): ParsedTreeLike | null;
  /** Called when parsing fails, so the runtime can discard a corrupt cached grammar. */
  onFailure?(): void;
}

/** The grammar-supply boundary: verified bytes in, a parser out. */
export type GrammarLanguageLoader = (bytes: Uint8Array) => Promise<GrammarHandle | undefined>;

/** The 1-indexed inclusive lines a node covers; a column-0 end does not promote the line. */
export function scopeLineRange(node: SyntaxNodeLike): LineRange {
  const startLine = node.startPosition.row + 1;
  let endLine = node.endPosition.row + 1;
  if (node.endPosition.column === 0 && endLine > startLine) endLine--;
  return { startLine, endLine };
}

/**
 * Every scope-like node whose line range contains the point line, innermost first.
 * A node counts only when the language table owns its grammar type; that same table
 * supplies the note kind. The root is never included: it is the whole file. Empty when
 * nothing encloses the line (imports, file header, an unparseable region).
 */
export function findEnclosingChain(
  root: SyntaxNodeLike,
  line: number,
  scopeKinds: SpanKindTable,
): SyntaxNodeLike[] {
  const enclosing: Array<{ node: SyntaxNodeLike; length: number }> = [];

  const visit = (node: SyntaxNodeLike): void => {
    const range = scopeLineRange(node);
    if (range.startLine > line || range.endLine < line) return;
    // WHY: the root is the whole file; widening to it would turn a top-level probe into the file.
    if (node !== root && Object.hasOwn(scopeKinds, node.type)) {
      enclosing.push({ node, length: range.endLine - range.startLine + 1 });
    }
    for (const child of node.namedChildren) visit(child);
  };

  visit(root);
  // WHY: stable sort keeps discovery order for equal extents; nesting depth then decides.
  enclosing.sort((a, b) => a.length - b.length);
  return enclosing.map((entry) => entry.node);
}
