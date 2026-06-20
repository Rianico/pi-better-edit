import { describe, expect, it } from "vitest";
import { normalizeReplaceRequest } from "../../src/replace-normalize";

describe("normalizeReplaceRequest", () => {
	it("returns non-record input as-is", () => {
		expect(normalizeReplaceRequest("string")).toBe("string");
		expect(normalizeReplaceRequest(null)).toBe(null);
		expect(normalizeReplaceRequest(42)).toBe(42);
		expect(normalizeReplaceRequest(undefined)).toBe(undefined);
	});

	it("normalizes file_path to path", () => {
		const input = { file_path: "test.txt", edits: [] };
		const result = normalizeReplaceRequest(input) as Record<string, unknown>;
		expect(result.path).toBe("test.txt");
		expect(result.file_path).toBeUndefined();
	});

	it("does not overwrite existing path with file_path", () => {
		const input = { path: "original.txt", file_path: "alias.txt", edits: [] };
		const result = normalizeReplaceRequest(input) as Record<string, unknown>;
		expect(result.path).toBe("original.txt");
	});

	it("coerces edits JSON string to array", () => {
		const edits = [{ old_range: ["AAA", "BBB"], new_lines: ["new"] }];
		const input = { path: "test.txt", edits: JSON.stringify(edits) };
		const result = normalizeReplaceRequest(input) as Record<string, unknown>;
		expect(Array.isArray(result.edits)).toBe(true);
		expect(result.edits).toEqual(edits);
	});

	it("returns edits as-is if already array", () => {
		const edits = [{ old_range: ["AAA", "BBB"], new_lines: ["new"] }];
		const input = { path: "test.txt", edits };
		const result = normalizeReplaceRequest(input) as Record<string, unknown>;
		expect(result.edits).toBe(edits);
	});

	it("returns edits as-is if not valid JSON", () => {
		const input = { path: "test.txt", edits: "not json" };
		const result = normalizeReplaceRequest(input) as Record<string, unknown>;
		expect(result.edits).toBe("not json");
	});

	it("returns edits as-is if JSON is not array", () => {
		const input = { path: "test.txt", edits: '{"key": "value"}' };
		const result = normalizeReplaceRequest(input) as Record<string, unknown>;
		expect(result.edits).toBe('{"key": "value"}');
	});

	it("preserves other fields", () => {
		const input = { path: "test.txt", edits: [], custom: "value" };
		const result = normalizeReplaceRequest(input) as Record<string, unknown>;
		expect(result.custom).toBe("value");
	});
});