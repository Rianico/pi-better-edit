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

	it("coerces edits JSON string to array", () => {
		const changes = [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] }];
		const input = { path: "test.txt", changes: JSON.stringify(changes) };
		const result = normReq(input) as Record<string, unknown>;
		expect(Array.isArray(result.changes)).toBe(true);
		expect(result.changes).toEqual(changes);
	});

	it("returns edits as-is if already array", () => {
		const changes = [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] }];
		const input = { path: "test.txt", edits: changes };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.changes).toEqual(changes);
	});

	it("returns edits as-is if not valid JSON", () => {
		const input = { path: "test.txt", changes: "not json" };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.changes).toBe("not json");
	});

	it("wraps a JSON-string single change object in an array", () => {
		const input = {
			path: "test.txt",
			changes: JSON.stringify({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] }),
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(Array.isArray(result.changes)).toBe(true);
		expect(result.changes).toHaveLength(1);
		const change = (result.changes as Array<Record<string, unknown>>)[0]!;
		expect(change.hash_range_inclusive).toEqual(["AAA", "BBB"]);
		expect(change.content_lines).toEqual(["new"]);
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

	it("wraps a JSON-string single edit object from edits field", () => {
		const input = {
			path: "test.txt",
			edits: JSON.stringify({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] }),
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(Array.isArray(result.changes)).toBe(true);
		expect(result.changes).toHaveLength(1);
		expect(result.edits).toBeUndefined();
		const change = (result.changes as Array<Record<string, unknown>>)[0]!;
		expect(change.hash_range_inclusive).toEqual(["AAA", "BBB"]);
		expect(change.content_lines).toEqual(["new"]);
	});

	it("wraps a literal single edit object from edits field", () => {
		const input = {
			path: "test.txt",
			edits: { hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] },
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(Array.isArray(result.changes)).toBe(true);
		expect(result.changes).toHaveLength(1);
		expect(result.edits).toBeUndefined();
		const change = (result.changes as Array<Record<string, unknown>>)[0]!;
		expect(change.hash_range_inclusive).toEqual(["AAA", "BBB"]);
		expect(change.content_lines).toEqual(["new"]);
	});
	it("handles both file_path and JSON-string edits together", () => {
		const changesArray = [
			{ start: "aB3x", end: "aB3x", lines: ["line1"] },
		];
		const input = {
			file_path: "src/main.ts",
			changes: JSON.stringify(changesArray),
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/main.ts");
		expect(result.file_path).toBeUndefined();
		expect(Array.isArray(result.changes)).toBe(true);
		expect(result.changes).toEqual(changesArray);
	});

	it("preserves other fields", () => {
		const input = { path: "test.txt", changes: [], custom: "value" };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.custom).toBe("value");
	});

	it("does not mutate the original input", () => {
		const input = {
			file_path: "src/main.ts",
			changes: JSON.stringify([{ start: "aB3x", end: "aB3x", lines: ["x"] }]),
		};
		const originalFilePath = input.file_path;
		const originalChanges = input.changes;
		normReq(input);
		expect(input.file_path).toBe(originalFilePath);
		expect(input.changes).toBe(originalChanges);
	});
});

describe("normReq — content_lines JSON string coercion", () => {
	it("coerces JSON-string content_lines to array", () => {
		const input = {
			path: "test.txt",
			changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: JSON.stringify(["line1", "line2"]) }],
		};
		const result = normReq(input) as Record<string, unknown>;
		const changes = result.changes as Array<Record<string, unknown>>;
		expect(Array.isArray(changes[0]!.content_lines)).toBe(true);
		expect(changes[0]!.content_lines).toEqual(["line1", "line2"]);
	});

	it("leaves array content_lines unchanged", () => {
		const input = {
			path: "test.txt",
			changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["line1", "line2"] }],
		};
		const result = normReq(input) as Record<string, unknown>;
		const changes = result.changes as Array<Record<string, unknown>>;
		expect(changes[0]!.content_lines).toEqual(["line1", "line2"]);
	});

	it("leaves non-JSON string content_lines as-is for downstream validation", () => {
		const input = {
			path: "test.txt",
			changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: "not json" }],
		};
		const result = normReq(input) as Record<string, unknown>;
		const changes = result.changes as Array<Record<string, unknown>>;
		expect(typeof changes[0]!.content_lines).toBe("string");
		expect(changes[0]!.content_lines).toBe("not json");
	});

	it("coerces content_lines in all edits", () => {
		const input = {
			path: "test.txt",
			changes: [
				{ hash_range_inclusive: ["AAA", "BBB"], content_lines: JSON.stringify(["a"]) },
				{ hash_range_inclusive: ["CCC", "DDD"], content_lines: JSON.stringify(["b", "c"]) },
			],
		};
		const result = normReq(input) as Record<string, unknown>;
		const changes = result.changes as Array<Record<string, unknown>>;
		expect(changes[0]!.content_lines).toEqual(["a"]);
		expect(changes[1]!.content_lines).toEqual(["b", "c"]);
	});

	it("coerces content_lines when edits was also a JSON string", () => {
		const changesPayload = [
			{ hash_range_inclusive: ["AAA", "BBB"], content_lines: JSON.stringify(["x"]) },
		];
		const input = { path: "test.txt", changes: JSON.stringify(changesPayload) };
		const result = normReq(input) as Record<string, unknown>;
		const changes = result.changes as Array<Record<string, unknown>>;
		expect(Array.isArray(changes)).toBe(true);
		expect(changes[0]!.content_lines).toEqual(["x"]);
	});

	it("does not mutate the original input's content_lines", () => {
		const newLinesStr = JSON.stringify(["a", "b"]);
		const input = {
			path: "test.txt",
			changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: newLinesStr }],
		};
		const originalNewLines = input.changes[0]!.content_lines;
		normReq(input);
		expect(input.changes[0]!.content_lines).toBe(originalNewLines);
	});
});

describe("normReq — change item JSON string coercion", () => {
	it("coerces JSON-string change items to objects", () => {
		const input = {
			path: "test.txt",
			changes: [JSON.stringify({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["line1"] })],
		};
		const result = normReq(input) as Record<string, unknown>;
		const changes = result.changes as Array<Record<string, unknown>>;
		expect(Array.isArray(changes)).toBe(true);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toEqual({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["line1"] });
	});

	it("coerces multiple JSON-string change items", () => {
		const input = {
			path: "test.txt",
			changes: [
				JSON.stringify({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["a"] }),
				JSON.stringify({ hash_range_inclusive: ["CCC", "DDD"], content_lines: ["b", "c"] }),
			],
		};
		const result = normReq(input) as Record<string, unknown>;
		const changes = result.changes as Array<Record<string, unknown>>;
		expect(changes).toHaveLength(2);
		expect(changes[0]).toEqual({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["a"] });
		expect(changes[1]).toEqual({ hash_range_inclusive: ["CCC", "DDD"], content_lines: ["b", "c"] });
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

	it("leaves object items unchanged", () => {
		const input = {
			path: "test.txt",
			changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["line1"] }],
		};
		const result = normReq(input) as Record<string, unknown>;
		const changes = result.changes as Array<Record<string, unknown>>;
		expect(changes[0]).toEqual({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["line1"] });
	});

	it("coerces JSON-string items when edits was also a JSON string", () => {
		const changesPayload = [
			JSON.stringify({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["x"] }),
		];
		const input = { path: "test.txt", changes: JSON.stringify(changesPayload) };
		const result = normReq(input) as Record<string, unknown>;
		const changes = result.changes as Array<Record<string, unknown>>;
		expect(Array.isArray(changes)).toBe(true);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toEqual({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["x"] });
	});

	it("coerces JSON-string items with JSON-string content_lines", () => {
		const input = {
			path: "test.txt",
			changes: [
				JSON.stringify({ hash_range_inclusive: ["AAA", "BBB"], content_lines: JSON.stringify(["a", "b"]) }),
			],
		};
		const result = normReq(input) as Record<string, unknown>;
		const changes = result.changes as Array<Record<string, unknown>>;
		expect(changes).toHaveLength(1);
		expect(changes[0]).toEqual({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["a", "b"] });
	});

	it("does not mutate the original input's change items", () => {
		const itemStr = JSON.stringify({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["x"] });
		const input = {
			path: "test.txt",
			changes: [itemStr],
		};
		const originalItem = input.changes[0];
		normReq(input);
		expect(input.changes[0]).toBe(originalItem);
	});
});
