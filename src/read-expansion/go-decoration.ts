/** Go vocabulary for the shared scope-decoration walk. */
import type { DecorationSpec } from "./scope-decoration.js";
import type { SpanKindTable } from "./span-kind.js";

/** Go scope nodes and their note kinds; a receiver method is already `method_declaration`. */
export const GO_SPAN_KINDS = {
  function_declaration: "function",
  method_declaration: "method",
} as const satisfies SpanKindTable;

/**
 * Go doc comments are the `//` (or block comment) run at column 0 directly above a
 * declaration. A receiver method is a `method_declaration`, so the node table already
 * labels it `method`; only the leading comment run needs Go's predicate.
 */
export const GO_DECORATION: DecorationSpec = {
  kinds: GO_SPAN_KINDS,
  docCommentTypes: new Set(["comment"]),
  isDocComment: (node) => {
    // WHY: Go doc comments start at column 0; a trailing comment on the previous line does not.
    if (node.startPosition.column !== 0) return false;
    const text = node.text?.trimStart() ?? "";
    return text.startsWith("//") || text.startsWith("/*");
  },
  wrapperTypes: new Set(),
  assignmentNodeTypes: new Set(),
  assignmentWrapperTypes: new Set(),
  transparentTypes: new Set(),
  decorationTypes: new Set(),
  nameField: "name",
};
