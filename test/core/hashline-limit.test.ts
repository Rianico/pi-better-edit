import { describe, expect, it } from "vitest";
import { _lineHashesPure, lineHashes, HASH_SPACE, MAX_HASH_LINES } from "../../src/hashline";
import { useTestHome, withTempFile, setupReadTest } from "../support/fixtures";

const home = useTestHome();

describe("hashline limits", () => {
  it("derives the hash space from the alphabet and hash length", () => {
    expect(HASH_SPACE).toBe(62 ** 3);
    expect(MAX_HASH_LINES).toBe(HASH_SPACE);
  });

  it("hashes exactly MAX_HASH_LINES lines with unique anchors", () => {
    const content = Array.from({ length: MAX_HASH_LINES }, (_, i) => `line ${i}`).join("\n");
    const hashes = _lineHashesPure(content);
    expect(hashes).toHaveLength(MAX_HASH_LINES);
    expect(new Set(hashes).size).toBe(MAX_HASH_LINES);
  }, 300_000);

  it("throws a clear E_LARGE_FILE error above the limit", () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n");
    expect(() => _lineHashesPure(content)).toThrow("E_LARGE_FILE");
  }, 300_000);

  it("preserves unique hashes at the boundary through the store path", async () => {
    const content = Array.from({ length: MAX_HASH_LINES }, (_, i) => `x${i}`).join("\n");
    const hashes = await lineHashes(content, home.testPath);
    expect(hashes).toHaveLength(MAX_HASH_LINES);
    expect(new Set(hashes).size).toBe(MAX_HASH_LINES);
  }, 300_000);
});

describe("read tool line cap", () => {
  it("rejects oversized files with E_LARGE_FILE before hashing", async () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n");
    await withTempFile("huge.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      await expect(
        readTool.execute("r1", { file: "huge.ts" }, undefined, undefined, ctx),
      ).rejects.toThrow("E_LARGE_FILE");
    });
  });

  it("refuses a CR-only file above the cap with the line cap's refusal, not the anchor space's", async () => {
    // WHY: `toLF` rewrites a lone `\r` into a line break, so the count that decides this cap has to be
    // WHY: the NORMALIZED text's. Counting the raw bytes lets a 238,329-line CR-only file through the
    // WHY: cap and into the anchor space, which then refuses the same read with the same error code and
    // WHY: a different reason — after allocating every anchor it was going to refuse.
    const content = "x\r".repeat(MAX_HASH_LINES + 1);
    await withTempFile("cr-only.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const error = await readTool
        .execute("r1", { file: "cr-only.ts" }, undefined, undefined, ctx)
        .then(
          () => undefined,
          (thrown: unknown) => thrown as Error,
        );
      expect(error?.message).toBe(
        `[MODEL] [E_LARGE_FILE] cr-only.ts has ${MAX_HASH_LINES + 1} lines, exceeding the ${MAX_HASH_LINES}-line edit limit. ` +
          "Hashline editing targets source-sized files; for very large files use write or a non-line-based approach.",
      );
    });
  }, 300_000);
  it("reads a file at the limit without hashing errors", async () => {
    const content = Array.from({ length: MAX_HASH_LINES }, (_, i) => `x${i}`).join("\n");
    await withTempFile("big.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("r1", { file: "big.ts" }, undefined, undefined, ctx);
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("│x0");
      expect(text).toContain("[Showing lines 1-");
    });
  }, 300_000);

  it("verbatim pages a file above the anchor-space cap; served still refuses it (one seam)", async () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n");
    await withTempFile("huge-verbatim.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const verbatim = await readTool.execute(
        "v1",
        { file: "huge-verbatim.ts", mode: "verbatim", limit: 3 },
        undefined,
        undefined,
        ctx,
      );
      const text = verbatim.content?.[0]?.text ?? "";
      expect(text).toBe(
        `x\nx\nx\n\n[Showing lines 1-3 of ${MAX_HASH_LINES + 1}. Use offset=4 to continue.]`,
      );
      expect(verbatim.details?.snapshotId).toBeUndefined();

      await expect(
        readTool.execute("s1", { file: "huge-verbatim.ts" }, undefined, undefined, ctx),
      ).rejects.toThrow(
        new RegExp(`\\[E_LARGE_FILE\\].*exceeding the ${MAX_HASH_LINES}-line edit limit`),
      );
    });
  }, 300_000);
});

describe("read tool row budget", () => {
  it("withholds a 60KB line through the real read path (pi's 50KB budget)", async () => {
    const big = "X".repeat(60_000);
    await withTempFile("wide.txt", `${big}\nsmall\n`, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("r1", { file: "wide.txt" }, undefined, undefined, ctx);
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("│small");
      expect(text).not.toContain("│X");
      expect(text).toContain("exceeds 50.0KB");
    });
  });
});
