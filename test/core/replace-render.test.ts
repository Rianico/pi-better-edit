import { describe, expect, it, vi } from "vitest";
import {
	getRenderablePreviewInput,
	colorDiffLines,
	formatPreviewDiff,
	formatResultDiff,
	formatEditCall,
	getRenderedEditTextContent,
	extractRenderedWarnings,
	isAppliedChangedResult,
	buildAppliedChangedResultText,
	formatRenderedEditResultMarkdown,
	createRenderedEditMarkdownTheme,
} from "../../src/replace-render";

const mockTheme = {
	fg: vi.fn((color: string, text: string) => `[${color}]${text}`),
	bold: vi.fn((text: string) => `**${text}**`),
	italic: vi.fn((text: string) => `_${text}_`),
	underline: vi.fn((text: string) => `__${text}__`),
	strikethrough: vi.fn((text: string) => `~~${text}~~`),
};

describe("getRenderablePreviewInput", () => {
	it("returns null for non-record input", () => {
		expect(getRenderablePreviewInput("string")).toBeNull();
		expect(getRenderablePreviewInput(null)).toBeNull();
		expect(getRenderablePreviewInput(42)).toBeNull();
	});

	it("returns null for record without path", () => {
		expect(getRenderablePreviewInput({ edits: [] })).toBeNull();
	});

	it("returns null for record with non-string path", () => {
		expect(getRenderablePreviewInput({ path: 42 })).toBeNull();
	});

	it("returns null for record without edits", () => {
		expect(getRenderablePreviewInput({ path: "test.txt" })).toBeNull();
	});

	it("returns request for valid input", () => {
		const input = { path: "test.txt", edits: [{ old_range: ["AAA", "BBB"], new_lines: ["new"] }] };
		const result = getRenderablePreviewInput(input);
		expect(result).toEqual(input);
	});

	it("normalizes file_path to path", () => {
		const input = { file_path: "test.txt", edits: [{ old_range: ["AAA", "BBB"], new_lines: ["new"] }] };
		const result = getRenderablePreviewInput(input);
		expect(result?.path).toBe("test.txt");
	});
});

describe("colorDiffLines", () => {
	it("colors addition lines green", () => {
		const lines = ["+added line"];
		const result = colorDiffLines(lines, mockTheme);
		expect(result[0]).toContain("[success]");
	});

	it("colors removal lines red", () => {
		const lines = ["-removed line"];
		const result = colorDiffLines(lines, mockTheme);
		expect(result[0]).toContain("[error]");
	});

	it("colors context lines dim", () => {
		const lines = [" context line"];
		const result = colorDiffLines(lines, mockTheme);
		expect(result[0]).toContain("[dim]");
	});

	it("does not color +++ or --- lines", () => {
		const lines = ["+++header+++", "---header---"];
		const result = colorDiffLines(lines, mockTheme);
		expect(result[0]).toContain("[dim]");
		expect(result[1]).toContain("[dim]");
	});
});

describe("formatPreviewDiff", () => {
	it("truncates long diffs", () => {
		const lines = Array.from({ length: 50 }, (_, i) => ` line ${i}`);
		const diff = lines.join("\n");
		const result = formatPreviewDiff(diff, false, mockTheme);
		expect(result).toContain("more diff lines");
	});

	it("shows all lines when expanded", () => {
		const lines = Array.from({ length: 30 }, (_, i) => ` line ${i}`);
		const diff = lines.join("\n");
		const result = formatPreviewDiff(diff, true, mockTheme);
		expect(result).not.toContain("more diff lines");
	});
});

describe("formatResultDiff", () => {
	it("formats diff with colors", () => {
		const diff = "+added\n-removed\n context";
		const result = formatResultDiff(diff, mockTheme);
		expect(result).toContain("[success]");
		expect(result).toContain("[error]");
		expect(result).toContain("[dim]");
	});
});

describe("formatEditCall", () => {
	it("formats call with path", () => {
		const args = { path: "test.txt", edits: [] };
		const state = { preview: undefined };
		const result = formatEditCall(args, state, false, mockTheme);
		expect(result).toContain("test.txt");
	});

	it("formats call with error preview", () => {
		const args = { path: "test.txt", edits: [] };
		const state = { preview: { error: "test error" } };
		const result = formatEditCall(args, state, false, mockTheme);
		expect(result).toContain("test error");
	});

	it("formats call with diff preview", () => {
		const args = { path: "test.txt", edits: [] };
		const state = { preview: { diff: "+added\n-removed" } };
		const result = formatEditCall(args, state, false, mockTheme);
		expect(result).toContain("+added");
	});

	it("handles undefined args", () => {
		const state = { preview: undefined };
		const result = formatEditCall(undefined, state, false, mockTheme);
		expect(result).toContain("...");
	});
});

describe("getRenderedEditTextContent", () => {
	it("extracts text content", () => {
		const result = {
			content: [
				{ type: "image", data: "base64" },
				{ type: "text", text: "hello" },
			],
		};
		expect(getRenderedEditTextContent(result)).toBe("hello");
	});

	it("returns undefined for no text content", () => {
		const result = {
			content: [{ type: "image", data: "base64" }],
		};
		expect(getRenderedEditTextContent(result)).toBeUndefined();
	});

	it("returns undefined for empty content", () => {
		expect(getRenderedEditTextContent({})).toBeUndefined();
	});
});

describe("extractRenderedWarnings", () => {
	it("extracts warnings block", () => {
		const text = "Some text\nWarnings:\nWarning 1\nWarning 2";
		const result = extractRenderedWarnings(text);
		expect(result).toContain("Warnings:");
		expect(result).toContain("Warning 1");
	});

	it("returns undefined for no warnings", () => {
		expect(extractRenderedWarnings("No warnings here")).toBeUndefined();
	});

	it("returns undefined for undefined input", () => {
		expect(extractRenderedWarnings(undefined)).toBeUndefined();
	});
});

describe("isAppliedChangedResult", () => {
	it("returns true for applied changes", () => {
	const details = {
		diff: "",
		metrics: {
			classification: "applied" as const,
			edits_attempted: 1,
			edits_noop: 0,
			warnings: 0,
			added_lines: 1,
			removed_lines: 1,
		},
	};
		expect(isAppliedChangedResult(details)).toBe(true);
	});

	it("returns false for noop", () => {
	const details = {
		diff: "",
		metrics: {
			classification: "noop" as const,
			edits_attempted: 1,
			edits_noop: 1,
			warnings: 0,
		},
	};
		expect(isAppliedChangedResult(details)).toBe(false);
	});

	it("returns false for undefined details", () => {
		expect(isAppliedChangedResult({ diff: "" })).toBe(false);
	});

	it("returns false for missing metrics", () => {
		expect(isAppliedChangedResult({ diff: "" })).toBe(false);
	});
});

describe("buildAppliedChangedResultText", () => {
	it("builds text with diff and warnings", () => {
		const text = "Some text\nWarnings:\nWarning 1";
		const details = {
			diff: "+added\n-removed",
			metrics: {
				classification: "applied" as const,
				edits_attempted: 1,
				edits_noop: 0,
				warnings: 1,
				added_lines: 1,
				removed_lines: 1,
			},
		};
		const result = buildAppliedChangedResultText(text, details, mockTheme);
		expect(result).toContain("[success]");
		expect(result).toContain("Warnings:");
	});

	it("returns undefined for no content", () => {
		const result = buildAppliedChangedResultText(undefined, undefined, mockTheme);
		expect(result).toBeUndefined();
	});
});

describe("formatRenderedEditResultMarkdown", () => {
	it("formats anchors section", () => {
		const text = "--- Anchors ---\nAAA│line1\nBBB│line2";
		const result = formatRenderedEditResultMarkdown(text);
		expect(result).toContain("#### Anchors");
		expect(result).toContain("```text");
	});

	it("handles multiple sections", () => {
		const text = "--- Anchors ---\nAAA│line1\n\nWarnings:\nWarning 1";
		const result = formatRenderedEditResultMarkdown(text);
		expect(result).toContain("#### Anchors");
		expect(result).toContain("Warnings:");
	});

	it("handles plain text without sections", () => {
		const text = "Just plain text";
		const result = formatRenderedEditResultMarkdown(text);
		expect(result).toContain("Just plain text");
	});
});

describe("createRenderedEditMarkdownTheme", () => {
	it("creates theme with all properties", () => {
		const theme = createRenderedEditMarkdownTheme(mockTheme);
		expect(theme.heading).toBeDefined();
		expect(theme.link).toBeDefined();
		expect(theme.code).toBeDefined();
		expect(theme.codeBlock).toBeDefined();
		expect(theme.bold).toBeDefined();
		expect(theme.highlightCode).toBeDefined();
	});

	it("highlightCode handles diff language", () => {
		const theme = createRenderedEditMarkdownTheme(mockTheme);
		const result = theme.highlightCode("+added\n-removed\n context", "diff");
		expect(result.length).toBe(3);
	});

	it("highlightCode handles non-diff language", () => {
		const theme = createRenderedEditMarkdownTheme(mockTheme);
		const result = theme.highlightCode("const x = 1;", "javascript");
		expect(result.length).toBe(1);
	});
});