import { describe, expect, it } from "vitest";
import { GO_DECORATION, GO_SPAN_KINDS } from "../../src/read-expansion/go-decoration";
import { PYTHON_DECORATION, PYTHON_SPAN_KINDS } from "../../src/read-expansion/python-decoration";
import { RUST_DECORATION, RUST_SPAN_KINDS } from "../../src/read-expansion/rust-decoration";
import {
  EXTENSION_SPAN_KINDS,
  LSP_SYMBOL_KINDS,
  SPAN_KINDS,
  SPAN_KIND_TO_LSP,
  isSpanKind,
} from "../../src/read-expansion/span-kind";
import {
  TYPESCRIPT_DECORATION,
  TYPESCRIPT_SPAN_KINDS,
} from "../../src/read-expansion/typescript-decoration";

const TABLES = [TYPESCRIPT_SPAN_KINDS, PYTHON_SPAN_KINDS, GO_SPAN_KINDS, RUST_SPAN_KINDS] as const;

const NON_AST_KINDS = ["function", "section", "paragraph"] as const;

describe("read expansion: closed span-kind vocabulary", () => {
  it("is exactly the LSP SymbolKind base plus the five documented extensions", () => {
    expect(SPAN_KINDS).toEqual([
      ...LSP_SYMBOL_KINDS.map((kind) => kind.charAt(0).toLowerCase() + kind.slice(1)),
      ...EXTENSION_SPAN_KINDS,
    ]);
    expect(EXTENSION_SPAN_KINDS).toEqual(["arrow", "impl", "trait", "section", "paragraph"]);
  });

  it("documents every member's LSP counterpart and leaves only extensions unmapped", () => {
    expect(Object.keys(SPAN_KIND_TO_LSP)).toEqual([...SPAN_KINDS]);
    expect(Object.values(SPAN_KIND_TO_LSP).slice(0, LSP_SYMBOL_KINDS.length)).toEqual([
      ...LSP_SYMBOL_KINDS,
    ]);
    for (const extension of EXTENSION_SPAN_KINDS) {
      expect(SPAN_KIND_TO_LSP[extension]).toBeNull();
    }
  });

  it("accepts every member and rejects a raw grammar node type", () => {
    for (const kind of SPAN_KINDS) expect(isSpanKind(kind)).toBe(true);
    for (const raw of [
      "impl_item",
      "trait_item",
      "function_declaration",
      "type_alias_declaration",
    ]) {
      expect(isSpanKind(raw)).toBe(false);
    }
  });

  it("ships a node table with every language and wires it into the decorator", () => {
    expect(TYPESCRIPT_DECORATION.kinds).toBe(TYPESCRIPT_SPAN_KINDS);
    expect(PYTHON_DECORATION.kinds).toBe(PYTHON_SPAN_KINDS);
    expect(GO_DECORATION.kinds).toBe(GO_SPAN_KINDS);
    expect(RUST_DECORATION.kinds).toBe(RUST_SPAN_KINDS);
    for (const table of TABLES) expect(Object.keys(table).length).toBeGreaterThan(0);
  });

  it("keeps every emitted kind in the union and distinct from any grammar node type", () => {
    const grammarTypes = new Set<string>();
    const emitted = new Set<string>(NON_AST_KINDS);
    for (const table of TABLES) {
      for (const nodeType of Object.keys(table)) grammarTypes.add(nodeType);
      for (const kind of Object.values(table)) emitted.add(kind);
    }
    for (const kind of emitted) {
      expect(SPAN_KINDS).toContain(kind);
      expect(grammarTypes.has(kind)).toBe(false);
    }
    expect(emitted.has("arrow")).toBe(true);
    expect(emitted.has("impl")).toBe(true);
    expect(emitted.has("trait")).toBe(true);
  });
});
