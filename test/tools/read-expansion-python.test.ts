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
  new URL("../fixtures/grammars/tree-sitter-python.wasm.gz", import.meta.url),
);

type ReadResult = {
  content: Array<{ text?: string }>;
  details?: { widened?: unknown };
};

/** Serve the pinned Python grammar from the local gzip fixture; verify still checks its digest. */
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
  return tool.execute("read-expansion-python", params, undefined, undefined, {
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
  const cacheRoot = await mkdtemp(join(tmpdir(), "pbe-py-expansion-"));
  try {
    await run(cacheRoot);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

describe("read expansion: Python boundaries", () => {
  it("includes the def line and every stacked decorator", async () => {
    const source = `@cached\n@logged\ndef greet(name):\n    return f"hi {name}"\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("greet.py", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 4, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("@cached");
        expect(served).toContain("@logged");
        expect(served).toContain("def greet(name):");
        expect(served.at(-1)).toBe('    return f"hi {name}"');
        expect(notes(result)).toEqual(["[widened 4-4 -> 1-4, function greet]"]);
        expect(result.details?.widened).toBeUndefined();
      });
    });
  });

  it("widens to a decorated method rather than its class", async () => {
    const source = `class Service:\n    @logged\n    def run(self):\n        return 1\n\n    def idle(self):\n        return 0\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("service.py", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 4, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("    @logged");
        expect(served).toContain("    def run(self):");
        expect(served.at(-1)).toBe("        return 1");
        expect(served.join("\n")).not.toContain("class Service");
        expect(notes(result)).toEqual(["[widened 4-4 -> 2-4, method run]"]);
      });
    });
  });

  it("widens a nested block to the enclosing function", async () => {
    const source = `def outer(flag):\n    if flag:\n        return 1\n    return 0\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("outer.py", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 3, limit: 1 }],
        });
        const served = lines(result);

        expect(served[0]).toBe("def outer(flag):");
        expect(served.at(-1)).toBe("    return 0");
        expect(served).toHaveLength(4);
        expect(notes(result)).toEqual(["[widened 3-3 -> 1-4, function outer]"]);
      });
    });
  });

  it("leaves imports and module-level statements at the requested window", async () => {
    const source = `import os\nimport sys\n\nvalue = 1\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("module.py", source, async ({ cwd, path }) => {
        const tool = reader(cacheRoot);
        for (const offset of [1, 4]) {
          const result = await runRead(tool, cwd, { file: path, windows: [{ offset, limit: 1 }] });
          expect(lines(result)).toEqual([source.split("\n")[offset - 1]]);
          expect(notes(result)).toEqual([]);
        }
      });
    });
  });

  it("returns the exact window on a syntax error, with no note", async () => {
    const source = `def broken(\n    return 1\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("broken.py", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 2, limit: 1 }],
        });

        expect(lines(result)).toEqual(["    return 1"]);
        expect(notes(result)).toEqual([]);
        expect(result.details?.widened).toBeUndefined();
      });
    });
  });

  it("widens an async decorated function and labels it a function", async () => {
    const source = `@cached\nasync def fetch():\n    return 1\n`;
    await withRealGrammar(async (cacheRoot) => {
      await withTempFile("fetch.py", source, async ({ cwd, path }) => {
        const result = await runRead(reader(cacheRoot), cwd, {
          file: path,
          windows: [{ offset: 3, limit: 1 }],
        });

        expect(lines(result)[0]).toBe("@cached");
        expect(lines(result).at(-1)).toBe("    return 1");
        expect(notes(result)).toEqual(["[widened 3-3 -> 1-3, function fetch]"]);
      });
    });
  });
});
