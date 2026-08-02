import { describe, expect, it } from "vitest";
import {
  applyEdit,
  type HEdit,
} from "../../src/hashline";
import { makeTag, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("applyEdit — basic operations", () => {
	it("replaces a single line", async () => {
		const content = "aaa\nbbb\nccc";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["BBB"] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("aaa\nBBB\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("replaces a single line with multiple lines", async () => {
		const content = "aaa\nbbb\nccc";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["BBB", "B2"] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("aaa\nBBB\nB2\nccc");
	});

	it("deletes a single line (empty lines array)", async () => {
		const content = "aaa\nbbb\nccc";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: [] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("aaa\nccc");
	});

  it("treats lines:[\"\"] as inserting a blank line", async () => {
    const content = "aaa\nbbb\nccc\n";
    const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: [""] };
    const result = applyEdit(content, edit);
    expect(result.content).toBe("aaa\n\nccc\n");
  });

  it("treats lines:[\"\"] as a blank line for range replaces too", async () => {
    const content = "aaa\nbbb\nccc\nddd\n";
    const edit: HEdit = {
      hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
      content_lines: [""],
    };
    const result = applyEdit(content, edit);
    expect(result.content).toBe("aaa\n\nddd\n");
  });

	it("does not normalize multi-element empty arrays (those are blank lines)", async () => {
		const content = "aaa\nbbb\n";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["", ""] };
		const result = applyEdit(content, edit);
		expect(result.content).not.toBe("aaa\n");
		expect(result.content.split("\n").filter((line) => line === "").length).toBeGreaterThanOrEqual(2);
	});

	it("replaces a range of lines", async () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edit: HEdit = {
			hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
			content_lines: ["BBB", "CCC"],
		};
		const result = applyEdit(content, edit);
		expect(result.content).toBe("aaa\nBBB\nCCC\nddd");
	});

	it("deletes a range of lines", async () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edit: HEdit = {
			hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
			content_lines: [],
		};
		const result = applyEdit(content, edit);
		expect(result.content).toBe("aaa\nddd");
	});
});

describe("applyEdit — noop detection", () => {
	it("detects single-line noop", async () => {
		const content = "aaa\nbbb\nccc";
		const tag = await makeTag(content, 2, home.testPath);
		const edit: HEdit = { hash_range_inclusive: [tag, tag], content_lines: ["bbb"] };
		const result = applyEdit(content, edit);
		expect(result.noopEdit).toBeDefined();
		expect(result.noopEdit!.loc).toBe(tag.hash);
	});

	it("detects range noop", async () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edit: HEdit = {
			hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
			content_lines: ["bbb", "ccc"],
		};
		const result = applyEdit(content, edit);
		expect(result.noopEdit).toBeDefined();
	});

	it("rejects deleting an entire non-empty file", async () => {
		const content = "aaa\nbbb";
		const edit: HEdit = {
			hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 2, home.testPath)],
			content_lines: [],
		};
		expect(() => applyEdit(content, edit)).toThrow(
			/^\[E_WOULD_EMPTY\]/,
		);
	});

	it("allows whole-file rewrite when the final content is non-empty", async () => {
		const content = "aaa\nbbb";
		const edit: HEdit = {
			hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 2, home.testPath)],
			content_lines: ["ccc"],
		};

		const result = applyEdit(content, edit);

		expect(result.content).toBe("ccc");
	});

	it("allows replacing content with whitespace", async () => {
		const content = "aaa";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["\n"] };

		const result = applyEdit(content, edit);

		expect(result.content).toBe("\n");
	});
});

describe("applyEdit — auto-fix heuristics", () => {
	it("auto-fixes leading duplication by stripping the first replacement line", async () => {
		const content = "before\nold one\nold two\nafter";
		const edit: HEdit = {
			hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
			content_lines: ["before", "new one", "new two"],
		};

		const result = applyEdit(content, edit);

		expect(result.content).toBe("before\nnew one\nnew two\nafter");
		expect(result.autoFixes).toHaveLength(1);
		expect(result.autoFixes![0]!.kind).toBe("leading");
		expect(result.autoFixes![0]!.removedLine).toBe("before");
	});

	it("auto-fixes trailing duplication by stripping the last replacement line", async () => {
		const content = "before\nold one\nold two\nafter";
		const edit: HEdit = {
			hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
			content_lines: ["new one", "new two", "after"],
		};

		const result = applyEdit(content, edit);

		expect(result.content).toBe("before\nnew one\nnew two\nafter");
		expect(result.autoFixes).toHaveLength(1);
		expect(result.autoFixes![0]!.kind).toBe("trailing");
		expect(result.autoFixes![0]!.removedLine).toBe("after");
	});
});

describe("applyEdit — lastChangedLine tracking", () => {
	it("tracks lastChangedLine when single-line replace expands to multiple lines", async () => {
		const content = "aaa\nbbb\nccc";
		const edit: HEdit = {
			hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["B1", "B2", "B3", "B4", "B5"],
		};

		const result = applyEdit(content, edit);

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(6);
	});

	it("tracks lastChangedLine correctly for single-line delete", async () => {
		const content = "aaa\nbbb\nccc";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: [] };

		const result = applyEdit(content, edit);

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(2);
	});

	it("tracks lastChangedLine correctly for multi-line delete", async () => {
		const content = "aaa\nbbb\nccc\nddd\neee\nfff\nggg";
		const edit: HEdit = {
			hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 4, home.testPath)],
			content_lines: [],
		};

		const result = applyEdit(content, edit);

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(2);
	});
});

describe("applyEdit — edge cases (empty, single-line, no trailing newline)", () => {
	it("edits a single-line file without trailing newline", async () => {
		const content = "hello";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["world"] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("world");
	});

	it("edits a single-line file with trailing newline", async () => {
		const content = "hello\n";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["world"] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("world\n");
	});

	it("edits a file with only a trailing newline (one blank line)", async () => {
		const content = "\n";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["hello"] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("hello\n");
	});

	it("deletes the only line in a single-line file without trailing newline", async () => {
		const content = "hello";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: [] };
		expect(() => applyEdit(content, edit)).toThrow(/^\[E_WOULD_EMPTY\]/);
	});

	it("replaces a line in a file with no trailing newline", async () => {
		const content = "aaa\nbbb\nccc";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["BBB"] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});

	it("appends a line to a file without trailing newline", async () => {
		const content = "aaa\nbbb";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["bbb", "ccc"] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("aaa\nbbb\nccc");
	});
});

describe("applyEdit — trailing newline preservation", () => {
	it("preserves trailing newline when replacing the last line of a file with one", async () => {
		const content = "line1\n</br>\n";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["LINE1"] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("LINE1\n</br>\n");
	});

	it("preserves trailing newline when replacing the last line itself", async () => {
		const content = "line1\n</br>\n";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["<br/>"] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("line1\n<br/>\n");
	});

	it("preserves trailing newline when replacing a range ending at the last line", async () => {
		const content = "a\nb\nc\n";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)], content_lines: ["B", "C"] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("a\nB\nC\n");
	});

	it("does not add trailing newline when original had none", async () => {
		const content = "line1\n</br>";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["LINE1"] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("LINE1\n</br>");
	});

	it("does not add trailing newline for mid-file edits", async () => {
		const content = "a\nb\nc\n";
		const edit: HEdit = { hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["B"] };
		const result = applyEdit(content, edit);
		expect(result.content).toBe("a\nB\nc\n");
	});
});
