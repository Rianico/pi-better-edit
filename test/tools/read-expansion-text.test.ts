import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import { createReadSpanProvider } from "../../src/read-expansion/read-provider";
import { isDataPath, isPlainTextPath } from "../../src/read-expansion/paragraph-provider";
import {
  readExpansionLogPath,
  resetReadExpansionLogStateForTests,
} from "../../src/read-expansion/audit";
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
  return tool.execute("read-expansion-text", params, undefined, undefined, {
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
describe("read expansion: plain-text paragraphs", () => {
  it("returns the paragraph containing a probe with a paragraph note", async () => {
    const source = `alpha one\nalpha two\n\nbeta one\nbeta two\n`;
    await withTempFile("paragraphs.txt", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });

      expect(lines(result)).toEqual(["alpha one", "alpha two"]);
      expect(notes(result)).toEqual(["[widened 2-2 -> 1-2, paragraph]"]);
    });
  });

  it("returns only the requested window when it spans two paragraphs", async () => {
    const source = `alpha one\nalpha two\n\nbeta one\nbeta two\n`;
    await withTempFile("span.txt", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 2, limit: 2 }],
      });

      expect(lines(result)).toEqual(["alpha two", ""]);
      expect(notes(result)).toEqual([]);
    });
  });

  it("widens up to the 40-line cap and refuses a 41-line paragraph", async () => {
    await withTempFile("at-cap.txt", `${numbered(40)}\n\nbeta`, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 20, limit: 1 }],
      });

      expect(lines(result)).toHaveLength(40);
      expect(notes(result)).toEqual(["[widened 20-20 -> 1-40, paragraph]"]);
    });

    await withTempFile("over-cap.txt", `${numbered(41)}\n\nbeta`, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 20, limit: 1 }],
      });

      expect(lines(result)).toEqual(["line 20"]);
      expect(notes(result)).toEqual([]);
    });
  });

  it("never expands line-oriented data extensions", async () => {
    const tool = reader();
    const source = `alpha\n\nalpha two\n`;
    for (const name of ["data.log", "data.csv", "data.tsv", "data.jsonl", "data.ndjson"]) {
      await withTempFile(name, source, async ({ cwd, path }) => {
        const result = await runRead(tool, cwd, {
          file: path,
          windows: [{ offset: 1, limit: 1 }],
        });
        expect(lines(result)).toEqual(["alpha"]);
        expect(notes(result)).toEqual([]);
      });
    }
  });

  it("leaves a blank-free file exact within and above the cap", async () => {
    const tool = reader();
    await withTempFile("single.txt", numbered(10), async ({ cwd, path }) => {
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 5, limit: 1 }],
      });
      expect(lines(result)).toEqual(["line 5"]);
      expect(notes(result)).toEqual([]);
    });

    await withTempFile("single-over.txt", numbered(41), async ({ cwd, path }) => {
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 20, limit: 1 }],
      });
      expect(lines(result)).toEqual(["line 20"]);
      expect(notes(result)).toEqual([]);
    });
  });

  it("leaves an empty file exact with no note", async () => {
    await withTempFile("empty.txt", "", async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 1, limit: 1 }],
      });

      expect(lines(result)).toEqual([""]);
      expect(notes(result)).toEqual([]);
    });
  });

  it("leaves whitespace-only files at the requested window", async () => {
    await withTempFile("blank.txt", `\n   \n`, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 1, limit: 1 }],
      });

      expect(lines(result)).toEqual([""]);
      expect(notes(result)).toEqual([]);
    });
  });

  it("records a paragraph over-cap refusal with its extent and label", async () => {
    clearAuditLog();
    await withTempFile("audit-text.txt", `${numbered(41)}\n\nbeta`, async ({ cwd, path }) => {
      await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 20, limit: 1 }],
      });
    });

    expect(auditRecords().find((record) => record["reason"] === "over_cap")).toMatchObject({
      mode: "served",
      outcome: "refused",
      reason: "over_cap",
      requested: [{ startLine: 20, endLine: 20 }],
      section: { startLine: 1, endLine: 41 },
      kind: "paragraph",
      name: "lines 1-41",
      source: "text",
      label: "paragraph lines 1-41",
    });
  });

  it("pins the plain-text and data extension lists", () => {
    expect(isPlainTextPath("notes.txt")).toBe(true);
    expect(isPlainTextPath("notes.TEXT")).toBe(true);
    expect(isPlainTextPath("notes.md")).toBe(false);
    for (const extension of ["log", "csv", "tsv", "jsonl", "ndjson"]) {
      expect(isDataPath(`data.${extension}`)).toBe(true);
      expect(isDataPath(`data.${extension.toUpperCase()}`)).toBe(true);
    }
    expect(isDataPath("data.txt")).toBe(false);
  });
});
