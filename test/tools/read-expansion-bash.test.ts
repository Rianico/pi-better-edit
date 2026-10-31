import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import { createReadSpanProvider } from "../../src/read-expansion/read-provider";
import { isShellPath } from "../../src/read-expansion/bash-provider";
import { GRAMMAR_MANIFEST } from "../../src/read-expansion/grammar-manifest";
import {
  anchorRows,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

type ReadResult = {
  content: Array<{ text?: string }>;
};

function reader() {
  const { pi, getTool } = makeFakePiRegistry();
  regRead(pi, { spanProvider: createReadSpanProvider() });
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
  return tool.execute("read-expansion-bash", params, undefined, undefined, {
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

describe("read expansion: bash functions", () => {
  it("serves a name() function body with its function note", async () => {
    const source = `#!/usr/bin/env bash\n\nfoo() {\n  echo hi\n  echo bye\n}\n\nbar\n`;
    await withTempFile("foo.sh", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 4, limit: 1 }],
      });

      expect(lines(result)).toEqual(["foo() {", "  echo hi", "  echo bye", "}"]);
      expect(notes(result)).toEqual(["[widened 4-4 -> 3-6, function foo]"]);
    });
  });

  it("serves a function name { ... } body", async () => {
    const source = `function bar {\n  echo hi\n  echo bye\n}\n`;
    await withTempFile("bar.bash", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 3, limit: 1 }],
      });

      expect(lines(result)).toEqual(["function bar {", "  echo hi", "  echo bye", "}"]);
      expect(notes(result)).toEqual(["[widened 3-3 -> 1-4, function bar]"]);
    });
  });

  it("widens a nested function to the innermost function", async () => {
    const source = `outer() {\n  inner() {\n    echo nested\n  }\n  inner\n}\n`;
    await withTempFile("nested.sh", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 3, limit: 1 }],
      });

      expect(lines(result)).toEqual(["  inner() {", "    echo nested", "  }"]);
      expect(notes(result)).toEqual(["[widened 3-3 -> 2-4, function inner]"]);
    });
  });

  it("returns the exact window when the parser reports errors", async () => {
    const source = `broken() {\n  if then\n}\n`;
    await withTempFile("broken.sh", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });

      expect(lines(result)).toEqual(["  if then"]);
      expect(notes(result)).toEqual([]);
    });
    await withTempFile(
      "nested-error.sh",
      `foo() {\n  echo $(if then)\n}\n`,
      async ({ cwd, path }) => {
        const result = await runRead(reader(), cwd, {
          file: path,
          windows: [{ offset: 2, limit: 1 }],
        });

        expect(lines(result)).toEqual(["  echo $(if then)"]);
        expect(notes(result)).toEqual([]);
      },
    );
  });

  it("picks the inner function when both occupy one line", async () => {
    const source = `outer() { inner() { :; }; }\n`;
    await withTempFile("one-line.sh", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 1, limit: 1 }],
      });

      expect(notes(result)).toEqual(["[widened 1-1 -> 1-1, function inner]"]);
    });
  });

  it("refuses a function above the 80-line code cap", async () => {
    const body = Array.from({ length: 82 }, (_, index) => `  echo ${index + 1}`).join("\n");
    const source = `big() {\n${body}\n}\n`;
    await withTempFile("big.sh", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 40, limit: 1 }],
      });

      expect(lines(result)).toEqual(["  echo 39"]);
      expect(notes(result)).toEqual([]);
    });
  });

  it("uses the existing shell family and adds no bash grammar", () => {
    expect(isShellPath("script.sh")).toBe(true);
    expect(isShellPath("script.BASH")).toBe(true);
    expect(isShellPath("script.zsh")).toBe(true);
    expect(isShellPath("script.txt")).toBe(false);
    expect(isShellPath("script.sh.bak")).toBe(false);
    expect(GRAMMAR_MANIFEST.bash).toBeUndefined();
  });
});
