import { describe, expect, it } from "vitest";
import { genDiff } from "../../src/replace-diff";

describe("genDiff", () => {
	it("adds hash hints for context and addition lines and pads deletion lines to align the '│' column", () => {
		const result = genDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
		const diff = result.diff;
		expect(diff).toMatch(/^ [A-Za-z0-9_\-]{3}│alpha$/m);
		expect(diff).toMatch(/^\+[A-Za-z0-9_\-]{3}│BETA$/m);
		expect(diff).toMatch(/^- {3}│beta$/m);
		expect(diff).toMatch(/^ [A-Za-z0-9_\-]{3}│gamma$/m);
	});

	it("keeps the '│' column aligned across context, addition, and deletion lines", () => {

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
		console.log("\n--- genDiff output ---\n" + diff + "\n----------------------------------");

		const lines = diff.split("\n");

		const colonColumns = lines.map((line) => line.indexOf("│"));
		expect(colonColumns).toEqual(lines.map(() => 4));

		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9_\-]{3}│function greet\(name\) \{$/));
		expect(lines).toContainEqual(expect.stringMatching(/^- {3}│ {2}console\.log\('old'\)$/));
		expect(lines).toContainEqual(expect.stringMatching(/^\+[A-Za-z0-9_\-]{3}│ {2}return `Hello, \$\{name\}`$/));
		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9_\-]{3}│\}$/));
		expect(lines).toContainEqual(expect.stringMatching(/^- {3}│ {2}console\.log\('old'\)$/));
		expect(lines).toContainEqual(expect.stringMatching(/^\+[A-Za-z0-9_\-]{3}│ {2}return `Hello, \$\{name\}`$/));
		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9_\-]{3}│\}$/));
	});
	it("truncates context between two distant changes", () => {
		const lines = [];
		for (let i = 1; i <= 1000; i++) lines.push("line " + i);
		const before = "BEFORE\n" + lines.join("\n") + "\nAFTER";
		const after = "BEFORE_CHANGED\n" + lines.join("\n") + "\nAFTER_CHANGED";

		const { diff } = genDiff(before, after, 4);
		const diffLines = diff.split("\n");

		expect(diffLines.length).toBeLessThan(50);

		const ellipsisCount = diffLines.filter((l: string) => l.trim() === "...").length;
		expect(ellipsisCount).toBe(1);

		const ellipsisIdx = diffLines.findIndex((l: string) => l.trim() === "...");
		expect(ellipsisIdx).toBeGreaterThan(0);
		expect(ellipsisIdx).toBeLessThan(diffLines.length - 1);

		expect(diffLines[ellipsisIdx - 1]).toContain("line 4");
		expect(diffLines[ellipsisIdx + 1]).toContain("line 997");

		expect(diff).toContain("BEFORE_CHANGED");
		expect(diff).toContain("AFTER_CHANGED");
	});
});
