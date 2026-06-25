import { describe, expect, it } from "vitest";
import { assertReq } from "../../src/replace";

describe("assertReq", () => {
	it("throws for non-record input", () => {
		expect(() => assertReq("string")).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReq(null)).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReq(42)).toThrow("[E_BAD_SHAPE]");
	});

	it("throws for legacy shape with oldText", () => {
		expect(() => assertReq({ path: "test.txt", oldText: "old", newText: "new" }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with newText", () => {
		expect(() => assertReq({ path: "test.txt", newText: "new" }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with old_text", () => {
		expect(() => assertReq({ path: "test.txt", old_text: "old" }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with new_text", () => {
		expect(() => assertReq({ path: "test.txt", new_text: "new" }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with start", () => {
		expect(() => assertReq({ path: "test.txt", start: 1 }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with end", () => {
		expect(() => assertReq({ path: "test.txt", end: 5 }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with lines", () => {
		expect(() => assertReq({ path: "test.txt", lines: ["line1"] }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for unknown fields", () => {
		expect(() => assertReq({ path: "test.txt", changes: [], unknown: "field" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for missing path", () => {
		expect(() => assertReq({ changes: [] }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for empty path", () => {
		expect(() => assertReq({ path: "", changes: [] }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for non-string path", () => {
		expect(() => assertReq({ path: 42, changes: [] }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for non-array edits", () => {
		expect(() => assertReq({ path: "test.txt", changes: "not array" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("does not throw for valid request", () => {
		expect(() => assertReq({
			path: "test.txt",
			changes: [{ hash_range_incl: ["AAA", "BBB"], content_lines: ["new"] }],
		})).not.toThrow();
	});

	it("throws for request without edits", () => {
		expect(() => assertReq({ path: "test.txt" })).toThrow("[E_BAD_SHAPE]");
	});
});
