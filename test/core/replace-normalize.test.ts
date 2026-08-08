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
			hash_bounds: ["aB3", "aB3"],
			new_content: "new",
		};
		const result = normReq(input);
		expect(result).toEqual(input);
	});

	it("normalizes file_path to path", () => {
		const input = { file_path: "test.txt", hash_bounds: ["AAA", "BBB"], new_content: "new" };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("test.txt");
		expect(result.file_path).toBeUndefined();
	});

	it("does not overwrite existing path with file_path", () => {
		const input = { path: "original.txt", file_path: "alias.txt", hash_bounds: ["AAA", "BBB"], new_content: "new" };
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

	it("preserves other fields", () => {
		const input = { path: "test.txt", hash_bounds: ["AAA", "BBB"], new_content: "new", custom: "value" };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.custom).toBe("value");
	});

	it("does not mutate the original input", () => {
		const input = {
			file_path: "src/main.ts",
			hash_bounds: ["AAA", "BBB"],
			new_content: "x",
		};
		const originalFilePath = input.file_path;
		const originalNewContent = input.new_content;
		normReq(input);
		expect(input.file_path).toBe(originalFilePath);
		expect(input.new_content).toBe(originalNewContent);
	});
});

describe("normReq — top-level shape", () => {
	it("keeps hash_bounds and new_content at top level", () => {
		const input = {
			path: "test.txt",
			hash_bounds: ["AAA", "BBB"],
			new_content: "new line",
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.hash_bounds).toEqual(["AAA", "BBB"]);
		expect(result.new_content).toEqual("new line");
	});

	it("handles flat format with file_path alias", () => {
		const input = {
			file_path: "src/main.ts",
			hash_bounds: ["AAA", "BBB"],
			new_content: "new",
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/main.ts");
		expect(result.hash_bounds).toEqual(["AAA", "BBB"]);
	});

	it("does not mutate the original flat-format input", () => {
		const input = {
			path: "test.txt",
			hash_bounds: ["AAA", "BBB"],
			new_content: "new",
		};
		const origHb = input.hash_bounds;
		const origNc = input.new_content;
		normReq(input);
		expect(input.hash_bounds).toBe(origHb);
		expect(input.new_content).toBe(origNc);
	});
});
