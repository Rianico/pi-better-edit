import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import { createAstSpanProvider } from "../../src/read-expansion/ast-provider";
import { GRAMMAR_MANIFEST } from "../../src/read-expansion/grammar-manifest";
import {
  anchorRows,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/grammars/tree-sitter-rust.wasm.gz", import.meta.url),
);

type ReadResult = {
  content: Array<{ text?: string }>;
  details?: { widened?: unknown };
};

/** Serve the pinned Rust grammar from the local gzip fixture; verify still checks its digest. */
function fixtureFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    if (String(input) !== GRAMMAR_MANIFEST.rust?.url) {
      throw new Error(`unexpected Rust grammar URL: ${String(input)}`);
    }
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
  return tool.execute("read-expansion-rust", params, undefined, undefined, {
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
  const cacheRoot = await mkdtemp(join(tmpdir(), "pbe-rs-expansion-"));
  try {
    await run(cacheRoot);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

describe("read expansion: Rust boundaries", () => {
  it("includes stacked attributes and /// doc comments", async () => {
    const source = `use std::fmt;\n\n/// Adds two numbers.\n/// More docs.\n#[test]\n#[cfg(unix)]\nfn add(a: i32, b: i32) -> i32 {\n    if a > 0 {\n        return a + b;\n    }\n    a\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("add.rs", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 9, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("/// Adds two numbers.");
        expect(served).toContain("/// More docs.");
        expect(served).toContain("#[test]");
        expect(served).toContain("#[cfg(unix)]");
        expect(served).toContain("fn add(a: i32, b: i32) -> i32 {");
        expect(served.at(-1)).toBe("}");
        expect(notes(result)).toEqual(["[widened 9-9 -> 3-12, function add]"]);
        expect(result.details?.widened).toBeUndefined();
      });
    });
  });

  it("widens an impl function to the function, not the impl", async () => {
    const source = `struct S;\n\nimpl S {\n    /// Runs.\n    #[inline]\n    fn run(&self) -> i32 {\n        let x = 1;\n        x\n    }\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("impl.rs", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 7, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("    /// Runs.");
        expect(served).toContain("    #[inline]");
        expect(served).toContain("    fn run(&self) -> i32 {");
        expect(served.at(-1)).toBe("    }");
        expect(served.join("\n")).not.toContain("impl S {");
        expect(notes(result)).toEqual(["[widened 7-7 -> 4-9, method run]"]);
      });
    });
  });

  it("widens a trait signature and a provided trait method to methods", async () => {
    const source = `trait T {\n    /// Required.\n    fn required(&self) -> i32;\n\n    /// Provided.\n    fn provided(&self) -> i32 {\n        let x = 2;\n        x\n    }\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("trait.rs", source, async ({ cwd, path }) => {
        const tool = reader(cacheRoot);

        const required = await runRead(tool, cwd, {
          file: path,
          windows: [{ offset: 3, limit: 1 }],
        });
        expect(lines(required)[0]).toBe("    /// Required.");
        expect(lines(required).at(-1)).toBe("    fn required(&self) -> i32;");
        expect(notes(required)).toEqual(["[widened 3-3 -> 2-3, method required]"]);

        const provided = await runRead(tool, cwd, {
          file: path,
          windows: [{ offset: 8, limit: 1 }],
        });
        expect(lines(provided)[0]).toBe("    /// Provided.");
        expect(lines(provided).at(-1)).toBe("    }");
        expect(notes(provided)).toEqual(["[widened 8-8 -> 5-9, method provided]"]);
      });
    });
  });

  it("widens a nested block to the enclosing function", async () => {
    const source = `fn outer(flag: bool) -> i32 {\n    if flag {\n        let x = 1;\n        return x;\n    }\n    0\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("outer.rs", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 4, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("fn outer(flag: bool) -> i32 {");
        expect(served.at(-1)).toBe("}");
        expect(served).toHaveLength(7);
        expect(notes(result)).toEqual(["[widened 4-4 -> 1-7, function outer]"]);
      });
    });
  });

  it("leaves crate-root items at the requested window", async () => {
    const source = `use std::fmt;\n\nconst X: i32 = 1;\n\nstatic Y: i32 = 2;\n\nmod nested {\n    pub fn inner() {}\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("root.rs", source, async ({ cwd, path }) => {
        const tool = reader(cacheRoot);
        for (const offset of [1, 3, 5, 7]) {
          const result = await runRead(tool, cwd, { file: path, windows: [{ offset, limit: 1 }] });
          expect(lines(result)).toEqual([source.split("\n")[offset - 1]]);
          expect(notes(result)).toEqual([]);
        }
      });
    });
  });

  it("attaches a block doc comment", async () => {
    const source = `/** Block docs. */\nfn block() -> i32 { 1 }\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("block.rs", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 2, limit: 1 }],
        });

        expect(lines(result)[0]).toBe("/** Block docs. */");
        expect(notes(result)).toEqual(["[widened 2-2 -> 1-2, function block]"]);
      });
    });
  });

  it("ignores inner, ordinary and empty block comments", async () => {
    const source = `//! inner docs\nuse std::fmt;\n\n// note\n//// ordinary\nfn a() -> i32 { 1 }\n\n/**/\nfn b() -> i32 { 2 }\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("comments.rs", source, async ({ cwd, path }) => {
        const tool = reader(cacheRoot);
        for (const offset of [6, 9]) {
          const result = await runRead(tool, cwd, {
            file: path,
            windows: [{ offset, limit: 1 }],
          });
          expect(lines(result)).toEqual([source.split("\n")[offset - 1]]);
          expect(notes(result)).toEqual([
            `[widened ${offset}-${offset} -> ${offset}-${offset}, function ${offset === 6 ? "a" : "b"}]`,
          ]);
        }
      });
    });
  });

  it("returns the exact window on a syntax error, with no note", async () => {
    const source = `fn broken( {\n    1\n}\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("broken.rs", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 2, limit: 1 }],
        });

        expect(lines(result)).toEqual(["    1"]);
        expect(notes(result)).toEqual([]);
        expect(result.details?.widened).toBeUndefined();
      });
    });
  });
});
