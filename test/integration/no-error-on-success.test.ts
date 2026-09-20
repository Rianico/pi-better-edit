import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

/**
 * No-error-on-success oracle (spec section 6, item 3: NO ERROR ON
 * SUCCESS, review-ruled form). The predicate is "the call was not
 * refused" — a resolved call — and not `appliedCount > 0`: a
 * noop-with-warnings call applies nothing yet is not an error, so the
 * `W_NOOP` notice and the never-served hint would slip past the count
 * guard. Every resolved call below carries no `[E_*]` token in its
 * content or warnings, and a healed reversal carries
 * `[USER] [W_REVERSED_ANCHORS]`.
 *
 * Falsifiability: `assertNoErrorOnSuccess` fails planted success text
 * holding an `[E_*]` token (see the negative control below).
 */

const ERROR_TOKEN = /\[E_[A-Z0-9_]+\]/;

function assertNoErrorOnSuccess(args: { text: string; warnings?: string[] }): void {
  expect(args.text).not.toMatch(ERROR_TOKEN);
  for (const warning of args.warnings ?? []) {
    expect(warning).not.toMatch(ERROR_TOKEN);
  }
}

async function servedHashes(ctx: unknown, readTool: any, name: string): Promise<string[]> {
  const result = await readTool.execute("r1", { path: name }, undefined, undefined, ctx);
  return getText(result)
    .split("\n")
    .filter((line) => /^[A-Za-z0-9]{3}│/.test(line))
    .map(extractHash);
}

describe("no error on success uses the not-refused predicate (spec 6.3)", () => {
  it("a plain applied call carries no error token", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "sample.ts");
      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "BBB" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("Successfully edited");
      assertNoErrorOnSuccess({ text, warnings: result.details.warnings as string[] | undefined });
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("a healed reversal carries [USER] [W_REVERSED_ANCHORS] and no error token", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "sample.ts");
      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          edits: [{ anchor_from: hashes[2]!, anchor_to: hashes[1]!, replace_with: "X" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("Successfully edited");
      expect(text).toContain("[USER] [W_REVERSED_ANCHORS]");
      expect(text).toContain("were reversed");
      assertNoErrorOnSuccess({ text, warnings: result.details.warnings as string[] | undefined });
      expect(await readFile(path, "utf-8")).toBe("aaa\nX\nddd\n");
    });
  });

  it("a noop-with-warnings resend is not refused and carries no error token", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "sample.ts");
      const payload = {
        path: "sample.ts",
        edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "bbb" }],
      };
      const first = await editTool.execute("e1", payload, undefined, undefined, ctx);
      assertNoErrorOnSuccess({
        text: getText(first),
        warnings: first.details.warnings as string[] | undefined,
      });
      // The second identical resend applies nothing yet warns: the count
      // guard would miss it, the not-refused predicate still holds it.
      const second = await editTool.execute("e2", payload, undefined, undefined, ctx);
      const text = getText(second);
      expect(text).toContain("No changes made");
      expect(text).toContain("[USER] [W_NOOP]");
      assertNoErrorOnSuccess({ text, warnings: second.details.warnings as string[] | undefined });
    });
  });

  it("a never-served hint call is not refused and carries no error token", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "sample.txt");
      expect(hashes).not.toContain("ZZZ");
      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "ZZZ│alpha" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("Successfully edited");
      expect(text).toContain("[MODEL] [W_NEVER_SERVED_SHAPE]");
      assertNoErrorOnSuccess({ text, warnings: result.details.warnings as string[] | undefined });
      expect(await readFile(path, "utf-8")).toContain("ZZZ│alpha");
    });
  });

  it("negative control: success text holding an error token fails the check", () => {
    const planted = "Successfully edited 1 file(s).\n\n[MODEL] [E_STALE_RANGE] lines differ.";
    expect(() => assertNoErrorOnSuccess({ text: planted, warnings: [] })).toThrow();
    expect(planted).toMatch(ERROR_TOKEN);
  });
});
