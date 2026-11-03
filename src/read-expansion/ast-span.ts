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
 * The smallest scope-like node that contains every requested line, or null when the request sits
 * outside every block (imports, file header, an unparseable region). A node widens only when the
 * language table owns its grammar type; that same table supplies the note kind.
 */
export function findEnclosingScope(
  root: SyntaxNodeLike,
  requestedStart: number,
  requestedEnd: number,
  scopeKinds: SpanKindTable,
): SyntaxNodeLike | null {
  let best: SyntaxNodeLike | undefined;
  let bestLength = Number.POSITIVE_INFINITY;

  const visit = (node: SyntaxNodeLike): void => {
    const range = scopeLineRange(node);
    if (range.startLine > requestedStart || range.endLine < requestedEnd) return;
    // WHY: the root is the whole file; widening to it would turn a top-level probe into the file.
    if (node !== root && Object.hasOwn(scopeKinds, node.type)) {
      const length = range.endLine - range.startLine + 1;
      if (length < bestLength) {
        best = node;
        bestLength = length;
      }
    }
    for (const child of node.namedChildren) visit(child);
  };

  visit(root);
  return best ?? null;
}
