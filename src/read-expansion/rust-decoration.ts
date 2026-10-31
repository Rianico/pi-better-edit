/** Rust vocabulary for the shared scope-decoration walk. */
import type { SyntaxNodeLike } from "./ast-span.js";
import type { DecorationSpec } from "./scope-decoration.js";

/** A `function_item`/`function_signature_item` directly under an impl or trait is a method. */
function isOwnerMethod(node: SyntaxNodeLike): boolean {
  const list = node.parent;
  if (list?.type !== "declaration_list") return false;
  const owner = list.parent;
  return owner?.type === "impl_item" || owner?.type === "trait_item";
}

function isDocComment(node: SyntaxNodeLike): boolean {
  const text = node.text?.trimStart() ?? "";
  // WHY: `////` and `//!` are ordinary/inner comments, not outer doc comments for the item below.
  if (text.startsWith("///") && !text.startsWith("////")) return true;
  // WHY: `/**/` and `/***/` are ordinary block comments; a doc block has content after `/**`.
  return text.startsWith("/**") && text.length > 3 && text[3] !== "*" && text[3] !== "/";
}

/**
 * Rust outer attributes and line or block doc comments are siblings of the item, so the shared
 * leading-sibling walk attaches them. Impl and trait methods are ordinary function nodes; the
 * spec only relabels them as methods.
 */
export const RUST_DECORATION: DecorationSpec = {
  docCommentTypes: new Set(["line_comment", "block_comment"]),
  isDocComment,
  wrapperTypes: new Set(),
  assignmentNodeTypes: new Set(),
  assignmentWrapperTypes: new Set(),
  transparentTypes: new Set(),
  decorationTypes: new Set(["attribute_item"]),
  nameField: "name",
  kindOf: (node) => (isOwnerMethod(node) ? "method" : undefined),
};
