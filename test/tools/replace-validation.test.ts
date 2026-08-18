import { describe, expect, it } from "vitest";
import { assertReq, buildToolDef } from "../../src/edit";

describe("assertReq", () => {
	it("throws for non-tuples", () => {
		expect(() => assertReq("string")).toThrow("E_BAD_SHAPE");
		expect(() => assertReq(null)).toThrow("E_BAD_SHAPE");
		expect(() => assertReq({ path: "test.txt" })).toThrow("E_BAD_SHAPE");
	});

	it("rejects the old named-object payload", () => {
		expect(() => assertReq({
			path: "test.txt",
			remove_from: "AAA",
			remove_to: "BBB",
			replacement_text: "new",
		})).toThrow("exactly");
	});

	it("accepts a path and null-path tuple", () => {
		expect(() => assertReq(["test.txt", ["AAA", "BBB"], "new"])).not.toThrow();
		expect(() => assertReq([null, ["AAA", "BBB"], "new"])).not.toThrow();
	});

	it("rejects malformed tuple lengths and member types", () => {
		expect(() => assertReq(["test.txt", ["AAA"], "new"])).toThrow("E_BAD_SHAPE");
		expect(() => assertReq(["test.txt", ["AAA", "BBB"], null])).toThrow("E_BAD_SHAPE");
		expect(() => assertReq(["", ["AAA", "BBB"], "new"])).toThrow("E_BAD_SHAPE");
		expect(() => assertReq(["test.txt", ["AAA", 42], "new"])).toThrow("E_BAD_SHAPE");
	});
});

describe("anchor validation order", () => {
	it("rejects malformed anchors before any file I/O", async () => {
		const tool = buildToolDef();
		await expect(
			tool.execute(
				"e1",
				["does-not-exist.ts", ["abcd", "abcd"], "x"],
				undefined,
				undefined,
				{ cwd: "/tmp" } as any,
			),
		).rejects.toThrow(/^\[E_BAD_REF\]/);
	});
});
describe("prepareArguments normalization", () => {
	it("wraps tuple arguments for the object-root tool schema", () => {
		const tool = buildToolDef();
		const args = ["test.txt", ["AAA", "BBB"], "line1\nline2"];
		expect(tool.prepareArguments!(args)).toEqual({ edit: args });
	});

	it("keeps the canonical object-root tuple unchanged", () => {
		const tool = buildToolDef();
		expect(tool.prepareArguments!({ edit: ["test.txt", ["AAA", "BBB"], "x"] })).toEqual({
			edit: ["test.txt", ["AAA", "BBB"], "x"],
		});
	});

	it("keeps a null-path tuple valid for anchor inference", () => {
		const tool = buildToolDef();
		expect(tool.prepareArguments!({ edit: [null, ["AAA", "BBB"], "x"] })).toEqual({
			edit: [null, ["AAA", "BBB"], "x"],
		});
	});

	it("unwraps a one-level deep double wrap", () => {
		const tool = buildToolDef();
		expect(
			tool.prepareArguments!({ edit: { edit: ["test.txt", ["AAA", "BBB"], "x"] } }),
		).toEqual({ edit: ["test.txt", ["AAA", "BBB"], "x"] });
	});

	it("rejects malformed shapes with an actionable E_BAD_SHAPE hint", () => {
		const tool = buildToolDef();
		const bad = [undefined, {}, "test.txt", ["test.txt"], { edit: "nope" }];
		for (const args of bad) {
			expect(() => tool.prepareArguments!(args)).toThrow(/^\[E_BAD_SHAPE\]/);
			expect(() => tool.prepareArguments!(args)).toThrow(/canonical payload/);
		}
	});

	it("rejects the old named-object payload with the canonical-shape hint", () => {
		const tool = buildToolDef();
		expect(() =>
			tool.prepareArguments!({
				path: "test.txt",
				remove_from: "AAA",
				remove_to: "BBB",
				replacement_text: "new",
			}),
		).toThrow(/canonical payload/);
	});
});
