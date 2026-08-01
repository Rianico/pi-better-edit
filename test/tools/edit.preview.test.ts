import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { compPreview } from "../../src/replace";
import { withTempFile, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("compPreview", () => {
  it("returns a diff for strict hashline edits before execution", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
      expect((preview as any).diff).toContain("BBB");
    });
  });

  it("returns a diff for a hash-anchored replace before execution", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BETA"] }] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
      expect((preview as any).diff).toContain("BETA");
    });
  });

  it("still computes a preview diff for read-only files", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
    });
  });

  it("uses the shared text loader for preview instead of classifying then re-reading text", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
    });
  });

  it("does not let a delayed preview resurrect after a settled result", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
    });
  });

  it("flat-mode preview rejects a bulk changes array like the flat schema does", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
      const preview = await compPreview(
        { path: "sample.ts", changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }] },
        cwd,
        true,
      );
      expect(preview).toHaveProperty("error");
      expect((preview as { error: string }).error).toMatch(/changes/i);
    });
  });

  it("flat-mode preview still accepts flat-format requests", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
      const preview = await compPreview(
        { path: "sample.ts", hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] },
        cwd,
        true,
      );
      expect(preview).toHaveProperty("diff");
      expect((preview as { diff: string }).diff).toContain("BBB");
    });
  });
});
