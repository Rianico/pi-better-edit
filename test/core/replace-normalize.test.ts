import { describe, expect, it } from "vitest";
import { normReq } from "../../src/edit-normalize";

describe("normReq", () => {
	it("returns non-objects as-is for runtime validation", () => {
		expect(normReq("string")).toBe("string");
		expect(normReq(null)).toBe(null);
		expect(normReq({ file: "test.txt" })).toEqual({ file: "test.txt" });
	});

	it("normalizes the exact { file, edits } shape", () => {
		expect(
			normReq({ file: "src/main.ts", edits: [["aB3", "cD4", "new"]] }),
		).toMatchObject({
			file: "src/main.ts",
			edits: [
				{
					anchor_from: "aB3",
					anchor_to: "cD4",
					replace_with: "new",
				},
			],
		});
	});

	it("preserves null file for anchor-based inference", () => {
		expect(normReq({ file: null, edits: [["aB3", "cD4", "new"]] })).toMatchObject({
			file: null,
			edits: [
				{
					anchor_from: "aB3",
					anchor_to: "cD4",
					replace_with: "new",
				},
			],
		});
	});

	it("does not normalize malformed payloads", () => {
		const malformed = { file: "test.txt", edits: [["aB3"], "new"] };
		expect(normReq(malformed)).toBe(malformed);
		expect(normReq({ file: "test.txt", edits: [] })).toEqual({
			file: "test.txt",
			edits: [],
		});
	});

	it("does not mutate input", () => {
		const input = { file: "test.txt", edits: [["aB3", "cD4", "new"]] };
		normReq(input);
		expect(input).toEqual({ file: "test.txt", edits: [["aB3", "cD4", "new"]] });
	});
});
