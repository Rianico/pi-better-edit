/**
 * The closed vocabulary of note labels.
 *
 * The base is LSP 3.17 `SymbolKind`: every lowercase member below names one protocol kind, and
 * `SPAN_KIND_TO_LSP` carries the canonical PascalCase name next to it. Six extensions cover
 * concepts the protocol cannot express honestly: `arrow` (an anonymous function assigned to a
 * name), `typeAlias`, `impl` and `trait` (Rust items; mapping them to `Object` would be a lie),
 * and the non-AST prose units `section` and `paragraph`.
 *
 * Display stays lowercase because the note is model-facing prose, not a protocol symbol. The two
 * camel-case members `enumMember` and `typeParameter` are rendered as `enum member` and
 * `type parameter`. `typeAlias` is an extension and keeps its camel-case label. A raw grammar node
 * type is never a member: an unmatched node declines.
 */
export const LSP_SYMBOL_KINDS = [
  "File",
  "Module",
  "Namespace",
  "Package",
  "Class",
  "Method",
  "Property",
  "Field",
  "Constructor",
  "Enum",
  "Interface",
  "Function",
  "Variable",
  "Constant",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Key",
  "Null",
  "EnumMember",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
] as const;

export type LspSymbolKind = (typeof LSP_SYMBOL_KINDS)[number];

/** Concepts LSP 3.17 cannot express without lying; deliberately not mapped to a protocol kind. */
export const EXTENSION_SPAN_KINDS = [
  "arrow",
  "impl",
  "trait",
  "section",
  "paragraph",
  "typeAlias",
] as const;

type ExtensionSpanKind = (typeof EXTENSION_SPAN_KINDS)[number];

/**
 * One label a widened note may carry. The first 26 members are the lowercase LSP 3.17
 * `SymbolKind` names, in protocol order; the final 5 are `EXTENSION_SPAN_KINDS`.
 */
export type SpanKind =
  | "file"
  | "module"
  | "namespace"
  | "package"
  | "class"
  | "method"
  | "property"
  | "field"
  | "constructor"
  | "enum"
  | "interface"
  | "function"
  | "variable"
  | "constant"
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "key"
  | "null"
  | "enumMember"
  | "struct"
  | "event"
  | "operator"
  | "typeParameter"
  | ExtensionSpanKind;

/** Every member, in union order; the pin test compares this list with the mapping keys. */
export const SPAN_KINDS = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enumMember",
  "struct",
  "event",
  "operator",
  "typeParameter",
  "arrow",
  "impl",
  "trait",
  "section",
  "paragraph",
  "typeAlias",
] as const satisfies readonly SpanKind[];

/** The documented union-member to LSP SymbolKind mapping; null marks one of the six extensions. */
export const SPAN_KIND_TO_LSP: Readonly<Record<SpanKind, LspSymbolKind | null>> = {
  file: "File",
  module: "Module",
  namespace: "Namespace",
  package: "Package",
  class: "Class",
  method: "Method",
  property: "Property",
  field: "Field",
  constructor: "Constructor",
  enum: "Enum",
  interface: "Interface",
  function: "Function",
  variable: "Variable",
  constant: "Constant",
  string: "String",
  number: "Number",
  boolean: "Boolean",
  array: "Array",
  object: "Object",
  key: "Key",
  null: "Null",
  enumMember: "EnumMember",
  struct: "Struct",
  event: "Event",
  operator: "Operator",
  typeParameter: "TypeParameter",
  arrow: null,
  impl: null,
  trait: null,
  section: null,
  paragraph: null,
  typeAlias: null,
};

/** Runtime guard for the seam: a provider cannot smuggle a raw node type into a note. */
export function isSpanKind(value: unknown): value is SpanKind {
  return typeof value === "string" && (SPAN_KINDS as readonly string[]).includes(value);
}

/** The model-facing note label; the audit keeps the union spelling. */
export function spanKindLabel(kind: SpanKind): string {
  if (kind === "enumMember") return "enum member";
  if (kind === "typeParameter") return "type parameter";
  if (kind === "typeAlias") return "typeAlias";
  return kind.toLowerCase();
}

/** Kinds a current provider table or non-AST emitter can produce; not the whole protocol. */
export const PRODUCED_KINDS = [
  "function",
  "method",
  "class",
  "interface",
  "enum",
  "namespace",
  "arrow",
  "impl",
  "trait",
  "typeAlias",
  "section",
  "paragraph",
] as const satisfies readonly SpanKind[];

/** One language's grammar-node-type to note-kind data table. */
export type SpanKindTable = Readonly<Record<string, SpanKind>>;
