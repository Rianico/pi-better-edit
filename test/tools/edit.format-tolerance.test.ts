import { describe, expect, it } from "vitest";
import { writeFile, readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures";
import { lineHashes } from "../../src/hashline/hash-identity.js";
import { createSessionHandle, sessionKeyFor } from "../../src/served-session/index.js";

const CLEAN = "function hello() {\n  const x = 1;\n  return x;\n}\n";

const MESSY_REPLACEMENT =
  "}\nfunction   multiply( a:  number,   b:  number )  {\n  return   a  *  b;\n}\n";

const REFORMATTED =
  "\tfunction hello() {\n\t\tconst x = 1;\n\t\treturn x;\n\t}\n\tfunction   multiply( a:  number,   b:  number )  {   \n\treturn   a  *  b;\n\t}\n";

const PRETTIER_REFORMATTED =
  "function hello() {\n  const x = 1;\n  return x;\n}\nfunction multiply(a: number, b: number) {\n  return a * b;\n}\n";

function extractPlusHashes(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^\+([A-Za-z0-9]{4})│/);
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * Issue #292 boundary: the line canon is trim-only, so a formatter run that moves only a line's
 * edge whitespace folds to the same digest and the lease survives. Any interior change — even one a
 * formatter calls cosmetic — is significant: it rotates `canonDigest`, retires the lease, and the
 * next anchored edit must fail closed with the on-disk bytes untouched.
 */
describe("format-tolerance across edits (edge-whitespace reformat succeeds, interior reformat rejects)", () => {
  it("second edit anchored on post-edit diff rows survives an external edge-whitespace reformat", async () => {
    await withTempFile("sample.ts", CLEAN, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);

      const hashes = await lineHashes(CLEAN, path);
      const lastHash = hashes[hashes.length - 1]!;

      const first = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: lastHash, anchor_to: lastHash, text: MESSY_REPLACEMENT }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(first)).toContain("Successfully edited");
      const diff = first.details?.diff as string | undefined;
      expect(diff).toBeDefined();
      const plusHashes = extractPlusHashes(diff!);
      expect(plusHashes.length).toBeGreaterThan(0);
      const anchor = plusHashes[0]!;

      await createSessionHandle(sessionKeyFor(ctx), path).recordDiff(
        first.details?.servedRows as any,
        {
          contentHash: (first.details as { contentHash?: string } | undefined)?.contentHash ?? "",
          resultLineCount: first.details?.resultLineCount,
          firstChangedLine: first.details?.firstChangedLine,
        },
      );

      await writeFile(path, REFORMATTED, "utf-8");

      const second = await editTool.execute(
        "e2",
        {
          file: "sample.ts",
          edits: [{ anchor_from: anchor, anchor_to: anchor, text: "REPLACED" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(second)).toContain("Successfully edited");
      const content = await readFile(path, "utf-8");
      expect(content).toContain("REPLACED");
    });
  });

  it("an external interior reformat retires the lease: the second edit rejects fail-closed", async () => {
    await withTempFile("sample.ts", CLEAN, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);

      const hashes = await lineHashes(CLEAN, path);
      const lastHash = hashes[hashes.length - 1]!;

      const first = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: lastHash, anchor_to: lastHash, text: MESSY_REPLACEMENT }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(first)).toContain("Successfully edited");
      const diff = first.details?.diff as string | undefined;
      expect(diff).toBeDefined();
      // Ref: docs/spec/content-addressed-line-identity-mvcc.md — anchor on the signature row the formatter rewrites: under the #326 anchor-identity projection the first `+` row is the replaced `}` that prettier leaves byte-identical, so that lease legitimately survives.
      const multiplyRow = diff!.match(/^\+([A-Za-z0-9]{4})│.*multiply/m);
      expect(multiplyRow).not.toBeNull();
      const anchor = multiplyRow![1]!;

      await createSessionHandle(sessionKeyFor(ctx), path).recordDiff(
        first.details?.servedRows as any,
        {
          contentHash: (first.details as { contentHash?: string } | undefined)?.contentHash ?? "",
          resultLineCount: first.details?.resultLineCount,
          firstChangedLine: first.details?.firstChangedLine,
        },
      );

      await writeFile(path, PRETTIER_REFORMATTED, "utf-8");

      const rejected = (await editTool
        .execute(
          "e2",
          {
            file: "sample.ts",
            edits: [{ anchor_from: anchor, anchor_to: anchor, text: "REPLACED" }],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;

      expect(rejected).toBeInstanceOf(Error);
      expect(rejected.message).toMatch(/\[MODEL\] \[E_(TARGET_LOST|STALE_RANGE)\]/);
      expect(rejected.message).not.toContain("removed 0 line(s)");
      expect(await readFile(path, "utf-8")).toBe(PRETTIER_REFORMATTED);
    });
  });
});
