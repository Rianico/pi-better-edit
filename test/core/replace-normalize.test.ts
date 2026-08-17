import { describe, expect, it } from "vitest";
import { normReq } from "../../src/edit-normalize";

describe("normReq", () => {
	it("returns non-tuples as-is for runtime validation", () => {
		expect(normReq("string")).toBe("string");
		expect(normReq(null)).toBe(null);
		expect(normReq({ path: "test.txt" })).toEqual({ path: "test.txt" });
	});

	it("normalizes the exact tuple shape", () => {
		expect(normReq(["src/main.ts", ["aB3", "cD4"], "new"])).toMatchObject({
			path: "src/main.ts",
			remove_from: "aB3",
			remove_to: "cD4",
			replacement_text: "new",
		});
	});

	it("preserves null path for anchor-based inference", () => {
		expect(normReq([null, ["aB3", "cD4"], "new"])).toMatchObject({
			path: null,
			remove_from: "aB3",
			remove_to: "cD4",
			replacement_text: "new",
		});
	});

	it("does not normalize malformed tuples", () => {
		const malformed = ["test.txt", ["aB3"], "new"];
		expect(normReq(malformed)).toBe(malformed);
	});

	it("does not mutate tuple input", () => {
		const input: unknown[] = ["test.txt", ["aB3", "cD4"], "new"];
		normReq(input);
		expect(input).toEqual(["test.txt", ["aB3", "cD4"], "new"]);
	});
});
