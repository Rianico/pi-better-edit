import { describe, expect, it } from "vitest";
import { genDiff } from "../../src/replace-diff";

describe("genDiff", () => {
	it("adds hash hints for context and addition lines and pads deletion lines to align the '│' column", () => {
		const result = genDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
		const diff = result.diff;
		// Marker + (optional hash) + "│" + content. The marker is 1 char; the
		// hash (when present) is 3 chars, so the "│" sits in column 4 (0-indexed)
		// for context and addition lines. Removed lines have no hash, so they are
		// padded with 3 spaces of "ghost hash" so the "│" stays in the same column
		// and removed-line content lines up with the surrounding context.
		expect(diff).toMatch(/^ [A-Za-z0-9_\-]{3}│alpha$/m);
		expect(diff).toMatch(/^\+[A-Za-z0-9_\-]{3}│BETA$/m);
		expect(diff).toMatch(/^- {3}│beta$/m);
		expect(diff).toMatch(/^ [A-Za-z0-9_\-]{3}│gamma$/m);
	});

	it("keeps the '│' column aligned across context, addition, and deletion lines", () => {
		// Realistic-ish snippet: drop a log line, rewrite the return. The test asserts
		// that every line in the diff places its "│" at exactly the same column
		// index, so the diff reads as a tidy aligned table rather than a ragged
		// stack. The console.log prints the full diff to the test output so the
		// alignment is visible at a glance.
		const before = [
			"function greet(name) {",
			"  console.log('old')",
			"  return 'hi'",
			"}",
		].join("\n");
		const after = [
			"function greet(name) {",
			"  return `Hello, ${name}`",
			"}",
		].join("\n");

		const { diff } = genDiff(before, after);
		// eslint-disable-next-line no-console
		console.log("\n--- genDiff output ---\n" + diff + "\n----------------------------------");

		// Every line should be: 1-char marker + 3-char hash-or-padding + '│' + content.
		// The "│" therefore lives at index 4 on every line.
		const lines = diff.split("\n");
		const colonColumns = lines.map((line) => line.indexOf("│"));
		expect(colonColumns).toEqual(lines.map(() => 4));

		// Spot-check the shape of each line type.
		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9_\-]{3}│function greet\(name\) \{$/));
		expect(lines).toContainEqual(expect.stringMatching(/^- {3}│ {2}console\.log\('old'\)$/));
		expect(lines).toContainEqual(expect.stringMatching(/^\+[A-Za-z0-9_\-]{3}│ {2}return `Hello, \$\{name\}`$/));
		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9_\-]{3}│\}$/));
		expect(lines).toContainEqual(expect.stringMatching(/^- {3}│ {2}console\.log\('old'\)$/));
		expect(lines).toContainEqual(expect.stringMatching(/^\+[A-Za-z0-9_\-]{3}│ {2}return `Hello, \$\{name\}`$/));
		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9_\-]{3}│\}$/));
	});
	it("truncates context between two distant changes", () => {
		// Two changes separated by 1000 unchanged lines
		const lines = [];
		for (let i = 1; i <= 1000; i++) lines.push("line " + i);
		const before = "BEFORE\n" + lines.join("\n") + "\nAFTER";
		const after = "BEFORE_CHANGED\n" + lines.join("\n") + "\nAFTER_CHANGED";

		const { diff } = genDiff(before, after, 4);
		const diffLines = diff.split("\n");

		// Should NOT contain all 1000 lines between the changes
		expect(diffLines.length).toBeLessThan(50);

		// Should have exactly one ellipsis marker
		const ellipsisCount = diffLines.filter((l: string) => l.trim() === "...").length;
		expect(ellipsisCount).toBe(1);

		// Ellipsis should be between context lines, not right next to a change
		const ellipsisIdx = diffLines.findIndex((l: string) => l.trim() === "...");
		expect(ellipsisIdx).toBeGreaterThan(0);
		expect(ellipsisIdx).toBeLessThan(diffLines.length - 1);

		// Context lines should appear on both sides of the ellipsis
		// Lines before ellipsis: change + context (line 1, line 2, line 3, line 4)
		expect(diffLines[ellipsisIdx - 1]).toContain("line 4");
		// Lines after ellipsis: context + change (line 997, line 998, line 999, line 1000)
		expect(diffLines[ellipsisIdx + 1]).toContain("line 997");

		// Should still contain the actual changes
		expect(diff).toContain("BEFORE_CHANGED");
		expect(diff).toContain("AFTER_CHANGED");
	});
});

