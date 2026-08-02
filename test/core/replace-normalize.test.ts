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
			hash_range_inclusive: ["aB3", "aB3"],
			content_lines: ["new"],
		};
		const result = normReq(input);
		expect(result).toEqual(input);
	});

	it("normalizes file_path to path", () => {
		const input = { file_path: "test.txt", hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("test.txt");
		expect(result.file_path).toBeUndefined();
	});

	it("does not overwrite existing path with file_path", () => {
		const input = { path: "original.txt", file_path: "alias.txt", hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] };
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
		const input = { path: "test.txt", hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"], custom: "value" };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.custom).toBe("value");
	});

	it("does not mutate the original input", () => {
		const input = {
			file_path: "src/main.ts",
			hash_range_inclusive: ["AAA", "BBB"],
			content_lines: ["x"],
		};
		const originalFilePath = input.file_path;
		const originalContentLines = input.content_lines;
		normReq(input);
		expect(input.file_path).toBe(originalFilePath);
		expect(input.content_lines).toBe(originalContentLines);
	});
});

describe("normReq — content_lines handling", () => {
	it("leaves array content_lines unchanged", () => {
		const input = {
			path: "test.txt",
			hash_range_inclusive: ["AAA", "BBB"],
			content_lines: ["line1", "line2"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.content_lines).toEqual(["line1", "line2"]);
	});

  it("rejects non-JSON string content_lines with clear error", () => {
    const input = {
      path: "test.txt",
      hash_range_inclusive: ["AAA", "BBB"],
      content_lines: "not json",
    };
    expect(() => normReq(input)).toThrow(
      /must be a native JSON array of strings, not a JSON string/,
    );
  });

  it("auto-recovers JSON-string content_lines at top level", () => {
    const input = {
      path: "test.txt",
      hash_range_inclusive: ["AAA", "BBB"],
      content_lines: '["new line"]'
    };
    const result = normReq(input) as Record<string, unknown>;
    expect(result.content_lines).toEqual(["new line"]);
  });

  it("rejects JSON-string content_lines that parses to non-array", () => {
    const input = {
      path: "test.txt",
      hash_range_inclusive: ["AAA", "BBB"],
      content_lines: '"just a string"'
    };
    expect(() => normReq(input)).toThrow(
      /must be a native JSON array of strings, not a JSON string/,
    );
  });
});

describe("normReq — top-level shape", () => {
	it("keeps hash_range_inclusive and content_lines at top level", () => {
		const input = {
			path: "test.txt",
			hash_range_inclusive: ["AAA", "BBB"],
			content_lines: ["new line"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.hash_range_inclusive).toEqual(["AAA", "BBB"]);
		expect(result.content_lines).toEqual(["new line"]);
		expect(result.changes).toBeUndefined();
	});

	it("handles flat format with file_path alias", () => {
		const input = {
			file_path: "src/main.ts",
			hash_range_inclusive: ["AAA", "BBB"],
			content_lines: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/main.ts");
		expect(result.hash_range_inclusive).toEqual(["AAA", "BBB"]);
	});

	it("does not mutate the original flat-format input", () => {
		const input = {
			path: "test.txt",
			hash_range_inclusive: ["AAA", "BBB"],
			content_lines: ["new"],
		};
		const origHri = input.hash_range_inclusive;
		const origCl = input.content_lines;
		normReq(input);
		expect(input.hash_range_inclusive).toBe(origHri);
		expect(input.content_lines).toBe(origCl);
	});

	it("leaves a changes array untouched for downstream rejection", () => {
		const input = {
			path: "test.txt",
			changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["existing"] }],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.changes).toEqual(input.changes);
	});
});
