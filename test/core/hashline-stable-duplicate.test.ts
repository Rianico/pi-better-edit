import { describe, expect, it } from "vitest";
import { defaultHashIdentity, lineHashes } from "../../src/hashline/hash-identity.js";
import { loadHashStore } from "../../src/hash-store.js";
import { snapshotIOFor } from "../../src/snapshot-store";
import { applyEdit } from "../../src/hashline/apply.js";
import type { HEdit } from "../../src/hashline/resolve.js";
import {
  useTestHome,
  withTempFile,
  setupIntegrationTest,
  getText,
  extractHash,
} from "../support/fixtures";

const home = useTestHome();

describe("stable hashing with duplicate content lines", () => {
  it("removing the first of two identical lines preserves the second line's hash", async () => {
    const content = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    const hashes = await lineHashes(content, home.testPath);

    const firstBraceHash = hashes[2]!;
    const secondBraceHash = hashes[6]!;
    expect(firstBraceHash).not.toBe(secondBraceHash);

    const edit: HEdit = {
      hash_bounds: [{ hash: hashes[0]! }, { hash: firstBraceHash }],
      content_lines: [],
    };

    const result = applyEdit(content, edit, undefined, hashes, { filePath: home.testPath });
    const newContent = result.content;
    expect(newContent).toBe("\nfunction b() {\n  return 2;\n}\n");

    const resultHashes = await lineHashes(newContent, home.testPath, {
      content,
      hashes,
      removedHashes: new Set([hashes[0]!, firstBraceHash]),
    });

    expect(resultHashes[3]).toBe(secondBraceHash);
  });

  it("removing the second of two identical lines preserves the first line's hash", async () => {
    const content = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    const hashes = await lineHashes(content, home.testPath);

    const firstBraceHash = hashes[2]!;
    const secondBraceHash = hashes[6]!;

    const edit: HEdit = {
      hash_bounds: [{ hash: hashes[4]! }, { hash: secondBraceHash }],
      content_lines: [],
    };

    const result = applyEdit(content, edit, undefined, hashes, { filePath: home.testPath });
    const newContent = result.content;
    expect(newContent).toBe("function a() {\n  return 1;\n}\n\n");

    const resultHashes = await lineHashes(newContent, home.testPath, {
      content,
      hashes,
      removedHashes: new Set([hashes[4]!, secondBraceHash]),
    });

    expect(resultHashes[2]).toBe(firstBraceHash);
  });

  it("removing a unique line between two identical lines preserves both brace hashes", async () => {
    const content = "a\n}\nb\n}\nc\n}\nd\n";
    const hashes = await lineHashes(content, home.testPath);

    const brace1 = hashes[1]!;
    const brace2 = hashes[3]!;
    const brace3 = hashes[5]!;
    expect(new Set([brace1, brace2, brace3]).size).toBe(3);

    const edit: HEdit = {
      hash_bounds: [{ hash: hashes[2]! }, { hash: hashes[2]! }],
      content_lines: [],
    };

    const result = applyEdit(content, edit, undefined, hashes, { filePath: home.testPath });
    const newContent = result.content;
    expect(newContent).toBe("a\n}\n}\nc\n}\nd\n");

    const resultHashes = await lineHashes(newContent, home.testPath, {
      content,
      hashes,
      removedHashes: new Set([hashes[2]!]),
    });

    expect(resultHashes[1]).toBe(brace1);
    expect(resultHashes[2]).toBe(brace2);
    expect(resultHashes[4]).toBe(brace3);
  });

  it("end-to-end via tool: removing one of two identical lines preserves the correct hash", async () => {
    const file = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    await withTempFile("sample.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const firstBraceHash = extractHash(lines1.find((l) => l.includes("│}"))!);
      const braceLines = lines1.filter((l) => l.endsWith("│}"));
      expect(braceLines).toHaveLength(2);
      const secondBraceHash = extractHash(braceLines[1]!);
      expect(firstBraceHash).not.toBe(secondBraceHash);

      const line1Hash = extractHash(lines1.find((l) => l.includes("│function a()"))!);
      await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: line1Hash, anchor_to: firstBraceHash, text: "" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const read2 = await readTool.execute("r2", { file: "sample.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const survivingBrace = lines2.find((l) => l.endsWith("│}"))!;
      expect(survivingBrace).toBeTruthy();
      const survivingHash = extractHash(survivingBrace);
      expect(survivingHash).toBe(secondBraceHash);
    });
  });

  it("end-to-end via tool: interior duplicate line (not a boundary) keeps its hash", async () => {
    const file = "a\nb\nc\nb\nd\n";
    await withTempFile("sample.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const bLines = lines1.filter((l) => l.endsWith("│b"));
      expect(bLines).toHaveLength(2);
      const firstBHash = extractHash(bLines[0]!);
      const secondBHash = extractHash(bLines[1]!);
      expect(firstBHash).not.toBe(secondBHash);

      const aHash = extractHash(lines1.find((l) => l.endsWith("│a"))!);
      const cHash = extractHash(lines1.find((l) => l.endsWith("│c"))!);

      await editTool.execute(
        "e1",
        { file: "sample.ts", edits: [{ anchor_from: aHash, anchor_to: cHash, text: "" }] },
        undefined,
        undefined,
        ctx,
      );

      const read2 = await readTool.execute("r2", { file: "sample.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const survivingB = lines2.find((l) => l.endsWith("│b"))!;
      expect(survivingB).toBeTruthy();
      const survivingHash = extractHash(survivingB);
      expect(survivingHash).toBe(secondBHash);
    });
  });

  it("end-to-end via tool: sequential edits with interior duplicates preserves all surviving hashes", async () => {
    const file = "a\nb\nc\nb\nd\ne\nb\nf\n";
    await withTempFile("sample.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const bLines = lines1.filter((l) => l.endsWith("│b"));
      expect(bLines).toHaveLength(3);
      const firstBHash = extractHash(bLines[0]!);
      const secondBHash = extractHash(bLines[1]!);
      const thirdBHash = extractHash(bLines[2]!);
      expect(new Set([firstBHash, secondBHash, thirdBHash]).size).toBe(3);

      const aHash = extractHash(lines1.find((l) => l.endsWith("│a"))!);
      const cHash = extractHash(lines1.find((l) => l.endsWith("│c"))!);
      const dHash = extractHash(lines1.find((l) => l.endsWith("│d"))!);
      const eHash = extractHash(lines1.find((l) => l.endsWith("│e"))!);

      await editTool.execute(
        "e1",
        { file: "sample.ts", edits: [{ anchor_from: aHash, anchor_to: cHash, text: "" }] },
        undefined,
        undefined,
        ctx,
      );

      await editTool.execute(
        "e2",
        { file: "sample.ts", edits: [{ anchor_from: dHash, anchor_to: eHash, text: "" }] },
        undefined,
        undefined,
        ctx,
      );

      const read2 = await readTool.execute("r2", { file: "sample.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const survivingBLines = lines2.filter((l) => l.endsWith("│b"));
      expect(survivingBLines).toHaveLength(2);
      const survivingHashes = survivingBLines.map(extractHash);
      expect(survivingHashes).toContain(secondBHash);
      expect(survivingHashes).toContain(thirdBHash);
    });
  });
});

/**
 * A checksum miss is what an external rewrite looks like. The prior lineage is still the best evidence of
 * which line is which, so the drift must be aligned against it with the same pin-bounded pairing the edit
 * path uses: a surviving duplicate keeps its own anchor, a deleted twin's anchor retires, and an ambiguous
 * interval retires instead of guessing. Every call uses `retireLeases: true`, mirroring the read path.
 */
describe("checksum miss aligns drifted content against the latest lineage", () => {
  it("external deletion of the first duplicate twin preserves the survivor's exact anchor", async () => {
    const store = await loadHashStore();
    const snapshotIO = snapshotIOFor(store);
    const path = "/lane-i338/t1-delete-first.txt";

    const prior = await defaultHashIdentity.hashesFor("x\na\ny\na\nz\n", {
      path,
      snapshotIO,
      retireLeases: true,
    });
    const deleted = prior[1]!;
    const survivor = prior[3]!;
    expect(deleted).not.toBe(survivor);

    const retired = new Set<string>();
    const drifted = await defaultHashIdentity.hashesFor("x\ny\na\nz\n", {
      path,
      snapshotIO,
      retireLeases: true,
      retiredHashes: retired,
    });

    expect(drifted[2]).toBe(survivor);
    expect(drifted).not.toContain(deleted);
    expect(retired.has(deleted)).toBe(true);
  });

  it("a retired twin is tombstoned and never resurrected by fresh allocation", async () => {
    const store = await loadHashStore();
    const snapshotIO = snapshotIOFor(store);
    const path = "/lane-i338/t1-tombstone.txt";

    const prior = await defaultHashIdentity.hashesFor("x\na\ny\na\nz\n", {
      path,
      snapshotIO,
      retireLeases: true,
    });
    const deleted = prior[1]!;
    const survivor = prior[3]!;

    const retired = new Set<string>();
    await defaultHashIdentity.hashesFor("x\ny\na\nz\n", {
      path,
      snapshotIO,
      retireLeases: true,
      retiredHashes: retired,
    });
    expect(retired.has(deleted)).toBe(true);

    const grown = await defaultHashIdentity.hashesFor("x\ny\na\nz\na\n", {
      path,
      snapshotIO,
      retireLeases: true,
      blockedHashes: retired,
    });

    expect(grown[2]).toBe(survivor);
    expect(grown[4]).not.toBe(deleted);
    expect(grown).not.toContain(deleted);
    expect(retired.has(deleted)).toBe(true);
  });

  it("indistinguishable duplicates fail closed instead of guessing", async () => {
    const store = await loadHashStore();
    const snapshotIO = snapshotIOFor(store);
    const path = "/lane-i338/t1-ambiguous.txt";

    const prior = await defaultHashIdentity.hashesFor("x\na\na\ny\n", {
      path,
      snapshotIO,
      retireLeases: true,
    });
    const firstA = prior[1]!;
    const secondA = prior[2]!;
    expect(firstA).not.toBe(secondA);

    const retired = new Set<string>();
    const drifted = await defaultHashIdentity.hashesFor("x\na\ny\n", {
      path,
      snapshotIO,
      retireLeases: true,
      retiredHashes: retired,
    });

    expect(drifted[1]).not.toBe(firstA);
    expect(drifted[1]).not.toBe(secondA);
    expect(retired.has(firstA)).toBe(true);
    expect(retired.has(secondA)).toBe(true);
  });

  it("the walk aligns a checksum miss without persisting, so a later aligned call yields the same anchors", async () => {
    const store = await loadHashStore();
    const snapshotIO = snapshotIOFor(store);
    const path = "/lane-i338/t1-walk-alignment.txt";

    const prior = await defaultHashIdentity.hashesFor("x\na\ny\na\nz\n", {
      path,
      snapshotIO,
      retireLeases: true,
    });
    const deleted = prior[1]!;
    const survivor = prior[3]!;

    const retired = new Set<string>();
    const plan = await defaultHashIdentity.anchorsForWalk("x\ny\na\nz\n", {
      path,
      snapshotIO,
      persist: false,
      retiredHashes: retired,
    });

    expect(plan.assign).toBeUndefined();
    expect(plan.cached).toBeDefined();

    const eager = await defaultHashIdentity.hashesFor("x\ny\na\nz\n", {
      path,
      snapshotIO,
      retireLeases: true,
    });

    expect(plan.cached).toEqual(eager);
    expect(eager[2]).toBe(survivor);
    expect(retired.has(deleted)).toBe(true);
  });
});
