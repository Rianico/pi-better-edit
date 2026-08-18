import { describe, expect, it, vi } from "vitest";
import {
	getPreviewInput,
	colorLines,
	fmtPreview,
	fmtResult,
	fmtCall,
	getResultText,
	isApplied,
	buildAppliedText,
	fmtResultMd,
	mkMdTheme,
} from "../../src/edit-render";

const mockTheme = {
	fg: vi.fn((color: string, text: string) => `[${color}]${text}`),
	bold: vi.fn((text: string) => `**${text}**`),
	italic: vi.fn((text: string) => `_${text}_`),
	underline: vi.fn((text: string) => `__${text}__`),
	strikethrough: vi.fn((text: string) => `~~${text}~~`),
};

describe("getPreviewInput", () => {
	it("returns null for non-record input", () => {
		expect(getPreviewInput("string")).toBeNull();
		expect(getPreviewInput(null)).toBeNull();
		expect(getPreviewInput(42)).toBeNull();
	});

	it("accepts null path for anchor-based inference", () => {
		const result = getPreviewInput({
			path: null,
			edits: [["AAA", "BBB", "new"]],
		});
		expect(result?.path).toBeNull();
		expect(result?.edits.length).toBe(1);
	});

	it("returns null for record with non-string path", () => {
		expect(getPreviewInput({ path: 42 })).toBeNull();
	});

	it("returns null for record without edits", () => {
		expect(getPreviewInput({ path: "test.txt" })).toBeNull();
		expect(getPreviewInput({ path: "test.txt", edits: [] })).toBeNull();
	});

	it("normalizes valid payload input", () => {
		const result = getPreviewInput({
			path: "test.txt",
			edits: [
				["AAA", "BBB", "new"],
				["CCC", "DDD", ""],
			],
		});
		expect(result).toEqual({
			path: "test.txt",
			edits: [
				{ remove_from: "AAA", remove_to: "BBB", replacement_text: "new" },
				{ remove_from: "CCC", remove_to: "DDD", replacement_text: "" },
			],
		});
	});
});

describe("colorLines", () => {
	it("colors addition lines green", () => {
		const lines = ["+added line"];
		const result = colorLines(lines, mockTheme);
		expect(result[0]).toContain("[success]");
	});

	it("colors removal lines red", () => {
		const lines = ["-removed line"];
		const result = colorLines(lines, mockTheme);
		expect(result[0]).toContain("[error]");
	});

	it("colors context lines dim", () => {
		const lines = [" context line"];
		const result = colorLines(lines, mockTheme);
		expect(result[0]).toContain("[dim]");
	});

	it("does not color +++ or --- lines", () => {
		const lines = ["+++header+++", "---header---"];
		const result = colorLines(lines, mockTheme);
		expect(result[0]).toContain("[dim]");
		expect(result[1]).toContain("[dim]");
	});
});

describe("fmtPreview", () => {
	it("truncates long diffs", () => {
		const lines = Array.from({ length: 50 }, (_, i) => ` line ${i}`);
		const diff = lines.join("\n");
		const result = fmtPreview(diff, false, mockTheme);
		expect(result).toContain("more diff lines");
	});

	it("shows all lines when expanded", () => {
		const lines = Array.from({ length: 30 }, (_, i) => ` line ${i}`);
		const diff = lines.join("\n");
		const result = fmtPreview(diff, true, mockTheme);
		expect(result).not.toContain("more diff lines");
	});
});

describe("fmtResult", () => {
	it("formats diff with colors", () => {
		const diff = "+added\n-removed\n context";
		const result = fmtResult(diff, mockTheme);
		expect(result).toContain("[success]");
		expect(result).toContain("[error]");
		expect(result).toContain("[dim]");
	});
});

describe("fmtCall", () => {
	it("formats call with path", () => {
		const args = { path: "test.txt", edits: [{ remove_from: "AAA", remove_to: "BBB", replacement_text: "new" }] };
		const state = { preview: undefined };
		const result = fmtCall(args, state, false, mockTheme);
		expect(result).toContain("test.txt");
	});

	it("formats call with error preview", () => {
		const args = { path: "test.txt", edits: [{ remove_from: "AAA", remove_to: "BBB", replacement_text: "new" }] };
		const state = { preview: { error: "test error" } };
		const result = fmtCall(args, state, false, mockTheme);
		expect(result).toContain("test error");
	});

	it("formats call with diff preview", () => {
		const args = { path: "test.txt", edits: [{ remove_from: "AAA", remove_to: "BBB", replacement_text: "new" }] };
		const state = { preview: { diff: "+added\n-removed" } };
		const result = fmtCall(args, state, false, mockTheme);
		expect(result).toContain("+added");
	});

	it("handles undefined args", () => {
		const state = { preview: undefined };
		const result = fmtCall(null, state, false, mockTheme);
		expect(result).toContain("...");
	});
});

describe("getResultText", () => {
	it("extracts text content", () => {
		const result = {
			content: [
				{ type: "image", data: "base64" },
				{ type: "text", text: "hello" },
			],
		};
		expect(getResultText(result)).toBe("hello");
	});

	it("returns undefined for no text content", () => {
		const result = {
			content: [{ type: "image", data: "base64" }],
		};
		expect(getResultText(result)).toBeUndefined();
	});

	it("returns undefined for empty content", () => {
		expect(getResultText({})).toBeUndefined();
	});
});

describe("isApplied", () => {
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
		expect(isApplied(details)).toBe(true);
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
		expect(isApplied(details)).toBe(false);
	});

	it("returns false for undefined details", () => {
		expect(isApplied({ diff: "" })).toBe(false);
	});

	it("returns false for missing metrics", () => {
		expect(isApplied({ diff: "" })).toBe(false);
	});
});

describe("buildAppliedText", () => {
	it("builds text with diff and warnings", () => {
		const details = {
			diff: "+added\n-removed",
			warnings: ["Warning 1"],
			metrics: {
				classification: "applied" as const,
				edits_attempted: 1,
				edits_noop: 0,
				warnings: 1,
				added_lines: 1,
				removed_lines: 1,
			},
		};
		const result = buildAppliedText(details, mockTheme);
		expect(result).toContain("[success]");
		expect(result).toContain("Warning 1");
	});

	it("returns undefined for no content", () => {
		const result = buildAppliedText(undefined, mockTheme);
		expect(result).toBeUndefined();
	});
});

describe("fmtResultMd", () => {
	it("keeps plain text unchanged", () => {
		const text = "Just plain text";
		expect(fmtResultMd(text)).toBe("Just plain text");
	});

	it("trims leading and trailing empty lines", () => {
		const text = "\n\nNo changes made to x\nClassification: noop\n\n";
		expect(fmtResultMd(text)).toBe(
			"No changes made to x\nClassification: noop",
		);
	});

	it("keeps interior blank lines", () => {
		const text = "Summary\n\nWarning 1";
		expect(fmtResultMd(text)).toBe("Summary\n\nWarning 1");
	});
});

describe("mkMdTheme", () => {
	it("creates theme with all properties", () => {
		const theme = mkMdTheme(mockTheme);
		expect(theme.heading).toBeDefined();
		expect(theme.link).toBeDefined();
		expect(theme.code).toBeDefined();
		expect(theme.codeBlock).toBeDefined();
		expect(theme.bold).toBeDefined();
		expect(theme.highlightCode).toBeDefined();
	});

	it("highlightCode handles diff language", () => {
		const theme = mkMdTheme(mockTheme);
		const result = theme.highlightCode("+added\n-removed\n context", "diff");
		expect(result.length).toBe(3);
	});

	it("highlightCode handles non-diff language", () => {
		const theme = mkMdTheme(mockTheme);
		const result = theme.highlightCode("const x = 1;", "javascript");
		expect(result.length).toBe(1);
	});
});
