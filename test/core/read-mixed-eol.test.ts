import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EOL_ENV_VAR } from "../../src/eol-config.js";
import { CONFIG_SCHEMA_ID, configFilePath } from "../../src/json-config.js";
import { anchorRows, setupReadTest, useTestHome, withTempFile } from "../support/fixtures.js";

useTestHome();

beforeEach(() => {
  delete process.env[EOL_ENV_VAR];
});

/** SAFETY: a project settings file this test wrote moments ago in its own temp dir. */
async function seedProjectEol(cwd: string, value: string): Promise<void> {
  const path = configFilePath("project", cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ $schema: CONFIG_SCHEMA_ID, eol: value }, null, 2),
    "utf-8",
  );
}

interface Page {
  content: string;
  args?: Record<string, unknown>;
  projectEol?: string;
  file?: string;
}

async function readPage({
  content,
  args = {},
  projectEol,
  file = "mixed.txt",
}: Page): Promise<string> {
  let text = "";
  await withTempFile(file, content, async ({ cwd }) => {
    if (projectEol !== undefined) await seedProjectEol(cwd, projectEol);
    const { readTool, ctx } = setupReadTest(cwd);
    const result = await readTool.execute("r1", { file, ...args }, undefined, undefined, ctx);
    text = result.content?.[0]?.text ?? "";
  });
  return text;
}

/** The page ENDS with the warning, separated from the body by one blank line, and states it once. */
function expectWarning(text: string, expectedLine: string): void {
  expect(
    text.endsWith(`\n\n${expectedLine}`),
    `page must end with a blank line then ${JSON.stringify(expectedLine)}, saw:\n${text}`,
  ).toBe(true);
  expect(text.split(expectedLine)).toHaveLength(2);
}

function expectNoWarning(text: string): void {
  expect(text).not.toContain("W_MIXED_EOL");
}

function headerLine(text: string): string {
  return text.split("\n")[0]!;
}

describe("a mixed-EOL read page discloses the normalization it will apply", () => {
  it("appends one trailing warning after a served page's rows (#312)", async () => {
    const text = await readPage({ content: "a\r\nb\r\nc\n" });
    expect(headerLine(text)).toBe("[mixed.txt (3 lines total)]");
    expectWarning(
      text,
      "[W_MIXED_EOL] Mixed EOL: 2 CRLF, 1 LF. All edits normalize to CRLF (file).",
    );
    expect(anchorRows(text)).toHaveLength(3);
    expect(text).toContain("3 lines total");
    expect(text.split("\n").at(-1)).not.toMatch(/^[A-Za-z0-9]{4}│/);
  });

  it("stays silent for a uniform file, whatever its terminator, and for none at all", async () => {
    for (const content of ["a\r\nb\r\n", "a\nb\n", "a\rb\r", "abc"]) {
      const text = await readPage({ content });
      expectNoWarning(text);
    }
  });

  it("names the WHOLE file's counts when the page is windowed", async () => {
    const text = await readPage({
      content: "1\r\n2\r\n3\n4\r\n5\r\n",
      args: { windows: [{ offset: 2, limit: 2 }] },
    });
    expect(headerLine(text)).toBe("[mixed.txt (lines 2-3 of 5 total)]");
    expectWarning(
      text,
      "[W_MIXED_EOL] Mixed EOL: 4 CRLF, 1 LF. All edits normalize to CRLF (file).",
    );
    expect(anchorRows(text)).toHaveLength(2);
  });

  it("carries the warning on a verbatim page, breaking the tie toward LF", async () => {
    const text = await readPage({ content: "a\r\nb\n", args: { mode: "verbatim" } });
    expect(headerLine(text)).toBe("[mixed.txt (verbatim, 2 lines total)]");
    expectWarning(text, "[W_MIXED_EOL] Mixed EOL: 1 CRLF, 1 LF. All edits normalize to LF (file).");
  });

  it("names the forced setting and its rung when a project config decides the EOL", async () => {
    const mixed = await readPage({ content: "a\r\nb\nc\r\n", projectEol: "LF" });
    expectWarning(
      mixed,
      "[W_MIXED_EOL] Mixed EOL: 2 CRLF, 1 LF. All edits normalize to LF (project).",
    );
    const uniform = await readPage({ content: "a\r\nb\r\n", projectEol: "LF" });
    expectNoWarning(uniform);
  });

  it("states the warning once for a two-window page", async () => {
    const text = await readPage({
      content: "1\r\n2\r\n3\n4\r\n5\r\n",
      args: {
        windows: [
          { offset: 1, limit: 2 },
          { offset: 4, limit: 2 },
        ],
      },
    });
    expectWarning(
      text,
      "[W_MIXED_EOL] Mixed EOL: 4 CRLF, 1 LF. All edits normalize to CRLF (file).",
    );
  });

  it("names a lone CR alongside LF in the fixed CRLF, LF, CR order", async () => {
    const text = await readPage({ content: "one\rtwo\nthree" });
    expectWarning(text, "[W_MIXED_EOL] Mixed EOL: 1 LF, 1 CR. All edits normalize to LF (file).");
  });
});
