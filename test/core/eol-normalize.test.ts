/**
 * EOL normalization on the write seam (#311): every `edit` write serializes the whole file at its
 * effective EOL — the forced ladder rung, else the file's dominant terminator — and reports the
 * pre-image terminators whose bytes changed. Disclosure is the writing path's, not the plan's: a
 * foreign cut writes at its pre-image ending (ADR-0019 §5, #313) and therefore reports nothing.
 *
 * ## Repro — `pnpm exec vitest run test/core/eol-normalize.test.ts`
 * Case 1 `"a\r\nb\r\nc\n"` + b→B: BEFORE the bytes were `"a\r\nB\r\nc\r\n"` with no
 * `W_EOL_REWRITTEN` line; AFTER those bytes plus the CRLF (file), 1-terminator line.
 * Case 2 `"a\nb\nc\r\n"` + b→B: BEFORE `"a\nB\nc\n"` and silent; AFTER the same bytes plus
 * the LF (file), 1-terminator line. ADR-0019 has no Repro section, so this is the recorded repro.
 */
import { beforeEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execute, preview, isMutationSuccess } from "../../src/mutation-engine/index.js";
import type { MutationResult } from "../../src/mutation-engine/types.js";
import { normReq, assertReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { toLF } from "../../src/edit-diff.js";
import { EOL_ENV_VAR } from "../../src/eol-config.js";
import { CONFIG_SCHEMA_ID, configFilePath } from "../../src/json-config.js";
import { readBytes } from "../../src/fs-write.js";
import { initHasher, lineHashes } from "../../src/hashline/hash-identity.js";
import {
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
  withTempBytes,
  withTempDir,
} from "../support/fixtures.js";

useTestHome();

beforeAll(async () => {
  await initHasher();
});

beforeEach(() => {
  delete process.env[EOL_ENV_VAR];
});

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

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

type LineEdit = { index: number; text: string };

/** Serve the raw bytes, then apply one `edit` call whose items each replace a whole line. */
async function serveAndEdit(
  cwd: string,
  raw: string,
  edits: readonly LineEdit[],
): Promise<{ bytes: Buffer; text: string; details: unknown }> {
  const { ctx, readTool } = setupIntegrationTest(cwd);
  await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
  const anchors = await lineHashes(toLF(raw), join(cwd, "sample.txt"));
  const result: MutationResult = await execute(
    admit({
      file: "sample.txt",
      edits: edits.map((edit) => ({
        anchor_from: anchors[edit.index]!,
        anchor_to: anchors[edit.index]!,
        text: edit.text,
      })),
    }),
    cwd,
    { sessionKey: TEST_SESSION_ID },
  );
  expect(isMutationSuccess(result), "the edit must apply").toBe(true);
  if (!isMutationSuccess(result)) return { bytes: Buffer.alloc(0), text: "", details: {} };
  return {
    bytes: await readBytes(join(cwd, "sample.txt")),
    text: result.toolResult.content[0]!.text,
    details: result.toolResult.details,
  };
}

function expectBytes(actual: Buffer, expected: string): void {
  const want = Buffer.from(expected, "utf-8");
  expect(
    actual.equals(want),
    `bytes must be ${JSON.stringify(expected)}, saw ${JSON.stringify(actual.toString("utf-8"))}`,
  ).toBe(true);
}

function eolLine(target: string, source: string, changed: number): string {
  return (
    `[MODEL] [W_EOL_REWRITTEN] EOL normalized to ${target} (${source}): ` +
    `${changed} terminators changed. Undo restores normalized content.`
  );
}

describe("edit write — AUTO follows the file's dominant terminator", () => {
  it("CRLF-majority mix normalizes to CRLF and reports the one LF it changed", async () => {
    const raw = "a\r\nb\r\nc\n";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd }) => {
      const { bytes, text } = await serveAndEdit(cwd, raw, [{ index: 1, text: "B" }]);
      expectBytes(bytes, "a\r\nB\r\nc\r\n");
      expect(text).toContain(eolLine("CRLF", "file", 1));
    });
  });

  it("LF-majority mix normalizes to LF and reports the one CRLF it changed", async () => {
    const raw = "a\nb\nc\r\n";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd }) => {
      const { bytes, text } = await serveAndEdit(cwd, raw, [{ index: 1, text: "B" }]);
      expectBytes(bytes, "a\nB\nc\n");
      expect(text).toContain(eolLine("LF", "file", 1));
    });
  });

  it("CR-majority mix normalizes to CR and reports the one CRLF it changed", async () => {
    const raw = "a\rb\rc\r\n";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd }) => {
      const { bytes, text } = await serveAndEdit(cwd, raw, [{ index: 1, text: "B" }]);
      expectBytes(bytes, "a\rB\rc\r");
      expect(text).toContain(eolLine("CR", "file", 1));
    });
  });

  it("a uniform file keeps its own terminator and stays silent", async () => {
    for (const [raw, expected] of [
      ["a\r\nb\r\n", "a\r\nB\r\n"],
      ["a\nb\n", "a\nB\n"],
      ["a\rb\r", "a\rB\r"],
    ] as const) {
      await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd }) => {
        const { bytes, text } = await serveAndEdit(cwd, raw, [{ index: 1, text: "B" }]);
        expectBytes(bytes, expected);
        expect(text).not.toContain("W_EOL_REWRITTEN");
      });
    }
  });
});

describe("edit write — a forced setting wins over the file's own terminators", () => {
  it("a project CRLF over an LF file rewrites all three terminators and names the rung", async () => {
    const raw = "a\nb\nc\n";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd }) => {
      await seedProjectEol(cwd, "CRLF");
      const { bytes, text } = await serveAndEdit(cwd, raw, [{ index: 1, text: "B" }]);
      expectBytes(bytes, "a\r\nB\r\nc\r\n");
      expect(text).toContain(eolLine("CRLF", "project", 3));
    });
  });

  it("a project LF over an LF file changes no terminator, so it reports nothing", async () => {
    const raw = "a\nb\n";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd }) => {
      await seedProjectEol(cwd, "LF");
      const { bytes, text } = await serveAndEdit(cwd, raw, [{ index: 1, text: "B" }]);
      expectBytes(bytes, "a\nB\n");
      expect(text).not.toContain("W_EOL_REWRITTEN");
    });
  });
});

describe("edit write — the report describes the pre-image, once per call", () => {
  it("a batch of two edits reports one warning carrying the pre-image count", async () => {
    const raw = "a\r\nb\r\nc\n";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd }) => {
      const { bytes, text } = await serveAndEdit(cwd, raw, [
        { index: 0, text: "A" },
        { index: 1, text: "B" },
      ]);
      expectBytes(bytes, "A\r\nB\r\nc\r\n");
      expect(text.split("W_EOL_REWRITTEN")).toHaveLength(2);
      expect(text).toContain(eolLine("CRLF", "file", 1));
    });
  });

  it("a preview writes nothing and reports nothing", async () => {
    const raw = "a\r\nb\r\nc\n";
    await withTempBytes("sample.txt", Buffer.from(raw, "utf-8"), async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const anchors = await lineHashes(toLF(raw), join(cwd, "sample.txt"));
      const result = await preview(
        admit({
          file: "sample.txt",
          edits: [{ anchor_from: anchors[1]!, anchor_to: anchors[1]!, text: "B" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      expectBytes(await readBytes(path), raw);
      expect(result.toolResult.content[0]!.text).not.toContain("W_EOL_REWRITTEN");
      expect(JSON.stringify(result.toolResult.details)).not.toContain("W_EOL_REWRITTEN");
    });
  });
});

describe("edit write — a cut transaction discloses no EOL rewrite (ADR-0019 §5)", () => {
  it("a foreign cut into a mixed-EOL target reports no EOL rewrite", async () => {
    const target = "a\r\nb\nc\r\n";
    const source = "x\ny\nz\n";
    await withTempDir("eol-cut-", async (cwd) => {
      await writeFile(join(cwd, "target.txt"), target, "utf-8");
      await writeFile(join(cwd, "source.txt"), source, "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "target.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "source.txt" }, undefined, undefined, ctx);
      const ht = await lineHashes(toLF(target), join(cwd, "target.txt"));
      const hs = await lineHashes(toLF(source), join(cwd, "source.txt"));
      const result: MutationResult = await execute(
        admit({
          file: "target.txt",
          edits: [
            {
              anchor_from: ht[1]!,
              anchor_to: ht[1]!,
              text_ref: {
                anchor_from: hs[0]!,
                anchor_to: hs[1]!,
                file: "source.txt",
                mode: "cut",
              },
            },
          ],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result), "the foreign cut must apply").toBe(true);
      if (!isMutationSuccess(result)) return;
      // Ref: docs/adr/0019-eol-rewrite-normalized-undo-and-the-eol-config.md
      expectBytes(await readBytes(join(cwd, "target.txt")), "a\r\nx\r\ny\r\nc\r\n");
      expectBytes(await readBytes(join(cwd, "source.txt")), "z\n");
      const text = result.toolResult.content.map((c) => c.text).join("\n");
      expect(text).not.toContain("W_EOL_REWRITTEN");
      expect(JSON.stringify(result.toolResult.details)).not.toContain("W_EOL_REWRITTEN");
    });
  });
});
