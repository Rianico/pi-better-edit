import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { compPreview } from "../../src/replace";
import { loadHashStore, getSnapshot } from "../../src/hash-store";
import { withTempFile } from "../support/fixtures";

describe("compPreview no-persist guarantee", () => {

  it("does not persist hypothetical result to hash store", async () => {
    const content = "a\nb\nc\nb\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (await import("../../src/fs-write")).resolveTarget(
        await (await import("../../src/paths")).toCwd("sample.txt", cwd)
      );

      const hashes = await lineHashes(content, absolutePath);

      const storeBefore = await loadHashStore();
      const beforeHashes = getSnapshot(storeBefore, absolutePath, content);
      expect(beforeHashes).toBeDefined();
      expect(beforeHashes).toEqual(hashes);
      const bHash = hashes[1]!;
      const cHash = hashes[2]!;

      const preview = await compPreview(
        {
          path: "sample.txt",
          hash_bounds: [bHash, cHash],
          new_content: "B",
        },
        cwd,
      );
      expect(preview).toHaveProperty("diff");

      const storeAfter = await loadHashStore();
      const afterHashes = getSnapshot(storeAfter, absolutePath, content);
      expect(afterHashes).toBeDefined();
      expect(afterHashes).toEqual(hashes);
    });
  });

  it("does not leave hypothetical snapshot behind after abandoned preview", async () => {
    const content = "a\nb\nc\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (await import("../../src/fs-write")).resolveTarget(
        await (await import("../../src/paths")).toCwd("sample.txt", cwd)
      );

      const hashes = await lineHashes(content, absolutePath);

      await compPreview(
        {
          path: "sample.txt",
          hash_bounds: [hashes[1]!, hashes[2]!],
          new_content: "X\nY",
        },
        cwd,
      );

      const store = await loadHashStore();
      expect(getSnapshot(store, absolutePath, content)).toEqual(hashes);
    });
  });

  it("does not invalidate anchors that were valid before preview", async () => {
    const content = "a\nb\nc\nb\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (await import("../../src/fs-write")).resolveTarget(
        await (await import("../../src/paths")).toCwd("sample.txt", cwd)
      );

      const hashes = await lineHashes(content, absolutePath);

      const preview = await compPreview(
        {
          path: "sample.txt",
          hash_bounds: [hashes[0]!, hashes[2]!],
          new_content: "x",
        },
        cwd,
      );
      expect(preview).toHaveProperty("diff");

      const freshHashes = await lineHashes(content, absolutePath);
      expect(freshHashes).toEqual(hashes);
    });
  });

});
