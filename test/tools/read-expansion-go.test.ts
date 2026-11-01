import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import { createAstSpanProvider } from "../../src/read-expansion/ast-provider";
import {
  anchorRows,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/grammars/tree-sitter-go.wasm.gz", import.meta.url),
);

type ReadResult = {
  content: Array<{ text?: string }>;
  details?: { widened?: unknown };
};

/** Serve the pinned Go grammar from the local gzip fixture; verify still checks its digest. */
function fixtureFetch(): typeof fetch {
  return (async () => {
    const bytes = gunzipSync(readFileSync(FIXTURE));
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
  return tool.execute("read-expansion-go", params, undefined, undefined, {
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
  const cacheRoot = await mkdtemp(join(tmpdir(), "pbe-go-expansion-"));
  try {
    await run(cacheRoot);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

describe("read expansion: Go boundaries", () => {
  it("includes the function's leading doc comment", async () => {
    const source = `package demo\n\n// Greet says hello.\n// A second line.\nfunc Greet(name string) string {\n\tif name == "" {\n\t\tname = "world"\n\t}\n\treturn "hi " + name\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("greet.go", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 9, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("// Greet says hello.");
        expect(served).toContain("// A second line.");
        expect(served).toContain("func Greet(name string) string {");
        expect(served.at(-1)).toBe("}");
        expect(notes(result)).toEqual(["[widened 9-9 -> 3-10, function Greet]"]);
        expect(result.details?.widened).toBeUndefined();
      });
    });
  });

  it("widens a receiver method to the method, not its type declaration", async () => {
    const source = `package demo\n\ntype Server struct{}\n\n// Run starts the server.\nfunc (s *Server) Run(n int) int {\n\tvalues := []int{1, 2, 3}\n\tif n > 0 {\n\t\treturn values[0]\n\t}\n\treturn 0\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("server.go", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 9, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("// Run starts the server.");
        expect(served).toContain("func (s *Server) Run(n int) int {");
        expect(served.at(-1)).toBe("}");
        expect(served.join("\n")).not.toContain("type Server struct{}");
        expect(notes(result)).toEqual(["[widened 9-9 -> 5-12, method Run]"]);
      });
    });
  });

  it("widens nested blocks and composite literals to the enclosing function", async () => {
    const source = `package demo\n\nfunc Build(flag bool) []int {\n\tvalues := []int{1, 2, 3}\n\tif flag {\n\t\treturn values\n\t}\n\treturn nil\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("build.go", source, async ({ cwd, path }) => {
        const tool = reader(cacheRoot);
        for (const offset of [4, 6]) {
          const result = await runRead(tool, cwd, {
            file: path,
            windows: [{ offset, limit: 1 }],
          });
          expect(lines(result)[0]).toBe("func Build(flag bool) []int {");
          expect(lines(result).at(-1)).toBe("}");
          expect(notes(result)).toEqual([`[widened ${offset}-${offset} -> 3-9, function Build]`]);
        }
      });
    });
  });

  it("widens a type declaration with the typeAlias label", async () => {
    const source = `package demo\n\ntype Name = struct {\n\tValue string\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("alias.go", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 4, limit: 1 }],
        });
        expect(lines(result)).toEqual(["type Name = struct {", "\tValue string", "}"]);
        expect(notes(result)).toEqual(["[widened 4-4 -> 3-5, typeAlias Name]"]);
      });
    });
  });

  it("leaves a grouped type declaration header exact", async () => {
    const source = `package demo\n\ntype (\n\tA = int\n\tB = string\n)\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("group.go", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 3, limit: 1 }],
        });
        expect(lines(result)).toEqual(["type ("]);
        expect(notes(result)).toEqual([]);
      });
    });
  });

  it("leaves package, import and top-level var probes at the requested window", async () => {
    const source = `package demo\n\nimport "fmt"\n\nvar top = 1\n\nfunc helper() {}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("top.go", source, async ({ cwd, path }) => {
        const tool = reader(cacheRoot);
        for (const offset of [1, 3, 5]) {
          const result = await runRead(tool, cwd, { file: path, windows: [{ offset, limit: 1 }] });
          expect(lines(result)).toEqual([source.split("\n")[offset - 1]]);
          expect(notes(result)).toEqual([]);
        }
      });
    });
  });

  it("refuses a documented over-cap function and serves the exact window", async () => {
    const body = Array.from({ length: 82 }, (_, index) => `\t_ = ${index}`).join("\n");
    const source = `package demo\n\n// Big does stuff.\nfunc Big() {\n${body}\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("big.go", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 50, limit: 1 }],
        });

        expect(lines(result)).toEqual(["\t_ = 45"]);
        expect(notes(result)).toEqual([]);
      });
    });
  });

  it("does not claim a trailing comment from the previous declaration", async () => {
    const source = `package demo\n\nfunc A() {} // done\nfunc B() {}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("trailing.go", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 4, limit: 1 }],
        });
        const served = lines(result);

        expect(served).toEqual(["func B() {}"]);
        expect(notes(result)).toEqual(["[widened 4-4 -> 4-4, function B]"]);
      });
    });
  });

  it("returns the exact window on a syntax error, with no note", async () => {
    const source = `package demo\n\nfunc broken( {\n\treturn\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("broken.go", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 4, limit: 1 }],
        });

        expect(lines(result)).toEqual(["\treturn"]);
        expect(notes(result)).toEqual([]);
        expect(result.details?.widened).toBeUndefined();
      });
    });
  });
});
