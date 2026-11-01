import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("web-tree-sitter", () => {
  throw Object.assign(new Error("Cannot find module 'web-tree-sitter'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
});

import { regRead } from "../../src/read";
import {
  readExpansionLogPath,
  resetReadExpansionLogStateForTests,
} from "../../src/read-expansion/audit";
import { GRAMMAR_MANIFEST } from "../../src/read-expansion/grammar-manifest";
import {
  hasWebTreeSitterRuntime,
  loadWebTreeSitterGrammar,
} from "../../src/read-expansion/grammar-runtime";
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

describe("read expansion: real wasm import failure", () => {
  it("maps ERR_MODULE_NOT_FOUND to an exact read and one audit entry", async () => {
    clearAuditLog();
    expect(await hasWebTreeSitterRuntime()).toBe(false);
    expect(await loadWebTreeSitterGrammar(new Uint8Array([0, 97, 115, 109]))).toBeUndefined();

    const { pi, getTool } = makeFakePiRegistry();
    regRead(pi, {
      spanProvider: createReadSpanProvider({ manifest: GRAMMAR_MANIFEST }),
    });
    const tool = getTool("read") as {
      execute(
        callId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown,
      ): Promise<ReadResult>;
    };

    await withTempFile("absent.ts", numbered(12), async ({ cwd, path }) => {
      for (const callId of ["real-absent-1", "real-absent-2"]) {
        const result = await tool.execute(
          callId,
          { file: path, windows: [{ offset: 3, limit: 2 }] },
          undefined,
          undefined,
          { cwd, sessionManager: testSessionManager },
        );
        expect(lines(result)).toEqual(["line 3", "line 4"]);
        expect(notes(result)).toEqual([]);
      }
    });

    const absent = auditRecords().filter((record) => record["reason"] === "runtime_absent");
    expect(absent).toEqual([
      expect.objectContaining({
        outcome: "refused",
        reason: "runtime_absent",
        mode: "served",
        rung: "default",
      }),
    ]);
  });
});
