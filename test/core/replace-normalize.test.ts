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
			changes: [{ start: "aB3x", end: "aB3x", lines: ["new"] }],
		};
		const result = normReq(input);
		expect(result).toEqual(input);
	});

	it("normalizes file_path to path", () => {
		const input = { file_path: "test.txt", changes: [] };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("test.txt");
		expect(result.file_path).toBeUndefined();
	});

	it("does not overwrite existing path with file_path", () => {
		const input = { path: "original.txt", file_path: "alias.txt", changes: [] };
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

	it("wraps a literal single change object in an array", () => {
		const input = {
			path: "test.txt",
			changes: { hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] },
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(Array.isArray(result.changes)).toBe(true);
		expect(result.changes).toHaveLength(1);
		const change = (result.changes as Array<Record<string, unknown>>)[0]!;
		expect(change.hash_range_inclusive).toEqual(["AAA", "BBB"]);
		expect(change.content_lines).toEqual(["new"]);
	});

	it("preserves other fields", () => {
		const input = { path: "test.txt", changes: [], custom: "value" };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.custom).toBe("value");
	});

	it("does not mutate the original input", () => {
		const input = {
			file_path: "src/main.ts",
			changes: [{ start: "aB3x", end: "aB3x", lines: ["x"] }],
		};
		const originalFilePath = input.file_path;
		const originalChanges = input.changes;
		normReq(input);
		expect(input.file_path).toBe(originalFilePath);
		expect(input.changes).toBe(originalChanges);
	});
});

describe("normReq — content_lines handling", () => {
	it("leaves array content_lines unchanged", () => {
		const input = {
			path: "test.txt",
			changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["line1", "line2"] }],
		};
		const result = normReq(input) as Record<string, unknown>;
		const changes = result.changes as Array<Record<string, unknown>>;
		expect(changes[0]!.content_lines).toEqual(["line1", "line2"]);
	});

  it("rejects non-JSON string content_lines with clear error", () => {
    const input = {
      path: "test.txt",
      changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: "not json" }],
    };
    expect(() => normReq(input)).toThrow(
      /must be a native JSON array of strings, not a JSON string/,
    );
  });

  it("auto-recovers JSON-string content_lines in changes item", () => {
    const input = {
      path: "test.txt",
      changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: '["line1", "line2"]' }],
    };
    const result = normReq(input) as Record<string, unknown>;
    const changes = result.changes as Array<Record<string, unknown>>;
    expect(changes[0]!.content_lines).toEqual(["line1", "line2"]);
  });

  it("auto-recovers JSON-string content_lines at top level (flat format)", () => {
    const input = {
      path: "test.txt",
      hash_range_inclusive: ["AAA", "BBB"],
      content_lines: '["new line"]'
    };
    const result = normReq(input) as Record<string, unknown>;
    const changes = result.changes as Array<Record<string, unknown>>;
    expect(changes[0]!.content_lines).toEqual(["new line"]);
  });

  it("rejects JSON-string content_lines that parses to non-array", () => {
    const input = {
      path: "test.txt",
      changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: '"just a string"' }],
    };
    expect(() => normReq(input)).toThrow(
      /must be a native JSON array of strings, not a JSON string/,
    );
  });
});
describe("normReq — change item handling", () => {
	it("leaves object items unchanged", () => {
		const input = {
			path: "test.txt",
			changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["line1"] }],
		};
		const result = normReq(input) as Record<string, unknown>;
		const changes = result.changes as Array<Record<string, unknown>>;
		expect(changes[0]).toEqual({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["line1"] });
	});

  it("leaves non-JSON string items as-is for downstream validation", () => {
    const input = {
      path: "test.txt",
      changes: ["not json"],
    };
    const result = normReq(input) as Record<string, unknown>;
    const changes = result.changes as Array<unknown>;
    expect(changes[0]).toBe("not json");
  });

  it("auto-recovers JSON-string changes array", () => {
    const input = {
      path: "test.txt",
      changes: '[{"hash_range_inclusive": ["AAA", "BBB"], "content_lines": ["line1"]}]'
    };
    const result = normReq(input) as Record<string, unknown>;
    const changes = result.changes as Array<Record<string, unknown>>;
    expect(Array.isArray(changes)).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.content_lines).toEqual(["line1"]);
    expect(changes[0]!.hash_range_inclusive).toEqual(["AAA", "BBB"]);
  });

  it("auto-recovers JSON-string single change object", () => {
    const input = {
      path: "test.txt",
      changes: '{"hash_range_inclusive": ["AAA", "BBB"], "content_lines": ["line1"]}'
    };
    const result = normReq(input) as Record<string, unknown>;
    const changes = result.changes as Array<Record<string, unknown>>;
    expect(Array.isArray(changes)).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.content_lines).toEqual(["line1"]);
  });
});

describe("normReq — flat format (top-level hash_range_inclusive / content_lines)", () => {
	it("wraps flat format into a single-element changes array", () => {
		const input = {
			path: "test.txt",
			hash_range_inclusive: ["AAA", "BBB"],
			content_lines: ["new line"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(Array.isArray(result.changes)).toBe(true);
		expect(result.changes).toHaveLength(1);
		const change = (result.changes as Array<Record<string, unknown>>)[0]!;
		expect(change.hash_range_inclusive).toEqual(["AAA", "BBB"]);
		expect(change.content_lines).toEqual(["new line"]);
		expect((result as Record<string, unknown>).hash_range_inclusive).toBeUndefined();
		expect((result as Record<string, unknown>).content_lines).toBeUndefined();
	});

	it("does not wrap when changes array is already present", () => {
		const input = {
			path: "test.txt",
			changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["existing"] }],
			hash_range_inclusive: ["CCC", "DDD"],
			content_lines: ["ignored"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(Array.isArray(result.changes)).toBe(true);
		expect(result.changes).toHaveLength(1);
		const change = (result.changes as Array<Record<string, unknown>>)[0]!;
		expect(change.hash_range_inclusive).toEqual(["AAA", "BBB"]);
		expect(change.content_lines).toEqual(["existing"]);
	});

	it("handles flat format with file_path alias", () => {
		const input = {
			file_path: "src/main.ts",
			hash_range_inclusive: ["AAA", "BBB"],
			content_lines: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/main.ts");
		expect(Array.isArray(result.changes)).toBe(true);
		expect(result.changes).toHaveLength(1);
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

	it("does not wrap when hash_range_inclusive is not an array", () => {
		const input = {
			path: "test.txt",
			hash_range_inclusive: "not-an-array",
			content_lines: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.changes).toBeUndefined();
		expect(result.hash_range_inclusive).toBe("not-an-array");
	});

  it("rejects non-JSON string content_lines in flat format with clear error", () => {
    const input = {
      path: "test.txt",
      hash_range_inclusive: ["AAA", "BBB"],
      content_lines: "not-an-array",
    };
    expect(() => normReq(input)).toThrow(
      /must be a native JSON array of strings, not a JSON string/,
    );
  });

	it("does not wrap when only hash_range_inclusive is present (no content_lines)", () => {
		const input = {
			path: "test.txt",
			hash_range_inclusive: ["AAA", "BBB"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.changes).toBeUndefined();
	});

	it("does not wrap when only content_lines is present (no hash_range_inclusive)", () => {
		const input = {
			path: "test.txt",
			content_lines: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.changes).toBeUndefined();
	});
});
