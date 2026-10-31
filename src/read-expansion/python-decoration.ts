/** Python vocabulary for the shared scope-decoration walk. */
import type { SyntaxNodeLike } from "./ast-span.js";
import type { DecorationSpec } from "./scope-decoration.js";

/**
 * Python wraps a decorated definition in `decorated_definition`: every `@` line and the `def` or
 * `class` line are children of that wrapper, so the shared ascent is the whole attachment rule.
 * A function inside a class body is a method; the label says so even though its node type is
 * `function_definition`.
 */
function isClassBodyFunction(node: SyntaxNodeLike): boolean {
  let parent = node.parent;
  if (parent?.type === "decorated_definition") parent = parent.parent;
  return parent?.type === "block" && parent.parent?.type === "class_definition";
}

export const PYTHON_DECORATION: DecorationSpec = {
  docCommentTypes: new Set(),
  wrapperTypes: new Set(["decorated_definition"]),
  assignmentNodeTypes: new Set(),
  assignmentWrapperTypes: new Set(),
  transparentTypes: new Set(),
  decorationTypes: new Set(),
  nameField: "name",
  kindOf: (node) => (isClassBodyFunction(node) ? "method" : undefined),
};
