/**
 * The shared scope-decoration walk: one algorithm, one per-language predicate table.
 *
 * The walk ascends a parsed scope to the node whose span the reader should serve: a leading
 * `export`-style wrapper, a named assignment wrapper, and any transparent parentheses. It then
 * attaches the leading documentation and decorator/attribute siblings that sit immediately above
 * the span. Each language supplies only its node-type tables and doc-comment predicate, so later
 * grammar tickets add a table rather than copying this logic.
 */
import { scopeLineRange, type SyntaxNodeLike } from "./ast-span.js";

/** One language's decoration vocabulary; the walk itself stays here. */
export interface DecorationSpec {
  /** Node types that can be documentation blocks, e.g. `comment` for TypeScript. */
  readonly docCommentTypes: ReadonlySet<string>;
  /** Narrow a shared node type to real documentation, e.g. only `/**` comments. */
  readonly isDocComment?: (node: SyntaxNodeLike) => boolean;
  /** Parent wrappers that belong to the declaration span, e.g. `export_statement`. */
  readonly wrapperTypes: ReadonlySet<string>;
  /** Parent nodes that name an assigned value, e.g. `variable_declarator`. */
  readonly assignmentNodeTypes: ReadonlySet<string>;
  /** Parent wrappers around an assignment, e.g. `lexical_declaration`. */
  readonly assignmentWrapperTypes: ReadonlySet<string>;
  /** Parent wrappers to climb through, e.g. `parenthesized_expression`. */
  readonly transparentTypes: ReadonlySet<string>;
  /** Leading decorator/attribute node types to attach. */
  readonly decorationTypes: ReadonlySet<string>;
  /** Field that carries a declared name; defaults to `name`. */
  readonly nameField?: string;
  /** Optional language-specific note kind, e.g. Python's class-body functions are methods. */
  readonly kindOf?: (node: SyntaxNodeLike) => string | undefined;
}

/** A scope after wrapper ascent and leading-decoration attachment. */
interface DecoratedScope {
  /** The node whose full span is served. */
  readonly node: SyntaxNodeLike;
  /** 1-indexed first line, including leading documentation. */
  readonly startLine: number;
  /** 1-indexed last line of the wrapped node. */
  readonly endLine: number;
  /** Declared or assigned name; absent when the node is anonymous. */
  readonly name?: string;
  /** Language-specific note kind overriding the generic scope mapping. */
  readonly kind?: string;
}

export type ScopeDecorator = (node: SyntaxNodeLike) => DecoratedScope;

function isAttachable(node: SyntaxNodeLike, spec: DecorationSpec): boolean {
  if (spec.decorationTypes.has(node.type)) return true;
  if (!spec.docCommentTypes.has(node.type)) return false;
  return spec.isDocComment?.(node) ?? true;
}

function declaredName(node: SyntaxNodeLike, spec: DecorationSpec): string | undefined {
  const named = node.childForFieldName?.(spec.nameField ?? "name");
  if (typeof named?.text === "string" && named.text.trim() !== "") return named.text.trim();
  return undefined;
}

/** Climb wrappers/assignments and attach leading docs; the only copy of this logic. */
function decorateScope(node: SyntaxNodeLike, spec: DecorationSpec): DecoratedScope {
  let span = node;
  let nameNode = node;

  while (span.parent !== null && span.parent !== undefined) {
    const parent = span.parent;
    if (spec.transparentTypes.has(parent.type)) {
      span = parent;
      continue;
    }
    if (spec.assignmentNodeTypes.has(parent.type)) {
      span = parent;
      nameNode = parent;
      const wrapper = parent.parent;
      if (
        wrapper !== null &&
        wrapper !== undefined &&
        spec.assignmentWrapperTypes.has(wrapper.type)
      ) {
        span = wrapper;
      }
      continue;
    }
    if (spec.wrapperTypes.has(parent.type)) {
      span = parent;
      continue;
    }
    break;
  }

  const range = scopeLineRange(span);
  let startLine = range.startLine;
  let previous = span.previousNamedSibling;
  while (previous !== null && previous !== undefined && isAttachable(previous, spec)) {
    // WHY: a blank line breaks attachment; a comment far above a declaration is not its doc block.
    if (previous.endPosition.row + 1 !== startLine - 1) break;
    startLine = previous.startPosition.row + 1;
    previous = previous.previousNamedSibling;
  }

  const name = declaredName(nameNode, spec);
  const kind = spec.kindOf?.(node);
  return {
    node: span,
    startLine,
    endLine: range.endLine,
    ...(name === undefined ? {} : { name }),
    ...(kind === undefined ? {} : { kind }),
  };
}

/**
 * Build the decorator for one language. Two decorators share the walk above; only their specs
 * differ, which is what lets Python/Go/Rust reuse the rule without copying it.
 */
export function createScopeDecorator(spec: DecorationSpec): ScopeDecorator {
  return (node) => decorateScope(node, spec);
}
