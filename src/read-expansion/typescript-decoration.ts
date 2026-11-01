/** TypeScript/TSX vocabulary for the shared scope-decoration walk. */
import type { DecorationSpec } from "./scope-decoration.js";
import type { SpanKindTable } from "./span-kind.js";

const JSDOC_PREFIX = "/**";

/**
 * TypeScript scope nodes and their note kinds. `type_alias_declaration` uses the `typeAlias`
 * extension; Swift and Kotlin will map their type declarations when they ship a table.
 */
export const TYPESCRIPT_SPAN_KINDS = {
  arrow_function: "arrow",
  function_declaration: "function",
  function_expression: "function",
  function_signature: "function",
  generator_function: "function",
  generator_function_declaration: "function",
  method_definition: "method",
  method_signature: "method",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  type_alias_declaration: "typeAlias",
  // WHY: TS `module`/`namespace` declarations are namespaces; LSP Module would overstate them.
  module: "namespace",
  internal_module: "namespace",
} as const satisfies SpanKindTable;

/**
 * `export_statement` carries the keyword outside the declaration node; `variable_declarator` and
 * its lexical wrapper carry an arrow name; `decorator` is a sibling of a class method.
 */
export const TYPESCRIPT_DECORATION: DecorationSpec = {
  kinds: TYPESCRIPT_SPAN_KINDS,
  docCommentTypes: new Set(["comment"]),
  // WHY: plain `//` and `/*` comments are not documentation; only `/** ... */` attaches.
  isDocComment: (node) => node.text?.trimStart().startsWith(JSDOC_PREFIX) ?? false,
  wrapperTypes: new Set(["export_statement", "ambient_declaration"]),
  assignmentNodeTypes: new Set(["variable_declarator", "public_field_definition"]),
  assignmentWrapperTypes: new Set(["lexical_declaration", "variable_declaration"]),
  transparentTypes: new Set([
    "parenthesized_expression",
    "as_expression",
    "satisfies_expression",
    "non_null_expression",
  ]),
  decorationTypes: new Set(["decorator"]),
  nameField: "name",
};
