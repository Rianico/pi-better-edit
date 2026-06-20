import { describe, expect, it } from "vitest";
import { buildNoopResponse, buildChangedResponse } from "../../src/replace-response";

describe("buildNoopResponse", () => {
	it("builds noop response with edits", () => {
		const result = buildNoopResponse({
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
		const result = buildNoopResponse({
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
		const result = buildNoopResponse({
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

	it("includes metrics", () => {
		const result = buildNoopResponse({
			path: "test.txt",
			noopEdits: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				editsAttempted: 2,
				noopEditsCount: 1,
			},
			warnings: undefined,
		});

		expect(result.details.metrics.edits_attempted).toBe(2);
		expect(result.details.metrics.edits_noop).toBe(1);
		expect(result.details.metrics.classification).toBe("noop");
	});
});

describe("buildChangedResponse", () => {
	it("builds changed response with diff", () => {
		const result = buildChangedResponse({
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
		const result = buildChangedResponse({
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
		const result = buildChangedResponse({
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

		expect(result.details.metrics.classification).toBe("applied");
		expect(result.details.metrics.edits_attempted).toBe(1);
		expect(result.details.metrics.changed_lines).toEqual({ first: 2, last: 2 });
	});

	it("handles empty result file", () => {
		const result = buildChangedResponse({
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
		const result = buildChangedResponse({
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
});