import { describe, expect, it } from "vitest";
import { normReq } from "../../src/replace-normalize";

describe("normReq", () => {
	it("returns non-object input unchanged", () => {
		expect(normReq(null)).toBe(null);
		expect(normReq(undefined)).toBe(undefined);
		expect(normReq("string")).toBe("string");
		expect(normReq(42)).toBe(42);
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
		const input = {
			file_path: "src/main.ts",
			edits: [{ start: "aB3x", end: "aB3x", lines: ["new"] }],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/main.ts");
		expect(result.file_path).toBeUndefined();
	});

	it("prefers path over file_path when both present", () => {
		const input = {
			path: "src/real.ts",
			file_path: "src/alias.ts",
			edits: [{ start: "aB3x", end: "aB3x", lines: ["new"] }],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/real.ts");
		// file_path is not deleted because path is already a string
		expect(result.file_path).toBe("src/alias.ts");
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

	it("coerces JSON-string edits to array", () => {
		const editsArray = [
			{ start: "aB3x", end: "aB3x", lines: ["new"] },
		];
		const input = {
			path: "src/main.ts",
			edits: JSON.stringify(editsArray),
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(Array.isArray(result.edits)).toBe(true);
		expect(result.edits).toEqual(editsArray);
	});

	it("returns edits unchanged when already an array", () => {
		const editsArray = [
			{ start: "aB3x", end: "aB3x", lines: ["new"] },
		];
		const input = {
			path: "src/main.ts",
			edits: editsArray,
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.edits).toBe(editsArray);
	});

	it("returns JSON-string edits unchanged when not valid JSON array", () => {
		const input = {
			path: "src/main.ts",
			edits: "not valid json",
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.edits).toBe("not valid json");
	});

	it("returns JSON-string edits unchanged when JSON is not an array", () => {
		const input = {
			path: "src/main.ts",
			edits: '{"key": "value"}',
		};
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

	it("preserves other fields during normalization", () => {
		const input = {
			file_path: "src/main.ts",
			edits: [{ start: "aB3x", end: "aB3x", lines: ["x"] }],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/main.ts");
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
