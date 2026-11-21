import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

/**
 * Source of truth for the outer edges of the pair: `canon(line)` is TRIM-ONLY (CANON_VERSION 4,
 * issue #292). It strips one leading and one trailing run of the frozen 28-code-point whitespace
 * class and nothing else, so a foreign writer that re-indents a line still canon-equals the served
 * line and the lease survives, while a foreign writer that rewrites whitespace INSIDE a literal
 * changes the canon string, breaks pairing, retires the lease and the edit rejects fail-closed.
 *
 * `src/hashline/hash-identity.ts` owns the class and the trim; these tests own the contract.
 */
describe("issue #292 — intra-line whitespace is significant; edges stay canon-equal", () => {
  it("external re-indent keeps the lease: the edit succeeds (formatter tolerance)", async () => {
    await withTempFile("sample.ts", '\tString s = "a b";\n', async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const servedRow = getText(served)
        .split("\n")
        .find((line) => line.includes("String s ="));
      expect(servedRow).toBeDefined();
      const anchor = extractHash(servedRow!);
      expect(anchor).toMatch(/^[A-Za-z0-9]{4}$/);

      // Ref: docs/adr/0010-the-line-canon-stays-a-pure-function-of-one-line.md — a formatter re-indents the line; every byte inside the literal is untouched.
      await writeFile(path, '    String s = "a b";\n', "utf-8");

      let outcome: unknown;
      try {
        outcome = await editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [{ anchor_from: anchor, anchor_to: anchor, text: '    String s = "c d";' }],
          },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        outcome = error;
      }
      const rejection = outcome instanceof Error ? outcome.message : "";
      expect(rejection).toBe("");
      expect(getText(outcome as { content: Array<{ text?: string }> })).toContain(
        "Successfully edited",
      );
      expect(await readFile(path, "utf-8")).toBe('    String s = "c d";\n');
    });
  });

  it("external intra-literal rewrite rejects fail-closed and leaves the bytes untouched", async () => {
    await withTempFile("sample.ts", '\tString s = "a b";\n', async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const servedRow = getText(served)
        .split("\n")
        .find((line) => line.includes("String s ="));
      expect(servedRow).toBeDefined();
      const anchor = extractHash(servedRow!);

      // Ref: docs/adr/0010-the-line-canon-stays-a-pure-function-of-one-line.md — only the literal's interior space goes away: `"a b"` -> `"ab"`.
      await writeFile(path, '\tString s = "ab";\n', "utf-8");

      const rejected = (await editTool
        .execute(
          "e1",
          {
            file: "sample.ts",
            edits: [{ anchor_from: anchor, anchor_to: anchor, text: '\tString s = "c d";' }],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;

      expect(rejected.message).toMatch(/\[MODEL\] \[E_(TARGET_LOST|STALE_RANGE)\]/);
      expect(rejected.message).not.toContain("removed 0 line(s)");
      expect(rejected.message).not.toContain("Current range:");
      expect(await readFile(path, "utf-8")).toBe('\tString s = "ab";\n');
    });
  });

  it("external trailing-whitespace strip keeps the lease: the edit succeeds", async () => {
    await withTempFile("sample.ts", "let x = 1;   \n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const served = await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const servedRow = getText(served)
        .split("\n")
        .find((line) => line.includes("let x = 1;"));
      expect(servedRow).toBeDefined();
      const anchor = extractHash(servedRow!);

      await writeFile(path, "let x = 1;\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: anchor, anchor_to: anchor, text: "let x = 2;" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("let x = 2;\n");
    });
  });
});
