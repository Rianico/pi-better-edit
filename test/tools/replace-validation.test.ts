import { describe, expect, it } from "vitest";
import { assertReplaceRequest } from "../../src/replace";

describe("assertReplaceRequest", () => {
	it("throws for non-record input", () => {
		expect(() => assertReplaceRequest("string")).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReplaceRequest(null)).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReplaceRequest(42)).toThrow("[E_BAD_SHAPE]");
	});

	it("throws for legacy shape with oldText", () => {
		expect(() => assertReplaceRequest({ path: "test.txt", oldText: "old", newText: "new" }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with newText", () => {
		expect(() => assertReplaceRequest({ path: "test.txt", newText: "new" }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with old_text", () => {
		expect(() => assertReplaceRequest({ path: "test.txt", old_text: "old" }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with new_text", () => {
		expect(() => assertReplaceRequest({ path: "test.txt", new_text: "new" }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with start", () => {
		expect(() => assertReplaceRequest({ path: "test.txt", start: 1 }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with end", () => {
		expect(() => assertReplaceRequest({ path: "test.txt", end: 5 }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with lines", () => {
		expect(() => assertReplaceRequest({ path: "test.txt", lines: ["line1"] }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for unknown fields", () => {
		expect(() => assertReplaceRequest({ path: "test.txt", edits: [], unknown: "field" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for missing path", () => {
		expect(() => assertReplaceRequest({ edits: [] }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for empty path", () => {
		expect(() => assertReplaceRequest({ path: "", edits: [] }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for non-string path", () => {
		expect(() => assertReplaceRequest({ path: 42, edits: [] }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for non-array edits", () => {
		expect(() => assertReplaceRequest({ path: "test.txt", edits: "not array" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("does not throw for valid request", () => {
		expect(() => assertReplaceRequest({
			path: "test.txt",
			edits: [{ old_range: ["AAA", "BBB"], new_lines: ["new"] }],
		})).not.toThrow();
	});

	it("does not throw for request without edits", () => {
		expect(() => assertReplaceRequest({ path: "test.txt" })).not.toThrow();
	});
});