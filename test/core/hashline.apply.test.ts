import { describe, expect, it } from "vitest";
import {
  applyEdits,
  affRange,
  type HEdit,
} from "../../src/hashline";
import { makeTag } from "../support/fixtures";

describe("applyEdits — basic operations", () => {
	it("returns content unchanged for empty edits", () => {
		const result = applyEdits("hello\nworld", []);
		expect(result.content).toBe("hello\nworld");
		expect(result.firstChangedLine).toBeUndefined();
	});

	it("replaces a single line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 2), makeTag(content, 2)], new_lines: ["BBB"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("replaces a single line with multiple lines", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 2), makeTag(content, 2)], new_lines: ["BBB", "B2"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nB2\nccc");
	});

	it("deletes a single line (empty lines array)", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 2), makeTag(content, 2)], new_lines: [] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nccc");
	});

	it("treats lines:[\"\"] as a deletion request for replace (no extra blank line)", () => {
		const content = "aaa\nbbb\nccc\n";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 2), makeTag(content, 2)], new_lines: [""] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nccc\n");
	});

	it("normalizes lines:[\"\"] to a deletion for replace ranges too", () => {
		const content = "aaa\nbbb\nccc\nddd\n";
		const edits: HEdit[] = [
			{
				old_range: [makeTag(content, 2), makeTag(content, 3)],
				new_lines: [""],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nddd\n");
	});

	it("does not normalize multi-element empty arrays (those are blank lines)", () => {
		const content = "aaa\nbbb\n";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 2), makeTag(content, 2)], new_lines: ["", ""] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).not.toBe("aaa\n");
		expect(result.content.split("\n").filter((line) => line === "").length).toBeGreaterThanOrEqual(2);
	});

	it("replaces a range of lines", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HEdit[] = [
			{
				old_range: [makeTag(content, 2), makeTag(content, 3)],
				new_lines: ["BBB", "CCC"],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nCCC\nddd");
	});

	it("deletes a range of lines", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HEdit[] = [
			{
				old_range: [makeTag(content, 2), makeTag(content, 3)],
				new_lines: [],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nddd");
	});
});

describe("applyEdits — multi-edit ordering", () => {
	it("applies multiple edits bottom-up correctly", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 1), makeTag(content, 1)], new_lines: ["AAA"] },
			{ old_range: [makeTag(content, 3), makeTag(content, 3)], new_lines: ["CCC"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("AAA\nbbb\nCCC");
	});

	it("deduplicates identical edits", () => {
		const content = "aaa\nbbb\nccc";
		const pos = makeTag(content, 2);
		const edits: HEdit[] = [
			{ old_range: [{ ...pos }, { ...pos }], new_lines: ["BBB"] },
			{ old_range: [{ ...pos }, { ...pos }], new_lines: ["BBB"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});

	it("does not mutate caller-owned edit arrays while deduplicating", () => {
		const content = "aaa\nbbb\nccc";
		const pos = makeTag(content, 2);
		const edits: HEdit[] = [
			{ old_range: [{ ...pos }, { ...pos }], new_lines: ["BBB"] },
			{ old_range: [{ ...pos }, { ...pos }], new_lines: ["BBB"] },
		];

		applyEdits(content, edits);

		expect(edits).toHaveLength(2);
		expect(edits[0]).toEqual({ old_range: [{ ...pos }, { ...pos }], new_lines: ["BBB"] });
		expect(edits[1]).toEqual({ old_range: [{ ...pos }, { ...pos }], new_lines: ["BBB"] });
	});
});

describe("applyEdits — noop detection", () => {
	it("detects single-line noop", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 2), makeTag(content, 2)], new_lines: ["bbb"] },
		];
		const result = applyEdits(content, edits);
		expect(result.noopEdits).toHaveLength(1);
		expect(result.noopEdits![0]!.editIndex).toBe(0);
	});

	it("detects range noop", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HEdit[] = [
			{
				old_range: [makeTag(content, 2), makeTag(content, 3)],
				new_lines: ["bbb", "ccc"],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.noopEdits).toHaveLength(1);
	});

	it("rejects deleting an entire non-empty file", () => {
		const content = "aaa\nbbb";
		const edits: HEdit[] = [
			{
				old_range: [makeTag(content, 1), makeTag(content, 2)],
				new_lines: [],
			},
		];
		expect(() => applyEdits(content, edits)).toThrow(
			/^\[E_WOULD_EMPTY\]/,
		);
	});

	it("allows whole-file rewrite when the final content is non-empty", () => {
		const content = "aaa\nbbb";
		const edits: HEdit[] = [
			{
				old_range: [makeTag(content, 1), makeTag(content, 2)],
				new_lines: ["ccc"],
			},
		];

		const result = applyEdits(content, edits);

		expect(result.content).toBe("ccc");
	});

	it("allows replacing content with whitespace", () => {
		const content = "aaa";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 1), makeTag(content, 1)], new_lines: ["\n"] },
		];

		const result = applyEdits(content, edits);

		expect(result.content).toBe("\n");
	});
});

describe("applyEdits — warning heuristics", () => {
	it("warns when replacement starts with the previous surviving line", () => {
		const content = "before\nold one\nold two\nafter";
		const edits: HEdit[] = [
			{
				old_range: [makeTag(content, 2), makeTag(content, 3)],
				new_lines: ["before", "new one", "new two"],
			},
		];

		const result = applyEdits(content, edits);

		expect(result.content).toBe("before\nbefore\nnew one\nnew two\nafter");
		expect(result.warnings).toEqual([
			expect.stringContaining(
				"the first line of the replacement",
			),
		]);
	});
});

describe("applyEdits — lastChangedLine tracking", () => {
	it("tracks lastChangedLine when single-line replace expands to multiple lines", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{
				old_range: [makeTag(content, 2), makeTag(content, 2)], new_lines: ["B1", "B2", "B3", "B4", "B5"],
			},
		];

		const result = applyEdits(content, edits);

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(6);
	});

	it("tracks lastChangedLine correctly for single-line delete", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 2), makeTag(content, 2)], new_lines: [] },
		];

		const result = applyEdits(content, edits);

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(2);
	});

	it("tracks lastChangedLine correctly for multi-line delete", () => {
		const content = "aaa\nbbb\nccc\nddd\neee\nfff\nggg";
		const edits: HEdit[] = [
			{
				old_range: [makeTag(content, 2), makeTag(content, 4)],
				new_lines: [],
			},
		];

		const result = applyEdits(content, edits);

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(4);
	});
});

describe("applyEdits — edge cases (empty, single-line, no trailing newline)", () => {
	it("edits a single-line file without trailing newline", () => {
		const content = "hello";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 1), makeTag(content, 1)], new_lines: ["world"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("world");
	});

	it("edits a single-line file with trailing newline", () => {
		const content = "hello\n";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 1), makeTag(content, 1)], new_lines: ["world"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("world\n");
	});

	it("edits a file with only a trailing newline (one blank line)", () => {
		const content = "\n";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 1), makeTag(content, 1)], new_lines: ["hello"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("hello\n");
	});

	it("deletes the only line in a single-line file without trailing newline", () => {
		const content = "hello";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 1), makeTag(content, 1)], new_lines: [] },
		];
		expect(() => applyEdits(content, edits)).toThrow(/^\[E_WOULD_EMPTY\]/);
	});

	it("replaces a line in a file with no trailing newline", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 2), makeTag(content, 2)], new_lines: ["BBB"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});

	it("appends a line to a file without trailing newline", () => {
		const content = "aaa\nbbb";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 2), makeTag(content, 2)], new_lines: ["bbb", "ccc"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nbbb\nccc");
	});
});
