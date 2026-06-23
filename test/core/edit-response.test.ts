import { describe, expect, it } from "vitest";
import {
	buildNoop,
	buildChanged,
	type NoopResponseInput,
	type SuccessResponseInput,
	type ReplaceMeta,
} from "../../src/replace-response";
import { lineHash } from "../../src/hashline";

const baseReplaceMeta: ReplaceMeta = {
	editsAttempted: 1,
	noopEditsCount: 0,
};

describe("buildNoop", () => {
	it("returns noop classification in text", () => {
		const input: NoopResponseInput = {
			path: "src/main.ts",
			noopEdits: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: baseReplaceMeta,
			warnings: undefined,
		};
		const result = buildNoop(input);
		expect(result.content[0].text).toContain("No changes made");
		expect(result.content[0].text).toContain("noop");
		expect(result.details.classification).toBe("noop");
	});

	it("includes noop edit details when present", () => {
		const input: NoopResponseInput = {
			path: "src/main.ts",
			noopEdits: [
				{
					editIndex: 0,
					loc: lineHash(1, "line1"),
					currentContent: "line1",
				},
			],
			snapshotId: "v1|test|123|456",
			editMeta: { ...baseReplaceMeta, noopEditsCount: 1 },
			warnings: undefined,
		};
		const result = buildNoop(input);
		expect(result.content[0].text).toContain("Edit 0");
		expect(result.content[0].text).toContain("identical to current content");
	});

	it("includes warnings in details when present", () => {
		const input: NoopResponseInput = {
			path: "src/main.ts",
			noopEdits: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: baseReplaceMeta,
			warnings: ["Test warning"],
		};
		const result = buildNoop(input);
		// Warnings are tracked in metrics for noop responses
		expect(result.details.metrics.warnings).toBe(1);
	});

	it("includes metrics in details", () => {
		const input: NoopResponseInput = {
			path: "src/main.ts",
			noopEdits: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: baseReplaceMeta,
			warnings: undefined,
		};
		const result = buildNoop(input);
		expect(result.details.metrics).toBeDefined();
		expect(result.details.metrics.classification).toBe("noop");
		expect(result.details.metrics.edits_attempted).toBe(1);
	});
});

describe("buildChanged", () => {
	it("returns nothing in text when no anchor context", () => {
		// With contextLines=0 (default), no anchor block is shown
		// Nothing is shown; LLM can call read for fresh anchors
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			originalNormalized: "line1\nline2\nline3\n",
			result: "line1\nmodified\nline3\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseReplaceMeta,
				firstChangedLine: 2,
				lastChangedLine: 2,
			},
		};
		const result = buildChanged(input);
		expect(result.content[0].text).toBe("");
	});

	it("returns diff in details but not in text", () => {
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			originalNormalized: "line1\nline2\n",
			result: "line1\nmodified\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseReplaceMeta,
				firstChangedLine: 2,
				lastChangedLine: 2,
			},
		};
		const result = buildChanged(input);
		expect(result.details.diff).toContain("+");
		expect(result.details.diff).toContain("modified");
		// Text should not contain the diff directly
		expect(result.content[0].text).not.toContain("+modified");
	});

	it("includes metrics with line counts", () => {
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			originalNormalized: "line1\nline2\nline3\n",
			result: "line1\nmodified\nline3\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseReplaceMeta,
				firstChangedLine: 2,
				lastChangedLine: 2,
			},
		};
		const result = buildChanged(input);
		expect(result.details.metrics.classification).toBe("applied");
		expect(result.details.metrics.added_lines).toBeGreaterThanOrEqual(1);
	});

	it("omits anchors when region too large", () => {
		// Create a large file where the changed region exceeds the budget
		const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
		const original = lines.join("\n") + "\n";
		const modified = [...lines.slice(0, 50), "changed", ...lines.slice(51)].join("\n") + "\n";
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			originalNormalized: original,
			result: modified,
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseReplaceMeta,
				firstChangedLine: 51,
				lastChangedLine: 51,
			},
		};
		const result = buildChanged(input);
		// With contextLines=0 (default), no anchor block is shown
		expect(result.content[0].text).toBe("");
	});

	it("shows compact diff preview when anchors omitted due to large edit", () => {
		// Replace 15 lines — with 2 context each side = 19 > 12 max
		const lines = Array.from({ length: 30 }, (_, i) => `line${i}`);
		const original = lines.join("\n") + "\n";
		const newLines = Array.from({ length: 15 }, (_, i) => `NEW${i}`);
		const modified = [...lines.slice(0, 10), ...newLines, ...lines.slice(25)].join("\n") + "\n";
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			originalNormalized: original,
			result: modified,
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseReplaceMeta,
				firstChangedLine: 11,
				lastChangedLine: 25,
			},
		};
		const result = buildChanged(input);
		// Should NOT contain full anchors block
		expect(result.content[0].text).not.toContain("--- Anchors ---");
		// With contextLines=0, nothing is shown in text
		expect(result.content[0].text).toBe("");
	});
});
