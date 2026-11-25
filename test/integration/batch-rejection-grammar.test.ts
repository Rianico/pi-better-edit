import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain-errors.js";
import { batchAbort } from "../../src/edit-response.js";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures.js";

const VERDICT = /^\[MODEL\] Batch rejected: \d+ of \d+ edits? failed; nothing was written\.$/m;

interface FixtureTool {
  execute: (
    id: string,
    args: unknown,
    ...rest: unknown[]
  ) => Promise<{ content: Array<{ text?: string }> }>;
}

function unknownAnchor(path = "s.txt"): DomainError<"E_UNKNOWN_ANCHOR"> {
  return new DomainError("E_UNKNOWN_ANCHOR", { path, anchors: ["ZZZZ"] });
}

function staleRange(): DomainError<"E_STALE_RANGE"> {
  return new DomainError("E_STALE_RANGE", {
    headline: "line 2 in s.txt no longer resolves to the line identity it was served with.",
    servedRows: [
      { position: 0, hash: "aB3x" },
      { position: 1, hash: "cD4y" },
    ],
    servedBlock: "aB3x│a\ncD4y│b",
    cause: "served-range staleness",
  });
}

async function servedHashes(ctx: unknown, readTool: FixtureTool, file: string): Promise<string[]> {
  const result = await readTool.execute("r1", { file }, undefined, undefined, ctx);
  return getText(result)
    .split("\n")
    .filter((line) => /^[A-Za-z0-9]{4}│/.test(line))
    .map(extractHash);
}
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}
describe("batch rejection grammar (spec #329 §4, issue #323)", () => {
  it("renders the verdict line first with K of N and no code token", () => {
    const rejection = batchAbort({
      failures: [
        { error: unknownAnchor(), index: 0 },
        { error: unknownAnchor(), index: 2 },
      ],
      total: 3,
      path: "s.txt",
    });
    const first = rejection.message.split("\n")[0] ?? "";
    expect(first).toMatch(/^\[MODEL\] Batch rejected: 2 of 3 edits failed; nothing was written\.$/);
    expect(first).not.toMatch(/\[E_[A-Z_]+\]/);
  });

  it("uses the singular edit when the call holds one item", () => {
    const rejection = batchAbort({
      failures: [{ error: unknownAnchor(), index: 0 }],
      total: 1,
      path: "s.txt",
    });
    const first = rejection.message.split("\n")[0] ?? "";
    expect(first).toBe("[MODEL] Batch rejected: 1 of 1 edit failed; nothing was written.");
  });

  it("carries the first item's code and names each bullet's own code", () => {
    const malformed = new DomainError("E_MALFORMED_ANCHOR", {
      rawAnchor: "ZZZZ│x",
      reason: 'anchor carries a "HASH│" prefix ("ZZZZ│x")',
    });
    const rejection = batchAbort({
      failures: [
        { error: unknownAnchor(), index: 0 },
        { error: malformed, index: 1 },
      ],
      total: 2,
      path: "s.txt",
    }) as Error & { code?: unknown };
    expect(rejection.code).toBe("E_UNKNOWN_ANCHOR");
    expect(rejection.message).toContain("- edit[0] (s.txt) [E_UNKNOWN_ANCHOR]:");
    expect(rejection.message).toContain("- edit[1] (s.txt) [E_MALFORMED_ANCHOR]:");
  });

  it("keeps every continuation line indented, so only verdict and bullets start at column 0", () => {
    const rejection = batchAbort({
      failures: [{ error: staleRange(), index: 1 }],
      total: 2,
      path: "s.txt",
    });
    const lines = rejection.message.split("\n");
    expect(lines[0] ?? "").toMatch(VERDICT);
    for (const line of lines.slice(1)) {
      const isBullet = line.startsWith("- edit[");
      const isIndented = line.startsWith("  ");
      expect(isBullet || isIndented, line).toBe(true);
    }
  });

  it("unions served rows across failures and joins blocks in item order", () => {
    const rejection = batchAbort({
      failures: [
        { error: staleRange(), index: 0 },
        { error: unknownAnchor(), index: 1 },
      ],
      total: 2,
      path: "s.txt",
    }) as Error & { servedRows?: { position: number; hash: string }[]; servedBlock?: string };
    expect(rejection.servedRows).toHaveLength(2);
    expect(rejection.servedBlock).toContain("aB3x│a\ncD4y│b");
    const rowLines = rejection.message
      .split("\n")
      .filter((line) => /^\s*[A-Za-z0-9]{4}│/.test(line))
      .map((line) => line.trimStart());
    expect(rowLines).toEqual(["aB3x│a", "cD4y│b"]);
  });

  it("carries cause only when every failure agrees", () => {
    const agreeing = batchAbort({
      failures: [
        { error: staleRange(), index: 0 },
        { error: staleRange(), index: 1 },
      ],
      total: 2,
      path: "s.txt",
    }) as Error & { cause?: unknown };
    expect(agreeing.cause).toBe("served-range staleness");
    const mixed = batchAbort({
      failures: [
        { error: staleRange(), index: 0 },
        { error: unknownAnchor(), index: 1 },
      ],
      total: 2,
      path: "s.txt",
    }) as Error & { cause?: unknown; details?: unknown };
    expect(mixed.cause).toBeUndefined();
    expect(mixed.details).toBeUndefined();
  });

  it("renders the verdict once in the failing item's audience, MODEL for untyped errors", () => {
    const typed = batchAbort({
      failures: [{ error: unknownAnchor(), index: 0 }],
      total: 2,
      path: "s.txt",
    });
    expect(typed.message.match(/\[MODEL\]/g)).toHaveLength(1);
    const untyped = batchAbort({
      failures: [{ error: new Error("boom"), index: 0 }],
      total: 2,
      path: "s.txt",
    });
    expect(untyped.message.split("\n")[0] ?? "").toMatch(/^\[MODEL\] Batch rejected: /);
    expect(untyped.message).toContain("- edit[0] (s.txt) [E_UNKNOWN]: boom");
  });

  it("keeps BATCH_ATOMICITY_TRAILER and the shouty atomicity sentence out of src/", () => {
    const files = walkTsFiles(fileURLToPath(new URL("../../src/", import.meta.url)));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      expect(source, file).not.toContain("BATCH_ATOMICITY_TRAILER");
      expect(source, file).not.toContain("NOTHING was written");
    }
  });

  it("counts N from the call's item total on the parse arm", async () => {
    await withTempFile("parse-total.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "parse-total.txt");
      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "parse-total.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "AAA" },
              { anchor_from: `${hashes[1]}│bbb`, anchor_to: hashes[1]!, text: "BBB" },
              { anchor_from: hashes[2]!, anchor_to: hashes[2]!, text: "CCC" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;
      expect(rejection.message.split("\n")[0] ?? "").toBe(
        "[MODEL] Batch rejected: 1 of 3 edits failed; nothing was written.",
      );
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("counts N from the call's item total on the apply arm", async () => {
    await withTempFile("apply-total.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "apply-total.txt");
      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "apply-total.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "AAA" },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: `${hashes[1]}│bbb` },
              { anchor_from: hashes[2]!, anchor_to: hashes[2]!, text: "CCC" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error & { code?: unknown };
      expect(rejection.code).toBe("E_SUSPICIOUS_TEXT");
      expect(rejection.message.split("\n")[0] ?? "").toBe(
        "[MODEL] Batch rejected: 1 of 3 edits failed; nothing was written.",
      );
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("counts N from the call's item total on the validation arm with a leading noop insert", async () => {
    await withTempFile("validation-noop.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "validation-noop.txt");
      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "validation-noop.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "", at: "after" },
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "AAA" },
              { anchor_from: "ZZZZ", anchor_to: "ZZZZ", text: "CCC" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;
      expect(rejection.message.split("\n")[0] ?? "").toBe(
        "[MODEL] Batch rejected: 1 of 3 edits failed; nothing was written.",
      );
      expect(rejection.message).toContain("- edit[2] (validation-noop.txt)");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("renders the overlap as the later item's failure with the folded voice and E_BATCH_ABORT code", async () => {
    await withTempFile("fold.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "fold.txt");
      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "fold.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[1]!, text: "X" },
              { anchor_from: hashes[1]!, anchor_to: hashes[2]!, text: "Y" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error & {
        code?: unknown;
        servedRows?: { position: number; hash: string }[];
      };
      expect(rejection.code).toBe("E_BATCH_ABORT");
      expect(rejection.message).toBe(
        "[MODEL] Batch rejected: 1 of 2 edits failed; nothing was written.\n" +
          `- edit[1] (fold.txt) [E_BATCH_ABORT]: its span (lines 2-3) overlaps edit[0] (lines 1-2) at lines 2-2.\n` +
          "  Current range:\n" +
          `  ${hashes[1]}│beta\n` +
          `  ${hashes[2]}│gamma\n` +
          "  Options: merge the overlapping items into one span; or split them across separate calls.",
      );
      const rowLines = rejection.message
        .split("\n")
        .filter((line) => /^\s*[A-Za-z0-9]{4}│/.test(line));
      expect(rowLines).toHaveLength(rejection.servedRows?.length ?? -1);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("counts N from the call's item total on the overlap arm with a leading noop insert", async () => {
    await withTempFile("overlap-noop.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "overlap-noop.txt");
      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "overlap-noop.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "", at: "after" },
              { anchor_from: hashes[0]!, anchor_to: hashes[1]!, text: "X" },
              { anchor_from: hashes[1]!, anchor_to: hashes[2]!, text: "Y" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error & { code?: unknown };
      expect(rejection.code).toBe("E_BATCH_ABORT");
      expect(rejection.message.split("\n")[0] ?? "").toBe(
        "[MODEL] Batch rejected: 1 of 3 edits failed; nothing was written.",
      );
      expect(rejection.message).toContain("- edit[2] (overlap-noop.txt) [E_BATCH_ABORT]:");
      expect(rejection.message).toContain("overlaps edit[1]");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("renders a row-carrying failure's rows exactly once", async () => {
    await withTempFile("rows-once.txt", "l1\nl2\nl3\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "rows-once.txt");
      await writeFile(path, "l1\nL2X\nl3\n", "utf-8");
      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "rows-once.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "L1" },
              { anchor_from: hashes[1]!, anchor_to: hashes[2]!, text: "X" },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error & {
        servedRows?: { position: number; hash: string }[];
      };
      const rowLines = rejection.message
        .split("\n")
        .filter((line) => /^\s*[A-Za-z0-9]{4}│/.test(line));
      expect(rowLines.length).toBeGreaterThan(0);
      expect(rowLines).toHaveLength(rejection.servedRows?.length ?? -1);
    });
  });

  it("keeps a 1-item call on the bare error with no batch envelope", async () => {
    await withTempFile("bare.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "bare.txt");
      await writeFile(`${cwd}/bare.txt`, "aaa\nBBB\nccc\n", "utf-8");
      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "bare.txt",
            edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "x" }],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;
      expect(rejection.message).toMatch(/^\[MODEL\] \[E_[A-Z_]+\]/);
      expect(rejection.message).not.toContain("Batch rejected:");
    });
  });
});
