import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { compPreview } from "../../src/replace";
import register from "../../index";
import type { RRState } from "../../src/replace-render";
import { makeFakePiRegistry, withTempFile, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("compPreview", () => {
  it("returns a diff for strict hashline edits before execution", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] },
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
        { path: "sample.ts", hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BETA"] },
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
        { path: "sample.ts", hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
    });
  });

  it("uses the shared text loader for preview instead of classifying then re-reading text", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
    });
  });

  it("does not let a delayed preview resurrect after a settled result", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
    });
  });

  it("preview rejects a bulk changes array", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
      const preview = await compPreview(
        { path: "sample.ts", changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }] },
        cwd,
      );
      expect(preview).toHaveProperty("error");
      expect((preview as { error: string }).error).toMatch(/changes/i);
    });
  });

  it("preview still accepts flat-format requests", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
      const preview = await compPreview(
        { path: "sample.ts", hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
      expect((preview as { diff: string }).diff).toContain("BBB");
    });
  });
});

describe("renderCall preview", () => {
  function makeHarness(cwd: string) {
    const theme = {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    };
    const state: RRState = {};
    let notifyInvalidate: (() => void) | undefined;
    const invalidated = new Promise<void>((resolve) => {
      notifyInvalidate = resolve;
    });
    const context = {
      executionStarted: false,
      argsComplete: true,
      expanded: false,
      cwd,
      lastComponent: undefined,
      invalidate: () => notifyInvalidate?.(),
      state,
    };
    return { theme, state, context, invalidated };
  }

  async function awaitPreview(harness: ReturnType<typeof makeHarness>): Promise<void> {
    await Promise.race([
      harness.invalidated,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("renderCall never produced a preview")), 2000),
      ),
    ]);
  }

  it("computes a diff preview for a flat replace request", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const harness = makeHarness(cwd);
      tool.renderCall(
        { path: "sample.ts", hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] },
        harness.theme,
        harness.context,
      );

      await awaitPreview(harness);
      expect(harness.state.preview).toHaveProperty("diff");
      expect((harness.state.preview as { diff: string }).diff).toContain("BBB");
    });
  });

  it("shows a rejection error when the model sends a changes array", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const harness = makeHarness(cwd);
      tool.renderCall(
        { path: "sample.ts", changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }] },
        harness.theme,
        harness.context,
      );

      await awaitPreview(harness);
      expect(harness.state.preview).toHaveProperty("error");
      expect((harness.state.preview as { error: string }).error).toMatch(/changes/);
    });
  });
});
