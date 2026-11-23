/**
 * End-to-end EOL matrix (#314): one fixture carried through all three surfaces — the read page's
 * `[W_MIXED_EOL]` line, the `[W_EOL_REWRITTEN]` line and bytes the `edit` writes, and
 * `undo_last_edit`'s bytes plus its mixture clause. The four landed suites pin one surface each;
 * this one pins their agreement, the whole rung ladder end to end, and that the two lines name
 * the same target and source.
 *
 * ## Repro — `pnpm exec vitest run test/core/eol-matrix.test.ts`
 * On the pre-#311 tree every mixed row's edit rewrote its minority separators silently: no
 * `[W_EOL_REWRITTEN]` line, and `undo_last_edit` restored a mixture the edit had already lost.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toLF } from "../../src/edit-diff.js";
import { EOL_ENV_VAR } from "../../src/eol-config.js";
import { readBytes } from "../../src/fs-write.js";
import { initHasher, lineHashes } from "../../src/hashline/hash-identity.js";
import { CONFIG_SCHEMA_ID, configFilePath } from "../../src/json-config.js";
import { execute, isMutationSuccess } from "../../src/mutation-engine/index.js";
import { assertReq, normReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import {
  getText,
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
  withTempBytes,
} from "../support/fixtures.js";

useTestHome();

beforeAll(async () => {
  await initHasher();
});

/** The global settings file a ladder row may leave behind for a later row in this file. */
function globalSettingsPath(): string {
  return configFilePath("global", process.cwd());
}

beforeEach(async () => {
  delete process.env[EOL_ENV_VAR];
  await rm(globalSettingsPath(), { force: true });
});

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

/** SAFETY: a settings file this test wrote moments ago in its own temp dir. */
async function seedEol(scope: "project" | "global", cwd: string, value: string): Promise<void> {
  const path = configFilePath(scope, cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ $schema: CONFIG_SCHEMA_ID, eol: value }, null, 2),
    "utf-8",
  );
}

type EolName = "LF" | "CRLF" | "CR";
type EolRung = "env" | "project" | "global" | "file" | "system";

function readWarningLine(kinds: string, target: EolName, source: EolRung): string {
  return `[W_MIXED_EOL] Mixed EOL: ${kinds}. All edits normalize to ${target} (${source}).`;
}

function editWarningLine(target: EolName, source: EolRung, changed: number): string {
  return (
    `[MODEL] [W_EOL_REWRITTEN] EOL normalized to ${target} (${source}): ` +
    `${changed} terminators changed. Undo restores normalized content.`
  );
}

function mixtureClause(ending: EolName): string {
  return `Restored at ${ending}; the pre-edit mixture is not restored.`;
}

function expectBytes(actual: Buffer, expected: string): void {
  expect(
    actual.equals(Buffer.from(expected, "utf-8")),
    `bytes must be ${JSON.stringify(expected)}, saw ${JSON.stringify(actual.toString("utf-8"))}`,
  ).toBe(true);
}

interface Encounter {
  readText: string;
  editText: string;
  editBytes: Buffer;
  undoText: string;
  undoBytes: Buffer;
}

type LineEdit = { index: number; text: string };

/**
 * Write `raw`, serve it, apply one line-replacing `edit`, then call `undo_last_edit`. Every call
 * starts from `raw` again, so a ladder rung sees the same fixture whatever an earlier rung wrote.
 */
async function encounter(
  cwd: string,
  file: string,
  raw: string,
  edit: LineEdit,
): Promise<Encounter> {
  const path = join(cwd, file);
  await writeFile(path, raw, "utf-8");
  const { ctx, readTool, undoTool } = setupIntegrationTest(cwd);
  const readResult = await readTool.execute("r1", { file }, undefined, undefined, ctx);
  const anchors = await lineHashes(toLF(raw), path);

  const result = await execute(
    admit({
      file,
      edits: [
        { anchor_from: anchors[edit.index]!, anchor_to: anchors[edit.index]!, text: edit.text },
      ],
    }),
    cwd,
    { sessionKey: TEST_SESSION_ID },
  );
  expect(isMutationSuccess(result), "the edit must apply").toBe(true);
  if (!isMutationSuccess(result)) throw new Error("edit did not apply");
  const editBytes = await readBytes(path);

  const undo = await undoTool.execute("u1", { path: file }, undefined, undefined, ctx);
  expect(undo.isError, getText(undo)).toBeFalsy();

  return {
    readText: readResult.content?.[0]?.text ?? "",
    editText: result.toolResult.content[0]!.text,
    editBytes,
    undoText: getText(undo),
    undoBytes: await readBytes(path),
  };
}

interface Row {
  title: string;
  raw: string;
  edit: LineEdit;
  readWarning: string | null;
  editBytes: string;
  editWarning: string | null;
  undoBytes: string;
  undoClause: string | null;
}

const MATRIX: Row[] = [
  {
    title:
      "CRLF-majority mix: read warns 2 CRLF and 1 LF, the edit rewrites the lone LF, undo keeps CRLF",
    raw: "a\r\nb\r\nc\n",
    edit: { index: 1, text: "B" },
    readWarning: readWarningLine("2 CRLF, 1 LF", "CRLF", "file"),
    editBytes: "a\r\nB\r\nc\r\n",
    editWarning: editWarningLine("CRLF", "file", 1),
    undoBytes: "a\r\nb\r\nc\r\n",
    undoClause: mixtureClause("CRLF"),
  },
  {
    title:
      "LF-majority mix: read warns 1 CRLF and 2 LF, the edit rewrites the lone CRLF, undo keeps LF",
    raw: "a\nb\nc\r\n",
    edit: { index: 1, text: "B" },
    readWarning: readWarningLine("1 CRLF, 2 LF", "LF", "file"),
    editBytes: "a\nB\nc\n",
    editWarning: editWarningLine("LF", "file", 1),
    undoBytes: "a\nb\nc\n",
    undoClause: mixtureClause("LF"),
  },
  {
    title:
      "CR-majority mix: read warns 1 CRLF and 2 CR, the edit rewrites the lone CRLF, undo keeps CR",
    raw: "a\rb\rc\r\n",
    edit: { index: 1, text: "B" },
    readWarning: readWarningLine("1 CRLF, 2 CR", "CR", "file"),
    editBytes: "a\rB\rc\r",
    editWarning: editWarningLine("CR", "file", 1),
    undoBytes: "a\rb\rc\r",
    undoClause: mixtureClause("CR"),
  },
  {
    title: "uniform CRLF: neither surface warns, the edit keeps CRLF, undo restores the raw bytes",
    raw: "a\r\nb\r\n",
    edit: { index: 1, text: "B" },
    readWarning: null,
    editBytes: "a\r\nB\r\n",
    editWarning: null,
    undoBytes: "a\r\nb\r\n",
    undoClause: null,
  },
  {
    title: "uniform LF: neither surface warns, the edit keeps LF, undo restores the raw bytes",
    raw: "a\nb\n",
    edit: { index: 1, text: "B" },
    readWarning: null,
    editBytes: "a\nB\n",
    editWarning: null,
    undoBytes: "a\nb\n",
    undoClause: null,
  },
  {
    title: "uniform CR: neither surface warns, the edit keeps CR, undo restores the raw bytes",
    raw: "a\rb\r",
    edit: { index: 1, text: "B" },
    readWarning: null,
    editBytes: "a\rB\r",
    editWarning: null,
    undoBytes: "a\rb\r",
    undoClause: null,
  },
  {
    title:
      "one line with no terminator: neither surface warns, the edit writes no terminator, undo restores it",
    raw: "ab",
    edit: { index: 0, text: "AB" },
    readWarning: null,
    editBytes: "AB",
    editWarning: null,
    undoBytes: "ab",
    undoClause: null,
  },
];

describe("one fixture across read, edit and undo", () => {
  it.each(MATRIX)("$title", async (row) => {
    await withTempBytes("sample.txt", Buffer.from(row.raw, "utf-8"), async ({ cwd }) => {
      const seen = await encounter(cwd, "sample.txt", row.raw, row.edit);

      if (row.readWarning === null) expect(seen.readText).not.toContain("W_MIXED_EOL");
      else expect(seen.readText).toContain(row.readWarning);

      expectBytes(seen.editBytes, row.editBytes);
      if (row.editWarning === null) expect(seen.editText).not.toContain("W_EOL_REWRITTEN");
      else expect(seen.editText).toContain(row.editWarning);

      expectBytes(seen.undoBytes, row.undoBytes);
      if (row.undoClause === null) {
        expect(seen.undoText).not.toContain("the pre-edit mixture is not restored");
      } else {
        expect(seen.undoText).toContain(row.undoClause);
      }
    });
  });
});

describe("the effective-EOL ladder, end to end on one mixed file", () => {
  const RAW = "a\r\nb\r\nc\n";

  it("answers env, then project, then global, and falls back as each rung leaves", async () => {
    await withTempBytes("ladder.txt", Buffer.from(RAW, "utf-8"), async ({ cwd }) => {
      const edit: LineEdit = { index: 1, text: "B" };
      const edit1 = (target: EolName, source: EolRung, changed: number): string =>
        editWarningLine(target, source, changed);

      await seedEol("global", cwd, "CRLF");
      const globalRung = await encounter(cwd, "ladder.txt", RAW, edit);
      expectBytes(globalRung.editBytes, "a\r\nB\r\nc\r\n");
      expect(globalRung.editText).toContain(edit1("CRLF", "global", 1));

      await seedEol("project", cwd, "LF");
      const projectRung = await encounter(cwd, "ladder.txt", RAW, edit);
      expectBytes(projectRung.editBytes, "a\nB\nc\n");
      expect(projectRung.editText).toContain(edit1("LF", "project", 2));

      process.env[EOL_ENV_VAR] = "CR";
      const envRung = await encounter(cwd, "ladder.txt", RAW, edit);
      expectBytes(envRung.editBytes, "a\rB\rc\r");
      expect(envRung.editText).toContain(edit1("CR", "env", 3));

      delete process.env[EOL_ENV_VAR];
      const projectAgain = await encounter(cwd, "ladder.txt", RAW, edit);
      expectBytes(projectAgain.editBytes, "a\nB\nc\n");
      expect(projectAgain.editText).toContain(edit1("LF", "project", 2));

      await rm(configFilePath("project", cwd), { force: true });
      const globalAgain = await encounter(cwd, "ladder.txt", RAW, edit);
      expectBytes(globalAgain.editBytes, "a\r\nB\r\nc\r\n");
      expect(globalAgain.editText).toContain(edit1("CRLF", "global", 1));
    });
  });
});

const READ_LINE_RE =
  /\[W_MIXED_EOL\] Mixed EOL: [^.]*?\. All edits normalize to (CRLF|LF|CR) \((env|project|global|file|system)\)\./;
const EDIT_LINE_RE =
  /\[MODEL\] \[W_EOL_REWRITTEN\] EOL normalized to (CRLF|LF|CR) \((env|project|global|file|system)\): (\d+) terminators changed\. Undo restores normalized content\./;

describe("the read warning and the edit warning name one decision", () => {
  it("states the same target and source on a mixed file's read page and its edit result", async () => {
    const raw = "a\r\nb\r\nc\n";
    await withTempBytes("paired.txt", Buffer.from(raw, "utf-8"), async ({ cwd }) => {
      const seen = await encounter(cwd, "paired.txt", raw, { index: 1, text: "B" });

      const read = READ_LINE_RE.exec(seen.readText);
      const edit = EDIT_LINE_RE.exec(seen.editText);
      expect(read, `read page carried no parseable warning:\n${seen.readText}`).not.toBeNull();
      expect(edit, `edit result carried no parseable warning:\n${seen.editText}`).not.toBeNull();
      expect([read![1], read![2]]).toEqual(["CRLF", "file"]);
      expect([edit![1], edit![2]]).toEqual([read![1], read![2]]);
      expect(edit![3]).toBe("1");
    });
  });

  it("keeps a uniform file's read page silent while the edit names the forced rung", async () => {
    const raw = "a\r\nb\r\n";
    await withTempBytes("forced.txt", Buffer.from(raw, "utf-8"), async ({ cwd }) => {
      await seedEol("project", cwd, "LF");
      const seen = await encounter(cwd, "forced.txt", raw, { index: 1, text: "B" });

      expect(seen.readText).not.toContain("W_MIXED_EOL");
      expectBytes(seen.editBytes, "a\nB\n");
      expect(seen.editText).toContain(editWarningLine("LF", "project", 2));
    });
  });
});
