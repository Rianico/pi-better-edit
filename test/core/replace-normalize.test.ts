import { describe, expect, it } from "vitest";
import { normReq } from "../../src/replace-normalize";

describe("normReq", () => {
	it("returns non-record input as-is", () => {
		expect(normReq("string")).toBe("string");
		expect(normReq(null)).toBe(null);
		expect(normReq(42)).toBe(42);
		expect(normReq(undefined)).toBe(undefined);
	});

	it("returns object input unchanged when no normalization needed", () => {
		const input = {
			path: "src/main.ts",
			edits: [{ start: "aB3x", end: "aB3x", lines: ["new"] }],
		};
		const result = normReq(input);
		expect(result).toEqual(input);
	});

	it("normalizes file_path to path", () => {
		const input = { file_path: "test.txt", edits: [] };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("test.txt");
		expect(result.file_path).toBeUndefined();
	});

	it("does not overwrite existing path with file_path", () => {
		const input = { path: "original.txt", file_path: "alias.txt", edits: [] };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("original.txt");
	});

	it("ignores file_path when path is already a string", () => {
		const input = {
			path: "src/main.ts",
			file_path: "other.ts",
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/main.ts");
		expect(result.file_path).toBe("other.ts");
	});

	it("coerces edits JSON string to array", () => {
		const edits = [{ hash_range_incl: ["AAA", "BBB"], new_lines: ["new"] }];
		const input = { path: "test.txt", edits: JSON.stringify(edits) };
		const result = normReq(input) as Record<string, unknown>;
		expect(Array.isArray(result.edits)).toBe(true);
		expect(result.edits).toEqual(edits);
	});

	it("returns edits as-is if already array", () => {
		const edits = [{ hash_range_incl: ["AAA", "BBB"], new_lines: ["new"] }];
		const input = { path: "test.txt", edits };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.edits).toEqual(edits);
	});

	it("returns edits as-is if not valid JSON", () => {
		const input = { path: "test.txt", edits: "not json" };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.edits).toBe("not json");
	});

	it("returns edits as-is if JSON is not array", () => {
		const input = { path: "test.txt", edits: '{"key": "value"}' };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.edits).toBe('{"key": "value"}');
	});

	it("handles both file_path and JSON-string edits together", () => {
		const editsArray = [
			{ start: "aB3x", end: "aB3x", lines: ["line1"] },
		];
		const input = {
			file_path: "src/main.ts",
			edits: JSON.stringify(editsArray),
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/main.ts");
		expect(result.file_path).toBeUndefined();
		expect(Array.isArray(result.edits)).toBe(true);
		expect(result.edits).toEqual(editsArray);
	});

	it("preserves other fields", () => {
		const input = { path: "test.txt", edits: [], custom: "value" };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.custom).toBe("value");
	});

	it("does not mutate the original input", () => {
		const input = {
			file_path: "src/main.ts",
			edits: JSON.stringify([{ start: "aB3x", end: "aB3x", lines: ["x"] }]),
		};
		const originalFilePath = input.file_path;
		const originalEdits = input.edits;
		normReq(input);
		expect(input.file_path).toBe(originalFilePath);
		expect(input.edits).toBe(originalEdits);
	});
});

describe("normReq — new_lines JSON string coercion", () => {
	it("coerces JSON-string new_lines to array", () => {
		const input = {
			path: "test.txt",
			edits: [{ hash_range_incl: ["AAA", "BBB"], new_lines: JSON.stringify(["line1", "line2"]) }],
		};
		const result = normReq(input) as Record<string, unknown>;
		const edits = result.edits as Array<Record<string, unknown>>;
		expect(Array.isArray(edits[0]!.new_lines)).toBe(true);
		expect(edits[0]!.new_lines).toEqual(["line1", "line2"]);
	});

	it("leaves array new_lines unchanged", () => {
		const input = {
			path: "test.txt",
			edits: [{ hash_range_incl: ["AAA", "BBB"], new_lines: ["line1", "line2"] }],
		};
		const result = normReq(input) as Record<string, unknown>;
		const edits = result.edits as Array<Record<string, unknown>>;
		expect(edits[0]!.new_lines).toEqual(["line1", "line2"]);
	});

	it("leaves non-JSON string new_lines as-is for downstream validation", () => {
		const input = {
			path: "test.txt",
			edits: [{ hash_range_incl: ["AAA", "BBB"], new_lines: "not json" }],
		};
		const result = normReq(input) as Record<string, unknown>;
		const edits = result.edits as Array<Record<string, unknown>>;
		expect(typeof edits[0]!.new_lines).toBe("string");
		expect(edits[0]!.new_lines).toBe("not json");
	});

	it("coerces new_lines in all edits", () => {
		const input = {
			path: "test.txt",
			edits: [
				{ hash_range_incl: ["AAA", "BBB"], new_lines: JSON.stringify(["a"]) },
				{ hash_range_incl: ["CCC", "DDD"], new_lines: JSON.stringify(["b", "c"]) },
			],
		};
		const result = normReq(input) as Record<string, unknown>;
		const edits = result.edits as Array<Record<string, unknown>>;
		expect(edits[0]!.new_lines).toEqual(["a"]);
		expect(edits[1]!.new_lines).toEqual(["b", "c"]);
	});

	it("coerces new_lines when edits was also a JSON string", () => {
		const editsPayload = [
			{ hash_range_incl: ["AAA", "BBB"], new_lines: JSON.stringify(["x"]) },
		];
		const input = { path: "test.txt", edits: JSON.stringify(editsPayload) };
		const result = normReq(input) as Record<string, unknown>;
		const edits = result.edits as Array<Record<string, unknown>>;
		expect(Array.isArray(edits)).toBe(true);
		expect(edits[0]!.new_lines).toEqual(["x"]);
	});

	it("does not mutate the original input's new_lines", () => {
		const newLinesStr = JSON.stringify(["a", "b"]);
		const input = {
			path: "test.txt",
			edits: [{ hash_range_incl: ["AAA", "BBB"], new_lines: newLinesStr }],
		};
		const originalNewLines = input.edits[0]!.new_lines;
		normReq(input);
		expect(input.edits[0]!.new_lines).toBe(originalNewLines);
	});
});
