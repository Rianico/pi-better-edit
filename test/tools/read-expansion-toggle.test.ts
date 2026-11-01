import { readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import {
  readExpansionLogPath,
  resetReadExpansionLogStateForTests,
} from "../../src/read-expansion/audit";
import { READ_EXPANSION_ENV_VAR } from "../../src/read-expansion-config";
import type { SpanProvider } from "../../src/read-expansion/span-expansion";
import {
  anchorRows,
  clearDiagnostics,
  getText,
  readDiagnostics,
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

function readerWith(provider: SpanProvider) {
  const { pi, getTool } = makeFakePiRegistry();
  regRead(pi, { spanProvider: provider });
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

const SOURCE = numbered(10);

async function withMode<T>(mode: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[READ_EXPANSION_ENV_VAR];
  process.env[READ_EXPANSION_ENV_VAR] = mode;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[READ_EXPANSION_ENV_VAR];
    else process.env[READ_EXPANSION_ENV_VAR] = previous;
  }
}

describe("read expansion toggle", () => {
  it("off bypasses the provider and records toggle_off", async () => {
    clearAuditLog();
    let calls = 0;
    const provider: SpanProvider = {
      enclosingSpan: () => {
        calls += 1;
        return { start: 1, end: 10, kind: "function", name: "shouldNotRun", source: "ast" };
      },
    };
    await withMode("off", async () => {
      await withTempFile("off.txt", SOURCE, async ({ cwd, path }) => {
        const result = await readerWith(provider).execute(
          "toggle-off",
          { file: path, windows: [{ offset: 3, limit: 2 }] },
          undefined,
          undefined,
          { cwd, sessionManager: testSessionManager },
        );

        expect(lines(result)).toEqual(["line 3", "line 4"]);
        expect(notes(result)).toEqual([]);

        const second = await readerWith(provider).execute(
          "toggle-off-2",
          { file: path, windows: [{ offset: 5, limit: 2 }] },
          undefined,
          undefined,
          { cwd, sessionManager: testSessionManager },
        );
        expect(lines(second)).toEqual(["line 5", "line 6"]);
      });
    });

    expect(calls).toBe(0);
    expect(auditRecords()).toEqual([
      expect.objectContaining({
        outcome: "refused",
        reason: "toggle_off",
        requested: [{ startLine: 3, endLine: 4 }],
      }),
    ]);
  });

  it("warns and stays on when the project config is unusable", async () => {
    clearDiagnostics();
    clearAuditLog();
    let calls = 0;
    const provider: SpanProvider = {
      enclosingSpan: () => {
        calls += 1;
        return { start: 2, end: 5, kind: "function", name: "fallback", source: "ast" };
      },
    };
    await withTempFile("bad-config.txt", SOURCE, async ({ cwd, path }) => {
      await mkdir(join(cwd, ".pi", "agents", "pi-better-edit"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "agents", "pi-better-edit", "settings.json"),
        "{ not json",
        "utf-8",
      );
      const result = await readerWith(provider).execute(
        "toggle-bad-config",
        { file: path, windows: [{ offset: 3, limit: 1 }] },
        undefined,
        undefined,
        { cwd, sessionManager: testSessionManager },
      );
      expect(notes(result)).toEqual(["[widened 3-3 -> 2-5, function fallback]"]);
    });

    expect(calls).toBe(1);
    expect(readDiagnostics().some((record) => record.scope === "read-expansion")).toBe(true);
  });

  it("on expands and records the resolved env rung", async () => {
    clearAuditLog();
    const provider: SpanProvider = {
      enclosingSpan: () => ({ start: 2, end: 5, kind: "function", name: "runner", source: "ast" }),
    };
    await withMode("on", async () => {
      await withTempFile("on.txt", SOURCE, async ({ cwd, path }) => {
        const result = await readerWith(provider).execute(
          "toggle-on",
          { file: path, windows: [{ offset: 3, limit: 1 }] },
          undefined,
          undefined,
          { cwd, sessionManager: testSessionManager },
        );

        expect(lines(result)).toEqual(["line 2", "line 3", "line 4", "line 5"]);
        expect(notes(result)).toEqual(["[widened 3-3 -> 2-5, function runner]"]);
      });
    });

    expect(auditRecords().find((record) => record["outcome"] === "applied")).toMatchObject({
      rung: "env",
      source: "ast",
      label: "function runner",
    });
  });
});
