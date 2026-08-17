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
});
