import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DomainError, ERROR_REGISTRY, withPayloadSubject } from "../../src/domain-errors.js";
import { toCwd } from "../../src/paths.js";
import { readBytes, resolveTarget, writeAtomic } from "../../src/fs-write.js";
import { canonicalAnchorPath } from "../../src/hashline/hash-identity.js";
import { genDiff } from "../../src/edit-diff.js";
import { computeDrift } from "../../src/drift.js";
import { initHasher, lineHashes } from "../../src/hashline/index.js";
import { execute, isMutationFailure } from "../../src/mutation-engine/index.js";
import { withTempDir, setupIntegrationTest, TEST_SESSION_ID } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

describe("E_INTERNAL_INVARIANT rendering (#93)", () => {
  it("declares no remedy in the registry", () => {
    expect(ERROR_REGISTRY.E_INTERNAL_INVARIANT.remedy).toBeUndefined();
  });

  it("renders without the model-facing payload remedy", () => {
    const rendered = new DomainError("E_INTERNAL_INVARIANT", {
      message: "Path contains null byte",
    }).message;
    expect(rendered).toBe(
      "[MODEL] [E_INTERNAL_INVARIANT] An internal invariant failed: Path contains null byte",
    );
    expect(rendered).not.toContain("Fix the payload fields and retry.");
  });

  it("keeps the subject arm for a producer that knows its tool", () => {
    const rendered = new DomainError("E_INTERNAL_INVARIANT", {
      message: "Path contains null byte",
      subject: "read",
    }).message;
    expect(rendered).toBe(
      "[MODEL] [E_INTERNAL_INVARIANT] The read invariant failed: Path contains null byte",
    );
    expect(rendered).not.toContain("Fix the payload fields and retry.");
  });

  it("re-wraps with the subject like E_BAD_PAYLOAD", () => {
    const error = new DomainError("E_INTERNAL_INVARIANT", {
      message: "Path contains null byte",
    });
    const stamped = withPayloadSubject(error, "read") as DomainError<"E_INTERNAL_INVARIANT">;
    expect(stamped).not.toBe(error);
    expect(stamped.payload).toEqual({ message: "Path contains null byte", subject: "read" });
    expect(stamped.message).toBe(
      "[MODEL] [E_INTERNAL_INVARIANT] The read invariant failed: Path contains null byte",
    );
  });
});

describe("E_INTERNAL_INVARIANT guards (#93)", () => {
  it("toCwd refuses a null byte", () => {
    expect(() => toCwd("a\0b", "/x")).toThrow(/\[E_INTERNAL_INVARIANT\]/);
    expect(() => toCwd("a\0b", "/x")).toThrow(/null byte/);
  });

  it("fs-write refuses a null byte before touching the filesystem", async () => {
    await expect(resolveTarget("a\0b")).rejects.toThrow(/\[E_INTERNAL_INVARIANT\]/);
    await expect(readBytes("a\0b")).rejects.toThrow(/\[E_INTERNAL_INVARIANT\]/);
    await expect(writeAtomic("a\0b", "x")).rejects.toThrow(/\[E_INTERNAL_INVARIANT\]/);
  });

  it("canonicalAnchorPath requires an absolute path", () => {
    expect(() => canonicalAnchorPath("relative/path")).toThrow(/\[E_INTERNAL_INVARIANT\]/);
  });

  it("genDiff refuses a call with neither hashes nor a path", () => {
    expect(() => genDiff("a\n", "b\n")).toThrow(/\[E_INTERNAL_INVARIANT\]/);
  });

  it("computeDrift refuses a call with neither range nor intervals", () => {
    expect(() =>
      computeDrift({ served: [], resultHashes: [], resultLines: [], reported: new Set<string>() }),
    ).toThrow(/\[E_INTERNAL_INVARIANT\]/);
  });

  it("refuses a foreign text_ref whose span mode disagrees with the payload mode", async () => {
    await withTempDir("spanref-foreign-disagree-", async (cwd) => {
      await writeFile(join(cwd, "sample.txt"), "a\nb\nc\nd\ne\n", "utf-8");
      await writeFile(join(cwd, "other.txt"), "x\ny\nz\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { file: "other.txt" }, undefined, undefined, ctx);
      const h = await lineHashes("a\nb\nc\nd\ne\n", join(cwd, "sample.txt"));
      const s = await lineHashes("x\ny\nz\n", join(cwd, "other.txt"));
      const result = await execute(
        {
          file: "sample.txt",
          edits: [
            {
              target: { anchor_from: h[0]!, anchor_to: h[0]! },
              at: "in-place",
              payload: {
                kind: "reference",
                span: {
                  anchor_from: s[0]!,
                  anchor_to: s[1]!,
                  file: "other.txt",
                  mode: "cut",
                },
                mode: "copy",
              },
            },
          ],
        },
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationFailure(result)).toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_INTERNAL_INVARIANT");
      await expect(readFile(join(cwd, "sample.txt"), "utf-8")).resolves.toBe("a\nb\nc\nd\ne\n");
      await expect(readFile(join(cwd, "other.txt"), "utf-8")).resolves.toBe("x\ny\nz\n");
    });
  });
});
