import { describe, expect, it } from "vitest";
import { changedRange } from "../../src/hashline";

describe("changedRange", () => {
  it("returns null when content is unchanged", () => {
    expect(changedRange("a\nb\nc", "a\nb\nc")).toBeNull();
  });

  it("tracks a single-line replace", () => {
    const result = changedRange("a\nb\nc", "a\nB\nc");
    expect(result).toEqual({ firstChangedLine: 2, lastChangedLine: 2 });
  });

  it("tracks a multi-line replace that expands", () => {
    const result = changedRange("a\nb\nc", "a\nB1\nB2\nc");
    expect(result).toEqual({ firstChangedLine: 2, lastChangedLine: 3 });
  });

	it("tracks a multi-line delete in the middle", () => {
		const result = changedRange("a\nb\nc\nd", "a\nd");
    expect(result).not.toBeNull();
    expect(result!.firstChangedLine).toBeLessThanOrEqual(result!.lastChangedLine);
    expect(result).toEqual({ firstChangedLine: 2, lastChangedLine: 2 });
  });

  it("tracks deleting head of file", () => {
    const result = changedRange("a\nb\nc\nd", "c\nd");
    expect(result!.firstChangedLine).toBeLessThanOrEqual(result!.lastChangedLine);
    expect(result).toEqual({ firstChangedLine: 1, lastChangedLine: 2 });
  });

  it("tracks deleting tail of file", () => {
    const result = changedRange("a\nb\nc\nd", "a\nb");
    expect(result!.firstChangedLine).toBeLessThanOrEqual(result!.lastChangedLine);
  });

  it("tracks prepending at BOF", () => {
    const result = changedRange("a\nb\nc", "X\na\nb\nc");
    expect(result).toEqual({ firstChangedLine: 1, lastChangedLine: 1 });
  });

  it("tracks appending at EOF", () => {
    const result = changedRange("a\nb\nc", "a\nb\nc\nX");
    expect(result).toEqual({ firstChangedLine: 4, lastChangedLine: 4 });
  });

  it("tracks deleting all content", () => {
    const result = changedRange("a\nb\nc", "");
    expect(result).toEqual({ firstChangedLine: 1, lastChangedLine: 1 });
  });
});
