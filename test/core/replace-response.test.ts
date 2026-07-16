import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildNoop, buildChanged } from "../../src/replace-response";
import { lineHashes } from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("buildNoop", () => {
  it("returns noop result with classification", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdits: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0 },
      warnings: undefined,
    });
    expect(result.content[0].text).toContain("No changes made to test.txt");
    expect(result.details.classification).toBe("noop");
    expect(result.details.metrics!.edits_attempted).toBe(1);
  });

  it("includes noop edit details when provided", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdits: [{ editIndex: 0, loc: "ABC", currentContent: "old" }],
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1 },
      warnings: undefined,
    });
    expect(result.content[0].text).toContain("Edit 0");
    expect(result.content[0].text).toContain("ABC");
  });

  it("includes warnings when provided", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdits: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0 },
      warnings: ["Warning 1"],
    });
    expect(result.details.metrics!.warnings).toBe(1);
  });
});

describe("buildChanged", () => {
  it("returns applied result with diff and metrics", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 2 },
    });
    expect(output.content[0].text).toContain("Successfully replaced in test.txt");
    expect(output.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    expect(output.details.metrics!.classification).toBe("applied");
    expect(output.details.metrics!.edits_attempted).toBe(1);
    expect(output.details.metrics!.changed_lines).toEqual({ first: 2, last: 2 });
  });

  it("includes warnings when provided", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: ["Boundary duplication (leading)"],
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 2 },
    });
    expect(output.content[0].text).toContain("Warnings:");
    expect(output.content[0].text).toContain("Boundary duplication (leading)");
  });

  it("shows empty file message when result is empty", async () => {
    const original = "aaa\nbbb\n";
    const result = "";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 1, lastChangedLine: 2 },
    });
    expect(output.content[0].text).toBe("File is empty. Use replace to insert content.");
  });

  it("computes added_lines and removed_lines from diff", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nCCC\nDDD\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 4 },
    });
    expect(output.details.metrics!.added_lines).toBe(3);
    expect(output.details.metrics!.removed_lines).toBe(2);
    expect(output.content[0].text).toContain("Added 3 line(s), removed 2 line(s).");
  });

  it("handles no changed lines gracefully", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nbbb\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1, firstChangedLine: undefined, lastChangedLine: undefined },
    });
    expect(output.details.metrics!.added_lines).toBe(0);
    expect(output.details.metrics!.removed_lines).toBe(0);
  });
});
