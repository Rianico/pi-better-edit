import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultHashIdentity } from "../../src/hashline/index.js";
import { fmtReadPreview } from "../../src/read";
import { setupReadTest, useTestHome, withTempFile } from "../support/fixtures";

// WHY: the structural proof that verbatim allocates no anchors: the preview's lazy hash entry point
// WHY: is replaced with a thrower, so a verbatim read that completes could not have hashed a row.
// WHY: `hashesFor` is a prototype method reached directly on the singleton below, so a spy on the
// WHY: instance covers the loader half while this mock covers the preview half.
vi.mock("../../src/hashline/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hashline/index.js")>();
  return {
    ...actual,
    lineHashes: () => {
      throw new Error("lineHashes sentinel: verbatim must not hash");
    },
  };
});

const home = useTestHome();

describe("verbatim hashless seam", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the lineHashes sentinel live (served preview hashes lazily)", async () => {
    await expect(fmtReadPreview("a\n", {}, undefined, home.testPath)).rejects.toThrow(
      "lineHashes sentinel",
    );
  });

  it("reads a file in verbatim without hashing a single line", async () => {
    await withTempFile("plain.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const spy = vi.spyOn(defaultHashIdentity, "hashesFor");
      const result = await readTool.execute(
        "v1",
        { file: "plain.txt", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0]!.text).toBe("alpha\nbeta");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("still hashes through readNormFile on the served path", async () => {
    await withTempFile("plain.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const spy = vi.spyOn(defaultHashIdentity, "hashesFor");
      const result = await readTool.execute("s1", { file: "plain.txt" }, undefined, undefined, ctx);
      expect(result.content[0]!.text).toContain("│alpha");
      expect(spy).toHaveBeenCalled();
    });
  });
});
