import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultHashIdentity } from "../../src/hashline/index.js";
import { fmtReadPreview } from "../../src/read";
import { hashStorePath } from "../../src/hash-store.js";
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

  it("still assigns anchors through the walk seam on the served path", async () => {
    await withTempFile("plain.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const spy = vi.spyOn(defaultHashIdentity, "anchorsForWalk");
      const result = await readTool.execute("s1", { file: "plain.txt" }, undefined, undefined, ctx);
      expect(result.content[0]!.text).toContain("│alpha");
      expect(spy).toHaveBeenCalled();
    });
  });
  it("keeps verbatim hashless with no precomputed hashes (render is the authority)", async () => {
    const result = await fmtReadPreview(
      "alpha\nbeta\n",
      { render: "verbatim" },
      undefined,
      home.testPath,
    );
    expect(result.text).toBe("alpha\nbeta");
    expect(result.served).toEqual([]);
  });

  it("keeps verbatim hashless with no precomputed hashes in windows mode", async () => {
    const result = await fmtReadPreview(
      "alpha\nbeta\ngamma\n",
      { render: "verbatim", windows: [{ offset: 2, limit: 1 }] },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("beta");
    expect(result.text).not.toMatch(/^[A-Za-z0-9]{3}│/m);
    expect(result.served).toEqual([]);
  });

  it("opens no anchor store for a verbatim read, and does for a served read", async () => {
    await withTempFile("plain.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const storePath = hashStorePath();

      await readTool.execute(
        "v2",
        { file: "plain.txt", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      expect(existsSync(storePath)).toBe(false);

      await readTool.execute("s2", { file: "plain.txt" }, undefined, undefined, ctx);
      expect(existsSync(storePath)).toBe(true);
    });
  });
});
