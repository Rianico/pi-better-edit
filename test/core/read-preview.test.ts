import { describe, expect, it } from "vitest";
import { fmtReadPreview } from "../../src/read";

describe("fmtReadPreview", () => {
	it("returns empty file message for empty content", () => {
		const result = fmtReadPreview("", {});
		expect(result.text).toBe("File is empty. Use edit to insert content.");
	});

	it("returns offset beyond end message for empty file with offset", () => {
		const result = fmtReadPreview("", { offset: 5 });
		expect(result.text).toContain("Offset 5 is beyond end of file (0 lines total)");
	});

	it("returns offset beyond end message for non-empty file", () => {
		const result = fmtReadPreview("line1\nline2\n", { offset: 10 });
		expect(result.text).toContain("Offset 10 is beyond end of file (2 lines total)");
	});

	it("returns preview with hash anchors", () => {
		const result = fmtReadPreview("line1\nline2\n", {});
		expect(result.text).toContain("│line1");
		expect(result.text).toContain("│line2");
	});

	it("handles offset parameter", () => {
		const result = fmtReadPreview("line1\nline2\nline3\n", { offset: 2 });
		expect(result.text).toContain("│line2");
		expect(result.text).toContain("│line3");
		expect(result.text).not.toContain("│line1");
	});

	it("handles limit parameter", () => {
		const result = fmtReadPreview("line1\nline2\nline3\n", { limit: 2 });
		expect(result.text).toContain("│line1");
		expect(result.text).toContain("│line2");
		expect(result.text).not.toContain("│line3");
	});

	it("handles offset and limit together", () => {
		const result = fmtReadPreview("line1\nline2\nline3\nline4\n", { offset: 2, limit: 2 });
		expect(result.text).toContain("│line2");
		expect(result.text).toContain("│line3");
		expect(result.text).not.toContain("│line1");
		expect(result.text).not.toContain("│line4");
	});

	it("returns nextOffset when truncated by limit", () => {
		const result = fmtReadPreview("line1\nline2\nline3\n", { limit: 2 });
		expect(result.nextOffset).toBe(3);
	});

	it("returns pagination hint when truncated", () => {
		const result = fmtReadPreview("line1\nline2\nline3\n", { limit: 2 });
		expect(result.text).toContain("Use offset=3 to continue");
	});

	it("throws for invalid offset", () => {
		expect(() => fmtReadPreview("line1\n", { offset: 0 })).toThrow("must be a positive integer");
		expect(() => fmtReadPreview("line1\n", { offset: -1 })).toThrow("must be a positive integer");
	});

	it("throws for invalid limit", () => {
		expect(() => fmtReadPreview("line1\n", { limit: 0 })).toThrow("must be a positive integer");
		expect(() => fmtReadPreview("line1\n", { limit: -1 })).toThrow("must be a positive integer");
	});

	it("uses precomputed hashes when provided", () => {
		const precomputed = ["AAA", "BBB"];
		const result = fmtReadPreview("line1\nline2\n", {}, precomputed);
		expect(result.text).toContain("AAA│line1");
		expect(result.text).toContain("BBB│line2");
	});

	it("handles single line file", () => {
		const result = fmtReadPreview("single line\n", {});
		expect(result.text).toContain("│single line");
		expect(result.truncation).toBeUndefined();
	});

	it("handles file without trailing newline", () => {
		const result = fmtReadPreview("line1\nline2", {});
		expect(result.text).toContain("│line1");
		expect(result.text).toContain("│line2");
	});
});