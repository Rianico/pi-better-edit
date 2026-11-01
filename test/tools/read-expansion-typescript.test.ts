import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import {
  createScopeDecorator,
  type DecorationSpec,
} from "../../src/read-expansion/scope-decoration";
import { createAstSpanProvider } from "../../src/read-expansion/ast-provider";
import type { SyntaxNodeLike } from "../../src/read-expansion/ast-span";
import {
  anchorRows,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/grammars/", import.meta.url));

type ReadResult = {
  content: Array<{ text?: string }>;
  details?: { widened?: unknown };
};

function fixtureBytes(language: "typescript" | "tsx"): Uint8Array {
  return gunzipSync(readFileSync(join(FIXTURE_DIR, `tree-sitter-${language}.wasm.gz`)));
}

/** Serve the real pinned grammar from a local fixture; the cache still verifies its digest. */
function fixtureFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const bytes = fixtureBytes(url.includes("tsx") ? "tsx" : "typescript");
    // SAFETY: Node's fetch accepts a Uint8Array body at runtime; the DOM BodyInit union narrows it.
    return new Response(bytes as unknown as BodyInit);
  }) as typeof fetch;
}

function reader(cacheRoot: string) {
  const { pi, getTool } = makeFakePiRegistry();
  regRead(pi, {
    spanProvider: createAstSpanProvider({ cacheRoot, fetchImpl: fixtureFetch() }),
  });
  return getTool("read") as {
    execute(
      callId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ): Promise<ReadResult>;
  };
}

function runRead(
  tool: ReturnType<typeof reader>,
  cwd: string,
  params: unknown,
): Promise<ReadResult> {
  return tool.execute("read-expansion-typescript", params, undefined, undefined, {
    cwd,
    sessionManager: testSessionManager,
  });
}

function lines(result: ReadResult): string[] {
  return anchorRows(getText(result)).map((row) => row.slice(row.indexOf("│") + 1));
}

function notes(result: ReadResult): string[] {
  return getText(result)
    .split("\n")
    .filter((line) => line.includes("[widened "));
}

async function withRealGrammar(run: (cacheRoot: string) => Promise<void>): Promise<void> {
  const cacheRoot = await mkdtemp(join(tmpdir(), "pbe-ts-expansion-"));
  try {
    await run(cacheRoot);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

describe("read expansion: TypeScript and TSX boundaries", () => {
  it("includes the export keyword and the preceding JSDoc block", async () => {
    const source = `/**\n * Adds two numbers.\n */\nexport function add(a: number, b: number): number {\n  const sum = a + b;\n  return sum;\n}\n\nexport const outside = 1;\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("add.ts", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 5, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("/**");
        expect(served).toContain("export function add(a: number, b: number): number {");
        expect(served.at(-1)).toBe("}");
        expect(served).toHaveLength(7);
        expect(notes(result)).toEqual(["[widened 5-5 -> 1-7, function add]"]);
        expect(result.details?.widened).toBeUndefined();
      });
    });
  });

  it("widens to a method rather than its class", async () => {
    const source = `export class Counter {\n  /** Increments. */\n  increment(step: number): number {\n    this.value += step;\n    return this.value;\n  }\n\n  other(): number {\n    return 0;\n  }\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("counter.ts", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 5, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("  /** Increments. */");
        expect(served.at(-1)).toBe("  }");
        expect(served.join("\n")).not.toContain("class Counter");
        expect(notes(result)).toEqual(["[widened 5-5 -> 2-6, method increment]"]);
      });
    });
  });

  it("attaches a method decorator as well as its JSDoc", async () => {
    const source = `export class Service {\n  /** Runs. */\n  @logged\n  run(): number {\n    return 1;\n  }\n\n  idle(): number {\n    return 0;\n  }\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("service.ts", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 5, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("  /** Runs. */");
        expect(served).toContain("  @logged");
        expect(served.at(-1)).toBe("  }");
        expect(notes(result)).toEqual(["[widened 5-5 -> 2-6, method run]"]);
      });
    });
  });

  it("widens a nested block to the enclosing function", async () => {
    const source = `export function outer(flag: boolean): number {\n  if (flag) {\n    return 1;\n  }\n  return 0;\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("outer.ts", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 3, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("export function outer(flag: boolean): number {");
        expect(served.at(-1)).toBe("}");
        expect(served).toHaveLength(6);
        expect(notes(result)).toEqual(["[widened 3-3 -> 1-6, function outer]"]);
      });
    });
  });

  it("leaves imports and top-level statements at the requested window", async () => {
    const source = `import { a } from "./a";\nimport { b } from "./b";\n\nconst top = a + b;\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("top.ts", source, async ({ cwd, path }) => {
        const tool = reader(cacheRoot);
        for (const offset of [2, 4]) {
          const result = await runRead(tool, cwd, { file: path, windows: [{ offset, limit: 1 }] });
          expect(lines(result)).toEqual([source.split("\n")[offset - 1]]);
          expect(notes(result)).toEqual([]);
        }
      });
    });
  });

  it("widens a type alias again with the typeAlias label", async () => {
    await withRealGrammar(async (cacheRoot) => {
      const source = `type A = {\n  value: string;\n};\nconst x = 1;\n`;
      await withTempFile("alias.ts", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 2, limit: 1 }],
        });
        expect(lines(result)).toEqual(["type A = {", "  value: string;", "};"]);
        expect(notes(result)).toEqual(["[widened 2-2 -> 1-3, typeAlias A]"]);
      });
    });
  });

  it("widens an arrow assigned to a name to its declaration", async () => {
    const source = `/**\n * Doubles a value.\n */\nexport const double = (value: number) => {\n  return value * 2;\n};\n\nconst other = 1;\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("double.ts", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 5, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("/**");
        expect(served).toContain("export const double = (value: number) => {");
        expect(served.at(-1)).toBe("};");
        expect(notes(result)).toEqual(["[widened 5-5 -> 1-6, arrow double]"]);
      });
    });
  });

  it("widens a class-field arrow to its named field", async () => {
    const source = `export class Box {\n  /** Doubles. */\n  double = (value: number) => {\n    return value * 2;\n  };\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("box.ts", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 4, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("  /** Doubles. */");
        expect(served).toContain("  double = (value: number) => {");
        expect(served.at(-1)).toBe("  };");
        expect(notes(result)).toEqual(["[widened 4-4 -> 2-5, arrow double]"]);
      });
    });
  });

  it("does not attach a JSDoc block separated by a blank line", async () => {
    const source = `/** Spaced. */\n\nexport function spaced() {\n  return 1;\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("spaced.ts", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 4, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("export function spaced() {");
        expect(served.at(-1)).toBe("}");
        expect(notes(result)).toEqual(["[widened 4-4 -> 3-5, function spaced]"]);
      });
    });
  });

  it("uses the same decoration walk for a second language spec", () => {
    const name: SyntaxNodeLike = {
      type: "identifier",
      startPosition: { row: 1, column: 9 },
      endPosition: { row: 1, column: 10 },
      hasError: false,
      namedChildren: [],
      text: "f",
    };
    const doc: SyntaxNodeLike = {
      type: "comment",
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: 6 },
      hasError: false,
      namedChildren: [],
      text: "# docs",
    };
    const fn: SyntaxNodeLike = {
      type: "function_definition",
      startPosition: { row: 1, column: 0 },
      endPosition: { row: 3, column: 0 },
      hasError: false,
      namedChildren: [name],
      childForFieldName: (field) => (field === "name" ? name : null),
    };
    const wrapper: SyntaxNodeLike = {
      type: "decorated_definition",
      startPosition: { row: 1, column: 0 },
      endPosition: { row: 3, column: 1 },
      hasError: false,
      namedChildren: [fn],
      previousNamedSibling: doc,
      parent: null,
    };
    Object.assign(fn, { parent: wrapper });

    const pythonLike: DecorationSpec = {
      kinds: { function_definition: "function" },
      docCommentTypes: new Set(["comment"]),
      isDocComment: (node) => node.text?.startsWith("#") ?? false,
      wrapperTypes: new Set(["decorated_definition"]),
      assignmentNodeTypes: new Set(),
      assignmentWrapperTypes: new Set(),
      transparentTypes: new Set(),
      decorationTypes: new Set(),
      nameField: "name",
    };
    const decorated = createScopeDecorator(pythonLike)(fn);

    expect(decorated.node).toBe(wrapper);
    expect(decorated.startLine).toBe(1);
    expect(decorated.endLine).toBe(4);
    expect(decorated.name).toBe("f");
  });

  it("widens a TSX function and keeps JSX inside the served span", async () => {
    const source = `/** Renders a label. */\nexport function Widget({ label }: { label: string }) {\n  return <span>{label}</span>;\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("widget.tsx", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 3, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("/** Renders a label. */");
        expect(served.at(-1)).toBe("}");
        expect(served).toContain("  return <span>{label}</span>;");
        expect(notes(result)).toEqual(["[widened 3-3 -> 1-4, function Widget]"]);
      });
    });
  });

  it("fails closed on malformed TypeScript and on an over-cap function", async () => {
    const malformed = `export function broken( {\n  return 1;\n}\n`;
    const huge = `export function huge() {\n${Array.from(
      { length: 90 },
      (_, index) => `  const line${index + 1} = ${index + 1};`,
    ).join("\n")}\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      const tool = reader(cacheRoot);
      await withTempFile("broken.ts", malformed, async ({ cwd, path }) => {
        const result = await runRead(tool, cwd, { file: path, windows: [{ offset: 2, limit: 1 }] });
        expect(lines(result)).toEqual(["  return 1;"]);
        expect(notes(result)).toEqual([]);
      });
      await withTempFile("huge.ts", huge, async ({ cwd, path }) => {
        const result = await runRead(tool, cwd, {
          file: path,
          windows: [{ offset: 40, limit: 1 }],
        });
        expect(lines(result)).toEqual([`  const line${39} = ${39};`]);
        expect(notes(result)).toEqual([]);
      });
    });
  });
});
