/** Go vocabulary for the shared scope-decoration walk. */
import type { DecorationSpec } from "./scope-decoration.js";

/**
 * Go doc comments are the `//` (or block comment) run at column 0 directly above a
 * declaration. A receiver method is a `method_declaration`, so the generic scope kind already
 * labels it `method`; only the leading comment run needs Go's predicate.
 */
export const GO_DECORATION: DecorationSpec = {
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
