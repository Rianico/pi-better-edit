import { describe, expect, it } from "vitest";
import { normReq } from "../../src/edit-normalize";

describe("normReq", () => {
	it("returns non-objects as-is for runtime validation", () => {
		expect(normReq("string")).toBe("string");
		expect(normReq(null)).toBe(null);
		expect(normReq({ path: "test.txt" })).toEqual({ path: "test.txt" });
	});

	it("normalizes the exact { path, edits } shape", () => {
		expect(
			normReq({ path: "src/main.ts", edits: [["aB3", "cD4", "new"]] }),
		).toMatchObject({
			path: "src/main.ts",
			edits: [
				{
					remove_from: "aB3",
					remove_to: "cD4",
					replacement_text: "new",
				},
			],
		});
	});

	it("preserves null path for anchor-based inference", () => {
		expect(normReq({ path: null, edits: [["aB3", "cD4", "new"]] })).toMatchObject({
			path: null,
			edits: [
				{
					remove_from: "aB3",
					remove_to: "cD4",
					replacement_text: "new",
				},
			],
		});
	});

	it("does not normalize malformed payloads", () => {
		const malformed = { path: "test.txt", edits: [["aB3"], "new"] };
		expect(normReq(malformed)).toBe(malformed);
		expect(normReq({ path: "test.txt", edits: [] })).toEqual({
			path: "test.txt",
			edits: [],
		});
	});

	it("does not mutate input", () => {
		const input = { path: "test.txt", edits: [["aB3", "cD4", "new"]] };
		normReq(input);
		expect(input).toEqual({ path: "test.txt", edits: [["aB3", "cD4", "new"]] });
	});
});
