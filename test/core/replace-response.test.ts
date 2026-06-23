import { describe, expect, it } from "vitest";
import { buildNoop, buildChanged } from "../../src/replace-response";

describe("buildNoop", () => {
	it("builds noop response with edits", () => {
		const result = buildNoop({
			path: "test.txt",
			noopEdits: [
				{ editIndex: 0, loc: "AAA", currentContent: "line1" },
			],
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 1,
			},
			warnings: undefined,
		});

		expect(result.content[0].text).toContain("No changes made to test.txt");
		expect(result.content[0].text).toContain("noop");
		expect(result.content[0].text).toContain("AAA");
		expect(result.details.classification).toBe("noop");
		expect(result.details.snapshotId).toBe("v1|test|123|456");
	});

	it("builds noop response without edits", () => {
		const result = buildNoop({
			path: "test.txt",
			noopEdits: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
			},
			warnings: undefined,
		});

		expect(result.content[0].text).toContain("The edits produced identical content.");
	});

	it("does not include warnings in text", () => {
		const result = buildNoop({
			path: "test.txt",
			noopEdits: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
			},
			warnings: ["Warning 1", "Warning 2"],
		});

		expect(result.content[0].text).not.toContain("Warning 1");
	});

	it("includes warnings in details when present", () => {
		const result = buildNoop({
			path: "src/main.ts",
			noopEdits: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
			},
			warnings: ["Test warning"],
		});
		expect(result.details.metrics!.warnings).toBe(1);
	});

	it("includes metrics", () => {
		const result = buildNoop({
			path: "test.txt",
			noopEdits: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 2,
				noopEditsCount: 1,
			},
			warnings: undefined,
		});

		expect(result.details.metrics!.edits_attempted).toBe(2);
		expect(result.details.metrics!.edits_noop).toBe(1);
		expect(result.details.metrics!.classification).toBe("noop");
	});
});

describe("buildChanged", () => {
	it("builds changed response with diff", () => {
		const result = buildChanged({
			path: "test.txt",
			originalNormalized: "line1\nline2\n",
			result: "line1\nmodified\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
				firstChangedLine: 2,
				lastChangedLine: 2,
			},
		});

		expect(result.content[0].text).not.toContain("--- Anchors ---");
		expect(result.details.diff).toContain("modified");
		expect(result.details.diff).toContain("line2");
		expect(result.details.firstChangedLine).toBe(2);
		expect(result.details.snapshotId).toBe("v1|test|123|456");
	});

	it("includes warnings", () => {
		const result = buildChanged({
			path: "test.txt",
			originalNormalized: "line1\n",
			result: "line1\nline2\n",
			warnings: ["Warning 1"],
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
				firstChangedLine: 2,
				lastChangedLine: 2,
			},
		});

		expect(result.content[0].text).toContain("Warning 1");
	});

	it("includes metrics", () => {
		const result = buildChanged({
			path: "test.txt",
			originalNormalized: "line1\n",
			result: "line1\nline2\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
				firstChangedLine: 2,
				lastChangedLine: 2,
			},
		});

		expect(result.details.metrics!.classification).toBe("applied");
		expect(result.details.metrics!.edits_attempted).toBe(1);
		expect(result.details.metrics!.changed_lines).toEqual({ first: 2, last: 2 });
	});

	it("handles empty result file", () => {
		const result = buildChanged({
			path: "test.txt",
			originalNormalized: "line1\n",
			result: "",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
				firstChangedLine: 1,
				lastChangedLine: 1,
			},
		});

		expect(result.content[0].text).toContain("File is empty");
	});

	it("uses provided resultHashes", () => {
		const result = buildChanged({
			path: "test.txt",
			originalNormalized: "line1\n",
			result: "line1\nline2\n",
			resultHashes: ["AAA", "BBB"],
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
				firstChangedLine: 2,
				lastChangedLine: 2,
			},
		});

		expect(result.content[0].text).not.toContain("AAA");
		expect(result.content[0].text).not.toContain("BBB");
	});

	it("omits anchors when region too large", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
		const original = lines.join("\n") + "\n";
		const modified = [...lines.slice(0, 50), "changed", ...lines.slice(51)].join("\n") + "\n";
		const result = buildChanged({
			path: "src/main.ts",
			originalNormalized: original,
			result: modified,
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
				firstChangedLine: 51,
				lastChangedLine: 51,
			},
		});
		expect(result.content[0].text).toBe("");
	});

	it("shows compact diff preview when anchors omitted due to large edit", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line${i}`);
		const original = lines.join("\n") + "\n";
		const newLines = Array.from({ length: 15 }, (_, i) => `NEW${i}`);
		const modified = [...lines.slice(0, 10), ...newLines, ...lines.slice(25)].join("\n") + "\n";
		const result = buildChanged({
			path: "src/main.ts",
			originalNormalized: original,
			result: modified,
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
				firstChangedLine: 11,
				lastChangedLine: 25,
			},
		});
		expect(result.content[0].text).not.toContain("--- Anchors ---");
		expect(result.content[0].text).toBe("");
	});
});
