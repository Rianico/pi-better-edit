import { describe, expect, it } from "vitest";
import { findEnclosingChain, type SyntaxNodeLike } from "../../src/read-expansion/ast-span.js";
import type { SpanKindTable } from "../../src/read-expansion/span-kind.js";
import { selectionRangeNote } from "../../src/read-expansion/selection-range-note.js";
import type { SpanProvider } from "../../src/read-expansion/provider-contract.js";

type Node = SyntaxNodeLike & { parent?: SyntaxNodeLike | null };

function node(spec: {
  type: string;
  start: number;
  end: number;
  children?: SyntaxNodeLike[];
}): Node {
  return {
    type: spec.type,
    startPosition: { row: spec.start, column: 0 },
    endPosition: { row: spec.end, column: 1 },
    hasError: false,
    namedChildren: spec.children ?? [],
  };
}

const KINDS = {
  class_declaration: "class",
  method_definition: "method",
  function_declaration: "function",
} as unknown as SpanKindTable;

describe("findEnclosingChain", () => {
  it("returns innermost-first for a line inside a method inside a class", () => {
    const method = node({ type: "method_definition", start: 4, end: 8 });
    const cls = node({ type: "class_declaration", start: 0, end: 10, children: [method] });
    const root = node({ type: "program", start: 0, end: 10, children: [cls] });
    const chain = findEnclosingChain(root, 5, KINDS);
    expect(chain.map((n) => n.type)).toEqual(["method_definition", "class_declaration"]);
  });
});

describe("breadcrumb note", () => {
  function chainProvider(
    spans: readonly {
      readonly start: number;
      readonly end: number;
      readonly kind: import("../../src/read-expansion/span-kind.js").SpanKind;
      readonly name: string;
      readonly source: import("../../src/read-expansion/provider-contract.js").SpanSource;
    }[],
  ): SpanProvider {
    return {
      enclosingChain: () => ({ spans }),
    } as unknown as SpanProvider;
  }

  it("a window straddling two sibling methods names the method containing its first line", async () => {
    const provider = chainProvider([
      { start: 10, end: 20, kind: "method", name: "first", source: "ast" },
      { start: 1, end: 40, kind: "class", name: "C", source: "ast" },
    ]);
    const note = await selectionRangeNote({
      file: "app.ts",
      windows: [{ offset: 18, limit: 10 }],
      totalLines: 50,
      provider,
      enabled: true,
    });
    // WHY: the straddle no longer degrades to the class alone; the chain anchors on line 18.
    expect(note.clauses[0]).toContain("method first");
    expect(note.clauses[0]).toContain("(span 10-20)");
  });
  it("trims from the outer end: a 4-deep chain renders 3 levels keeping the innermost", async () => {
    const provider = chainProvider([
      { start: 14, end: 15, kind: "method", name: "inner", source: "ast" },
      { start: 12, end: 18, kind: "class", name: "mid", source: "ast" },
      { start: 10, end: 20, kind: "namespace", name: "outer", source: "ast" },
      { start: 1, end: 40, kind: "module", name: "root", source: "ast" },
    ]);
    const note = await selectionRangeNote({
      file: "app.ts",
      windows: [{ offset: 14, limit: 1 }],
      totalLines: 50,
      provider,
      enabled: true,
    });
    const clause = note.clauses[0] ?? "";
    expect(clause).toContain(" > ");
    expect(clause).toContain("inner");
    expect(clause).not.toContain("root");
    expect(clause.split(" > ")).toHaveLength(3);
  });

  it("stays silent when the innermost span equals the window", async () => {
    const provider = chainProvider([
      { start: 5, end: 7, kind: "function", name: "f", source: "ast" },
    ]);
    const note = await selectionRangeNote({
      file: "app.ts",
      windows: [{ offset: 5, limit: 3 }],
      totalLines: 20,
      provider,
      enabled: true,
    });
    expect(note.clauses).toEqual([undefined]);
  });

  it("binds the extent to the innermost name: `(span a-b)`, never `, lines a-b`", async () => {
    const provider = chainProvider([
      { start: 10, end: 20, kind: "method", name: "first", source: "ast" },
      { start: 1, end: 40, kind: "class", name: "C", source: "ast" },
    ]);
    const note = await selectionRangeNote({
      file: "app.ts",
      windows: [{ offset: 12, limit: 2 }],
      totalLines: 50,
      provider,
      enabled: true,
    });
    const clause = note.clauses[0] ?? "";
    // WHY: the operator's objection in #257 — `, lines 10-20` bound to the whole compound chain, so
    // a reader had to infer which level owned the extent. Parentheses bind it to the innermost name.
    expect(clause).toContain("(span 10-20)");
    expect(clause).not.toContain(", lines ");
    expect(clause).toContain(" > ");
  });

  it("says `starts in` when the window escapes the innermost span", async () => {
    const provider = chainProvider([
      { start: 10, end: 20, kind: "method", name: "first", source: "ast" },
      { start: 1, end: 40, kind: "class", name: "C", source: "ast" },
    ]);
    const note = await selectionRangeNote({
      file: "app.ts",
      // WHY: the window's last line is 27, past the innermost span's end 20, so the window is not
      // *in* the named method — only its first line is.
      windows: [{ offset: 18, limit: 10 }],
      totalLines: 50,
      provider,
      enabled: true,
    });
    const clause = note.clauses[0] ?? "";
    expect(clause).toContain("starts in");
    expect(clause).not.toContain("; in ");
    expect(clause).toContain("(span 10-20)");
  });

  it("keeps the plain `in` when the window sits inside the innermost span", async () => {
    const provider = chainProvider([
      { start: 10, end: 20, kind: "method", name: "first", source: "ast" },
      { start: 1, end: 40, kind: "class", name: "C", source: "ast" },
    ]);
    const note = await selectionRangeNote({
      file: "app.ts",
      windows: [{ offset: 12, limit: 2 }],
      totalLines: 50,
      provider,
      enabled: true,
    });
    const clause = note.clauses[0] ?? "";
    expect(clause).toContain("; in ");
    expect(clause).not.toContain("starts in");
  });

  it("keeps `in` when the window ends exactly on the innermost span's last line", async () => {
    const provider = chainProvider([
      { start: 10, end: 20, kind: "method", name: "first", source: "ast" },
      { start: 1, end: 40, kind: "class", name: "C", source: "ast" },
    ]);
    const note = await selectionRangeNote({
      file: "app.ts",
      // WHY: `lastLine == innermost.end` is the boundary the renderer's `<=` decides. Line 20 still
      // sits inside the span, so the clause reads `in`; only line 21 escapes and reads `starts in`.
      windows: [{ offset: 12, limit: 9 }],
      totalLines: 50,
      provider,
      enabled: true,
    });
    const clause = note.clauses[0] ?? "";
    expect(clause).toContain("; in ");
    expect(clause).not.toContain("starts in");
    expect(clause).toContain("(span 10-20)");
  });

  it("joins the levels with ASCII ` > ` and no code point above U+007F", async () => {
    const provider = chainProvider([
      { start: 10, end: 20, kind: "method", name: "first", source: "ast" },
      { start: 1, end: 40, kind: "class", name: "C", source: "ast" },
    ]);
    const note = await selectionRangeNote({
      file: "app.ts",
      windows: [{ offset: 12, limit: 1 }],
      totalLines: 50,
      provider,
      enabled: true,
    });
    const clause = note.clauses[0] ?? "";
    expect(clause).toContain(" > ");
    // WHY: U+203A is a three-byte glyph with replacement risk in constrained terminal fonts; the
    // note is machine-facing, so ASCII carries the same meaning at no cost.
    expect(clause).not.toContain("\u203A");
    expect(clause).toMatch(/^[\x20-\x7E]+$/);
  });

  it("renders a four-level chain as three levels, keeping the innermost", async () => {
    const provider = chainProvider([
      { start: 14, end: 15, kind: "method", name: "inner", source: "ast" },
      { start: 12, end: 18, kind: "class", name: "mid", source: "ast" },
      { start: 10, end: 20, kind: "namespace", name: "outer", source: "ast" },
      { start: 1, end: 40, kind: "module", name: "root", source: "ast" },
    ]);
    const note = await selectionRangeNote({
      file: "app.ts",
      // WHY: the last line 18 escapes the innermost span 14-15, so this one string pins the trim,
      // the ASCII separator, the parenthesized binding and the chosen preposition together.
      windows: [{ offset: 14, limit: 5 }],
      totalLines: 50,
      provider,
      enabled: true,
    });
    expect(note.clauses[0]).toBe(
      "; starts in namespace outer > class mid > method inner (span 14-15)",
    );
  });
});
