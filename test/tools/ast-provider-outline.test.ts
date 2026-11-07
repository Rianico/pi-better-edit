import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAstSpanProvider, type OutlineSymbol } from "../../src/read-expansion/ast-provider";
import type { GrammarHandle, SyntaxNodeLike } from "../../src/read-expansion/ast-span";
import { primeGrammarForTests } from "../../src/read-expansion/grammar-cache";
import { withTempFile } from "../support/fixtures";

type MutableNode = SyntaxNodeLike & {
  parent?: SyntaxNodeLike | null;
  previousNamedSibling?: SyntaxNodeLike | null;
};

interface FakeSpec {
  readonly type: string;
  readonly start: number;
  readonly end?: number;
  readonly text?: string;
  readonly children?: readonly MutableNode[];
  readonly name?: string;
  readonly error?: boolean;
}

// WHY the auto-append: real scope nodes carry their declared name as a named child, so the
// fake answers `childForFieldName("name")` exactly like the runtime adapter does. Nodes without
// a name (wrappers, bodies, documentation) answer no field, which is also the real behavior.
function node(spec: FakeSpec): MutableNode {
  const leaf: MutableNode | undefined =
    spec.name === undefined
      ? undefined
      : {
          type: "identifier",
          startPosition: { row: spec.start, column: 0 },
          endPosition: { row: spec.start, column: spec.name.length },
          hasError: false,
          namedChildren: [],
          text: spec.name,
        };
  const children = [...(spec.children ?? []), ...(leaf === undefined ? [] : [leaf])];
  const built: MutableNode = {
    type: spec.type,
    startPosition: { row: spec.start, column: 0 },
    endPosition: { row: spec.end ?? spec.start, column: 1 },
    hasError: spec.error ?? false,
    namedChildren: children,
    text: spec.text ?? "",
    ...(leaf === undefined
      ? {}
      : { childForFieldName: (field: string) => (field === "name" ? leaf : null) }),
  };
  for (const child of children) child.parent = built;
  return built;
}

const reader = (text: string) => async () => text;

function primeAllGrammars(): void {
  for (const language of ["typescript", "tsx", "go", "python", "rust"] as const) {
    primeGrammarForTests(
      language,
      gunzipSync(
        readFileSync(join("test", "fixtures", "grammars", `tree-sitter-${language}.wasm.gz`)),
      ),
    );
  }
}

function fakeProvider(root: MutableNode) {
  const handle: GrammarHandle = { parse: () => ({ rootNode: root }) };
  return createAstSpanProvider({
    loadGrammar: async () => handle,
    runtimeAvailable: async () => true,
    readTextFile: reader(""),
  });
}

describe("ast outline: TypeScript declaration lines", () => {
  // Lines below are 1-indexed in comments; `start` rows are 0-indexed.
  function typescriptRoot(): MutableNode {
    const versionValue = node({ type: "string", start: 1 });
    const versionDecl = node({
      type: "variable_declarator",
      start: 1,
      name: "VERSION",
      children: [versionValue],
    });
    const versionLexical = node({
      type: "lexical_declaration",
      start: 1,
      text: 'const VERSION = "1.0";',
      children: [versionDecl],
    });
    const exportVersion = node({ type: "export_statement", start: 1, children: [versionLexical] });

    const boxParam = node({ type: "type_parameter", start: 4, name: "T" });
    const boxParams = node({ type: "type_parameters", start: 4, children: [boxParam] });
    const open = node({ type: "method_signature", start: 5, name: "open" });
    const interfaceBody = node({ type: "interface_body", start: 4, end: 6, children: [open] });
    const box = node({
      type: "interface_declaration",
      start: 4,
      end: 6,
      name: "Box",
      children: [boxParams, interfaceBody],
    });
    const exportBox = node({ type: "export_statement", start: 4, children: [box] });

    const doc = node({ type: "comment", start: 7, text: "/** Doc for Rectangle. */" });
    const ctor = node({ type: "method_definition", start: 9, name: "constructor" });
    const area = node({ type: "method_definition", start: 10, name: "area" });
    const classBody = node({ type: "class_body", start: 9, end: 11, children: [ctor, area] });
    const rectangle = node({
      type: "class_declaration",
      start: 8,
      end: 11,
      name: "Rectangle",
      children: [classBody],
    });
    rectangle.previousNamedSibling = doc;
    const exportRectangle = node({ type: "export_statement", start: 8, children: [rectangle] });

    const plain = node({ type: "enum_assignment", start: 14, name: "Plain" });
    const enumBody = node({ type: "enum_body", start: 13, end: 15, children: [plain] });
    const kind = node({
      type: "enum_declaration",
      start: 13,
      end: 15,
      name: "Kind",
      children: [enumBody],
    });
    const exportKind = node({ type: "export_statement", start: 13, children: [kind] });

    const create = node({ type: "function_declaration", start: 17, end: 17, name: "create" });
    const exportCreate = node({ type: "export_statement", start: 17, children: [create] });

    const aliasParam = node({ type: "type_parameter", start: 19, name: "T" });
    const aliasParams = node({ type: "type_parameters", start: 19, children: [aliasParam] });
    const alias = node({
      type: "type_alias_declaration",
      start: 19,
      name: "Alias",
      children: [aliasParams],
    });
    const exportAlias = node({ type: "export_statement", start: 19, children: [alias] });

    const namespaceBody = node({
      type: "statement_block",
      start: 4,
      end: 20,
      children: [exportBox, doc, exportRectangle, exportKind, exportCreate, exportAlias],
    });
    const namespace = node({
      type: "internal_module",
      start: 3,
      end: 20,
      name: "Shapes",
      children: [namespaceBody],
    });
    const exportNamespace = node({ type: "export_statement", start: 3, children: [namespace] });

    const main = node({ type: "function_declaration", start: 22, end: 22, name: "main" });
    const exportMain = node({ type: "export_statement", start: 22, children: [main] });

    const arrow = node({ type: "arrow_function", start: 23, end: 23 });
    const handlerDecl = node({
      type: "variable_declarator",
      start: 23,
      name: "handler",
      children: [arrow],
    });
    const handlerLexical = node({
      type: "lexical_declaration",
      start: 23,
      text: "const handler = () => 0;",
      children: [handlerDecl],
    });
    const exportHandler = node({ type: "export_statement", start: 23, children: [handlerLexical] });

    const funcExpr = node({ type: "function_expression", start: 24, end: 24 });
    const setupDecl = node({
      type: "variable_declarator",
      start: 24,
      name: "setup",
      children: [funcExpr],
    });
    const setupLexical = node({
      type: "lexical_declaration",
      start: 24,
      text: "const setup = function () { return 1; };",
      children: [setupDecl],
    });
    const exportSetup = node({ type: "export_statement", start: 24, children: [setupLexical] });

    const draftDecl = node({ type: "variable_declarator", start: 25, name: "draft" });
    const draftLexical = node({
      type: "lexical_declaration",
      start: 25,
      text: "let draft = 1;",
      children: [draftDecl],
    });

    const innerDecl = node({ type: "variable_declarator", start: 27, name: "inner" });
    const innerLexical = node({
      type: "lexical_declaration",
      start: 27,
      text: "const inner = 1;",
      children: [innerDecl],
    });
    const nested = node({ type: "function_declaration", start: 28, end: 28, name: "nested" });
    const outerBody = node({
      type: "statement_block",
      start: 26,
      end: 29,
      children: [innerLexical, nested],
    });
    const outer = node({
      type: "function_declaration",
      start: 26,
      end: 29,
      name: "outer",
      children: [outerBody],
    });

    return node({
      type: "program",
      start: 0,
      end: 29,
      children: [
        exportVersion,
        exportNamespace,
        exportMain,
        exportHandler,
        exportSetup,
        draftLexical,
        outer,
      ],
    });
  }

  it("lists mixed symbols at their physical declaration lines", async () => {
    await withTempFile("app.ts", "", async ({ path }) => {
      primeAllGrammars();
      expect(await fakeProvider(typescriptRoot()).outline(path)).toEqual([
        { name: "VERSION", kind: "constant", line: 2 },
        { name: "Shapes", kind: "namespace", line: 4 },
        { name: "Box", kind: "interface", line: 5 },
        { name: "T", kind: "typeParameter", line: 5 },
        { name: "open", kind: "method", line: 6 },
        { name: "Rectangle", kind: "class", line: 9 },
        { name: "constructor", kind: "constructor", line: 10 },
        { name: "area", kind: "method", line: 11 },
        { name: "Kind", kind: "enum", line: 14 },
        { name: "create", kind: "function", line: 18 },
        { name: "T", kind: "typeParameter", line: 20 },
        { name: "main", kind: "function", line: 23 },
        { name: "handler", kind: "constant", line: 24 },
        { name: "setup", kind: "function", line: 25 },
        { name: "outer", kind: "function", line: 27 },
        { name: "nested", kind: "function", line: 29 },
      ] satisfies readonly OutlineSymbol[]);
    });
  });

  it("counts namespace-body constants as top-level", async () => {
    const flagDecl = node({ type: "variable_declarator", start: 1, name: "FLAG" });
    const flagLexical = node({
      type: "lexical_declaration",
      start: 1,
      text: "const FLAG = 1;",
      children: [flagDecl],
    });
    const body = node({ type: "statement_block", start: 0, end: 2, children: [flagLexical] });
    const namespace = node({
      type: "internal_module",
      start: 0,
      end: 2,
      name: "N",
      children: [body],
    });
    const root = node({ type: "program", start: 0, end: 2, children: [namespace] });
    await withTempFile("app.ts", "", async ({ path }) => {
      primeAllGrammars();
      // WHY: namespace members are module API like the enum next door, while function-body
      // locals are not; the TypeScript suite pins the local exclusion through `inner`.
      expect(await fakeProvider(root).outline(path)).toEqual([
        { name: "N", kind: "namespace", line: 1 },
        { name: "FLAG", kind: "constant", line: 2 },
      ]);
    });
  });
});

describe("ast outline: Go, Rust, and Python declaration lines", () => {
  it("maps Go structs, interfaces, file constants, functions, and methods", async () => {
    const field = node({ type: "field_declaration", start: 2, name: "X" });
    const structType = node({ type: "struct_type", start: 2, end: 3, children: [field] });
    const point = node({ type: "type_spec", start: 2, name: "Point", children: [structType] });
    const pointDecl = node({ type: "type_declaration", start: 2, children: [point] });

    const interfaceType = node({ type: "interface_type", start: 5, end: 6 });
    const shape = node({ type: "type_spec", start: 5, name: "Shape", children: [interfaceType] });
    const shapeDecl = node({ type: "type_declaration", start: 5, children: [shape] });

    const plainName = node({ type: "type_identifier", start: 7 });
    const plainSpec = node({ type: "type_spec", start: 7, name: "MyInt", children: [plainName] });
    const plainDecl = node({ type: "type_declaration", start: 7, children: [plainSpec] });

    const version = node({ type: "const_spec", start: 9, name: "Version" });
    const versionDecl = node({ type: "const_declaration", start: 9, children: [version] });

    const create = node({ type: "function_declaration", start: 11, end: 12, name: "NewPoint" });
    const area = node({ type: "method_declaration", start: 13, end: 14, name: "Area" });

    const debug = node({ type: "const_spec", start: 16, name: "debug" });
    const debugDecl = node({ type: "const_declaration", start: 16, children: [debug] });
    const runBody = node({ type: "block", start: 15, end: 17, children: [debugDecl] });
    const run = node({
      type: "function_declaration",
      start: 15,
      end: 17,
      name: "run",
      children: [runBody],
    });

    const root = node({
      type: "source_file",
      start: 0,
      end: 17,
      children: [pointDecl, shapeDecl, plainDecl, versionDecl, create, area, run],
    });
    await withTempFile("shapes.go", "", async ({ path }) => {
      primeAllGrammars();
      expect(await fakeProvider(root).outline(path)).toEqual([
        { name: "Point", kind: "struct", line: 3 },
        { name: "Shape", kind: "interface", line: 6 },
        { name: "Version", kind: "constant", line: 10 },
        { name: "NewPoint", kind: "function", line: 12 },
        { name: "Area", kind: "method", line: 14 },
        { name: "run", kind: "function", line: 16 },
      ]);
    });
  });

  it("maps Rust structs, enums, file constants, and impl methods", async () => {
    const point = node({ type: "struct_item", start: 1, end: 2, name: "Point" });
    const version = node({ type: "const_item", start: 3, name: "VERSION" });
    const create = node({ type: "function_item", start: 7, end: 9, name: "new" });
    const implList = node({ type: "declaration_list", start: 6, end: 10, children: [create] });
    const impl = node({ type: "impl_item", start: 5, end: 10, children: [implList] });
    const area = node({ type: "function_signature_item", start: 10, name: "area" });
    const traitList = node({ type: "declaration_list", start: 9, end: 11, children: [area] });
    const trait = node({
      type: "trait_item",
      start: 9,
      end: 11,
      name: "Shape",
      children: [traitList],
    });
    const kind = node({ type: "enum_item", start: 12, end: 13, name: "Kind" });
    const inner = node({ type: "const_item", start: 15, name: "inner" });
    const outerBody = node({ type: "block", start: 14, end: 16, children: [inner] });
    const outer = node({
      type: "function_item",
      start: 14,
      end: 16,
      name: "outer",
      children: [outerBody],
    });
    const alias = node({ type: "type_item", start: 17, name: "Alias" });
    const root = node({
      type: "source_file",
      start: 0,
      end: 17,
      children: [point, version, impl, trait, kind, outer, alias],
    });
    await withTempFile("shapes.rs", "", async ({ path }) => {
      primeAllGrammars();
      expect(await fakeProvider(root).outline(path)).toEqual([
        { name: "Point", kind: "struct", line: 2 },
        { name: "VERSION", kind: "constant", line: 4 },
        { name: "new", kind: "method", line: 8 },
        { name: "area", kind: "method", line: 11 },
        { name: "Kind", kind: "enum", line: 13 },
        { name: "outer", kind: "function", line: 15 },
      ]);
    });
  });

  it("maps Python classes, methods, and module functions without assignments", async () => {
    const init = node({ type: "function_definition", start: 7, end: 8, name: "__init__" });
    const area = node({ type: "function_definition", start: 10, end: 11, name: "area" });
    const classBody = node({ type: "block", start: 5, end: 12, children: [init, area] });
    const rectangle = node({
      type: "class_definition",
      start: 4,
      end: 12,
      name: "Rectangle",
      children: [classBody],
    });
    const create = node({ type: "function_definition", start: 13, end: 14, name: "create" });
    const target = node({ type: "identifier", start: 2 });
    const value = node({ type: "string", start: 2 });
    const assign = node({ type: "assignment", start: 2, children: [target, value] });
    const assignStmt = node({ type: "expression_statement", start: 2, children: [assign] });
    const root = node({
      type: "module",
      start: 0,
      end: 14,
      children: [assignStmt, rectangle, create],
    });
    await withTempFile("shapes.py", "", async ({ path }) => {
      primeAllGrammars();
      // WHY `__init__` stays a method: tranche 1 relabels only the TypeScript `constructor`
      // keyword form; dunder-constructor mapping is an open product question (see manual notes).
      // WHY no `VERSION` row: the Python grammar has no `const` signal, so every module
      // assignment would qualify as a constant; that heuristic needs a product decision first.
      expect(await fakeProvider(root).outline(path)).toEqual([
        { name: "Rectangle", kind: "class", line: 5 },
        { name: "__init__", kind: "method", line: 8 },
        { name: "area", kind: "method", line: 11 },
        { name: "create", kind: "function", line: 14 },
      ]);
    });
  });
});

describe("ast outline: empty-list fallback", () => {
  it("yields [] for unknown extensions, unreadable files, and declined grammars", async () => {
    await withTempFile("rows.csv", "a,b\n1,2\n", async ({ path }) => {
      primeAllGrammars();
      const provider = fakeProvider(node({ type: "program", start: 0, children: [] }));
      expect(await provider.outline(path)).toEqual([]);
    });
    const unreadable = createAstSpanProvider({
      loadGrammar: async () => undefined,
      runtimeAvailable: async () => true,
      readTextFile: async () => undefined,
    });
    expect(await unreadable.outline("app.ts")).toEqual([]);
    // WHY `runtimeAvailable: false`: declining before the fetch keeps this unit test offline;
    // a fetch failure declines the same way through `grammar_unavailable`.
    const declined = createAstSpanProvider({
      runtimeAvailable: async () => false,
      readTextFile: reader("export class A {}"),
    });
    expect(await declined.outline("app.ts")).toEqual([]);
  });

  it("yields [] for symbol-free files and null parses, and best-effort rows on error trees", async () => {
    await withTempFile("app.ts", "", async ({ path }) => {
      primeAllGrammars();
      const commentOnly = node({
        type: "program",
        start: 0,
        end: 0,
        children: [node({ type: "comment", start: 0, text: "// nothing here" })],
      });
      expect(await fakeProvider(commentOnly).outline(path)).toEqual([]);

      const nullParse: GrammarHandle = { parse: () => null };
      const nullProvider = createAstSpanProvider({
        loadGrammar: async () => nullParse,
        runtimeAvailable: async () => true,
        readTextFile: reader("export class A {}"),
      });
      expect(await nullProvider.outline(path)).toEqual([]);

      const recovered = node({
        type: "program",
        start: 0,
        end: 2,
        error: true,
        children: [node({ type: "function_declaration", start: 1, end: 2, name: "ok" })],
      });
      expect(await fakeProvider(recovered).outline(path)).toEqual([
        { name: "ok", kind: "function", line: 2 },
      ]);
    });
  });
});

describe("ast outline: real-grammar witness", () => {
  const source = `/** Doc for the version. */
export const VERSION = "1.0";

export namespace Shapes {
  export interface Box<T> {
    open(box: T): void;
  }

  export class Rectangle {
    constructor(width: number) {}
    area(): number {
      return 1;
    }
  }

  export enum Kind {
    Plain = "plain",
  }

  export function create(): number {
    return 1;
  }

  export type Alias<T> = T[];
}

export default function main(): void {}
`;

  it("pins the TypeScript declaration lines end to end", async () => {
    await withTempFile("app.ts", source, async ({ path }) => {
      // WHY inside withTempFile: the grammar cache path derives from HOME, which the fixture
      // repoints, so the primed bytes land where the provider looks without a network fetch.
      primeGrammarForTests(
        "typescript",
        gunzipSync(
          readFileSync(join("test", "fixtures", "grammars", "tree-sitter-typescript.wasm.gz")),
        ),
      );
      const provider = createAstSpanProvider({ readTextFile: reader(source) });
      expect(await provider.outline(path)).toEqual([
        { name: "VERSION", kind: "constant", line: 2 },
        { name: "Shapes", kind: "namespace", line: 4 },
        { name: "Box", kind: "interface", line: 5 },
        { name: "T", kind: "typeParameter", line: 5 },
        { name: "open", kind: "method", line: 6 },
        { name: "Rectangle", kind: "class", line: 9 },
        { name: "constructor", kind: "constructor", line: 10 },
        { name: "area", kind: "method", line: 11 },
        { name: "Kind", kind: "enum", line: 16 },
        { name: "create", kind: "function", line: 20 },
        { name: "T", kind: "typeParameter", line: 24 },
        { name: "main", kind: "function", line: 27 },
      ]);
    });
  });
  it("pins the Go declaration lines end to end", async () => {
    // WHY a real parse: the `type_spec` struct/interface split and the `const_spec` file-level
    // gate are supplement strings, so only a real grammar proves they match the pinned Go grammar.
    const source = `package shapes

// Doc for Point.
type Point struct {
\tX int
}

type Shape interface {
\tArea() float64
}

type MyInt int

const Version = "1.0"

func NewPoint() Point {
\treturn Point{}
}

func (p Point) Area() float64 {
\treturn 1
}

func run() {
\tdebug := 1
\t_ = debug
}
`;
    await withTempFile("shapes.go", source, async ({ path }) => {
      primeGrammarForTests(
        "go",
        gunzipSync(readFileSync(join("test", "fixtures", "grammars", "tree-sitter-go.wasm.gz"))),
      );
      const provider = createAstSpanProvider({ readTextFile: reader(source) });
      expect(await provider.outline(path)).toEqual([
        { name: "Point", kind: "struct", line: 4 },
        { name: "Shape", kind: "interface", line: 8 },
        { name: "Version", kind: "constant", line: 14 },
        { name: "NewPoint", kind: "function", line: 16 },
        { name: "Area", kind: "method", line: 20 },
        { name: "run", kind: "function", line: 24 },
      ]);
    });
  });

  it("pins the Rust declaration lines end to end", async () => {
    // WHY a real parse: `struct_item`, `enum_item`, and the file-level `const_item` gate are
    // supplement strings, so only a real grammar proves they match the pinned Rust grammar.
    const source = `/// Doc for Point.
pub struct Point {
    pub x: i32,
}

pub const VERSION: &str = "1.0";

impl Point {
    pub fn new() -> Point {
        Point { x: 0 }
    }
}

pub trait Shape {
    fn area(&self) -> f64;
}

pub enum Kind {
    Plain,
}

pub fn outer() {
    let inner = 1;
    let _ = inner;
}

pub type Alias = i32;
`;
    await withTempFile("shapes.rs", source, async ({ path }) => {
      primeGrammarForTests(
        "rust",
        gunzipSync(readFileSync(join("test", "fixtures", "grammars", "tree-sitter-rust.wasm.gz"))),
      );
      const provider = createAstSpanProvider({ readTextFile: reader(source) });
      expect(await provider.outline(path)).toEqual([
        { name: "Point", kind: "struct", line: 2 },
        { name: "VERSION", kind: "constant", line: 6 },
        { name: "new", kind: "method", line: 9 },
        { name: "area", kind: "method", line: 15 },
        { name: "Kind", kind: "enum", line: 18 },
        { name: "outer", kind: "function", line: 22 },
      ]);
    });
  });

  it("pins the Python declaration lines end to end", async () => {
    // WHY a real parse: the class/method/function rows and the assignment exclusion rest on the
    // Python table's node strings, so only a real grammar proves them against the pinned grammar.
    const source = `"""Module docs."""

VERSION = "1.0"


class Rectangle:
    """Doc for Rectangle."""

    def __init__(self):
        self.x = 1

    def area(self):
        return 1


def create():
    return 1
`;
    await withTempFile("shapes.py", source, async ({ path }) => {
      primeGrammarForTests(
        "python",
        gunzipSync(
          readFileSync(join("test", "fixtures", "grammars", "tree-sitter-python.wasm.gz")),
        ),
      );
      const provider = createAstSpanProvider({ readTextFile: reader(source) });
      // WHY no `VERSION` row: the Python grammar has no `const` signal, so every module
      // assignment would qualify as a constant; that heuristic needs a product decision first.
      expect(await provider.outline(path)).toEqual([
        { name: "Rectangle", kind: "class", line: 6 },
        { name: "__init__", kind: "method", line: 9 },
        { name: "area", kind: "method", line: 12 },
        { name: "create", kind: "function", line: 16 },
      ]);
    });
  });
});
