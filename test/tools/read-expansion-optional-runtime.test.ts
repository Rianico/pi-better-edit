import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import {
  readExpansionLogPath,
  resetReadExpansionLogStateForTests,
} from "../../src/read-expansion/audit";
import { GRAMMAR_MANIFEST } from "../../src/read-expansion/grammar-manifest";
import { createReadSpanProvider } from "../../src/read-expansion/read-provider";
import {
  anchorRows,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

type ReadResult = { content: Array<{ text?: string }> };

function clearAuditLog(): void {
  const path = readExpansionLogPath();
  rmSync(path, { force: true });
  rmSync(`${path}.1`, { force: true });
  resetReadExpansionLogStateForTests();
}

function auditRecords(): Array<Record<string, unknown>> {
  try {
    return readFileSync(readExpansionLogPath(), "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function readerWithMissingRuntime(fetchCount: { value: number }) {
  const { pi, getTool } = makeFakePiRegistry();
  regRead(pi, {
    spanProvider: createReadSpanProvider({
      manifest: GRAMMAR_MANIFEST,
      fetchImpl: (async () => {
        fetchCount.value += 1;
        throw new Error("network must not run without the wasm host");
      }) as typeof fetch,
      runtimeAvailable: async () => {
        // SAFETY: this is the module-resolution boundary: ESM throws MODULE_NOT_FOUND here.
        throw new Error("Cannot find module 'web-tree-sitter'");
      },
    }),
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
  tool: ReturnType<typeof readerWithMissingRuntime>,
  cwd: string,
  params: unknown,
): Promise<ReadResult> {
  return tool.execute("optional-runtime", params, undefined, undefined, {
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

function numbered(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

describe("read expansion: optional wasm runtime", () => {
  it("serves each grammar-backed language exactly and audits absence once", async () => {
    clearAuditLog();
    const fetches = { value: 0 };
    const tool = readerWithMissingRuntime(fetches);

    for (const name of ["sample.ts", "sample.tsx", "sample.py", "sample.go", "sample.rs"]) {
      await withTempFile(name, numbered(12), async ({ cwd, path }) => {
        const result = await runRead(tool, cwd, {
          file: path,
          windows: [{ offset: 3, limit: 2 }],
        });

        expect(lines(result), name).toEqual(["line 3", "line 4"]);
        expect(notes(result), name).toEqual([]);
      });
    }

    expect(fetches.value).toBe(0);
    expect(auditRecords()).toEqual([
      expect.objectContaining({
        outcome: "refused",
        reason: "runtime_absent",
        rung: "default",
      }),
    ]);
  });

  it("still expands Markdown, plain text and bash without the wasm host", async () => {
    clearAuditLog();
    const fetches = { value: 0 };
    const tool = readerWithMissingRuntime(fetches);

    const markdown = `# Guide\n\nIntro.\n\n## Language\n\nAlpha.\nBeta.\n\n## Next\n\nDelta.\n`;
    await withTempFile("guide.md", markdown, async ({ cwd, path }) => {
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 7, limit: 1 }],
      });
      expect(notes(result)).toEqual(['[widened 7-7 -> 5-9, section "Language"]']);
    });

    const text = `first line\nsecond line\n\nsecond paragraph\nanother\n`;
    await withTempFile("notes.txt", text, async ({ cwd, path }) => {
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 1, limit: 1 }],
      });
      expect(notes(result)).toEqual(["[widened 1-1 -> 1-2, paragraph]"]);
    });

    const bash = `#!/usr/bin/env bash\n\nfoo() {\n  echo hi\n  echo bye\n}\n`;
    await withTempFile("foo.sh", bash, async ({ cwd, path }) => {
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 4, limit: 1 }],
      });
      expect(notes(result)).toEqual(["[widened 4-4 -> 3-6, function foo]"]);
    });

    expect(fetches.value).toBe(0);
    expect(auditRecords().filter((record) => record["reason"] === "runtime_absent")).toEqual([]);
    expect(auditRecords()).toHaveLength(3);
  });
});
