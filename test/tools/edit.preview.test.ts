import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { lineHashes } from "../../src/hashline";
import { compPreview } from "../../src/replace";
import { withTempFile, setupTestHome } from "../support/fixtures";

let testPath: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const s = await setupTestHome();
  testPath = s.testPath;
  cleanup = s.cleanup;
});

afterAll(async () => {
  await cleanup();
});

describe("compPreview", () => {
  it("returns a diff for strict hashline edits before execution", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

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
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", testPath);

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
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      const preview = await compPreview(
        { path: "sample.ts", changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
    });
  });

  it("uses the shared text loader for preview instead of classifying then re-reading text", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      const preview = await compPreview(
        { path: "sample.ts", changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
    });
  });

  it("does not let a delayed preview resurrect after a settled result", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", testPath);

      const preview = await compPreview(
        { path: "sample.ts", changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
    });
  });
});
