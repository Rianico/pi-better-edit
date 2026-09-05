import { describe, expect, it } from "vitest";
import { assertReq, buildToolDef } from "../../src/edit";
import { normReq } from "../../src/edit-normalize";

describe("assertReq", () => {
	it("throws for non-object payloads", () => {
		expect(() => assertReq("string")).toThrow("E_BAD_PAYLOAD");
		expect(() => assertReq(null)).toThrow("E_BAD_PAYLOAD");
		expect(() => assertReq({ path: "test.txt" })).toThrow("E_BAD_PAYLOAD");
	});

	it("rejects flat named fields without the edits wrapper", () => {
		expect(() =>
			assertReq({
				file: "test.txt",
				anchor_from: "AAA",
				anchor_to: "BBB",
				replace_with: "new",
			}),
		).toThrow("exactly");
	});

	it("accepts legacy path and null-path payloads via folding", () => {
		expect(() =>
			assertReq(
				normReq({ path: "test.txt", edits: [["AAA", "BBB", "new"]] }),
			),
		).not.toThrow();
		expect(() =>
			assertReq(normReq({ path: null, edits: [["AAA", "BBB", "new"]] })),
		).not.toThrow();
	});

	it("rejects malformed shapes and member types", () => {
		expect(() => assertReq("string")).toThrow("E_BAD_PAYLOAD");
		expect(() =>
			assertReq({ path: "test.txt", edits: [["AAA"]] }),
		).toThrow("E_BAD_PAYLOAD");
		expect(() =>
			assertReq({ path: "test.txt", edits: [["AAA", "BBB", null]] }),
		).toThrow("E_BAD_PAYLOAD");
		expect(() =>
			assertReq({ path: "", edits: [["AAA", "BBB", "new"]] }),
		).toThrow("E_BAD_PAYLOAD");
		expect(() =>
			assertReq({ path: "test.txt", edits: [["AAA", 42, "new"]] }),
		).toThrow("E_BAD_PAYLOAD");
	});
});



describe("anchor validation order", () => {
	it("rejects malformed anchors before any file I/O", async () => {
		const tool = buildToolDef();
		await expect(
			tool.execute(
				"e1",
				{ path: "does-not-exist.ts", edits: [["abcd", "abcd", "x"]] },
				undefined,
				undefined,
				{ cwd: "/tmp" } as any,
			),
		).rejects.toThrow(/\[E_BAD_ANCHOR\]/);
	});
});
describe("prepareArguments normalization", () => {
	it("keeps the canonical object-root payload unchanged", () => {
		const tool = buildToolDef();
		const args = {
			file: "test.txt",
			edits: [{ anchor_from: "AAA", anchor_to: "BBB", replace_with: "line1\nline2" }],
		};
		expect(tool.prepareArguments!(args)).toEqual(args);
	});

	it("folds legacy tuples and path keys to the canonical shape", () => {
		const tool = buildToolDef();
		expect(
			tool.prepareArguments!({ path: "test.txt", edits: [["AAA", "BBB", "x"]] }),
		).toEqual({
			file: "test.txt",
			edits: [{ anchor_from: "AAA", anchor_to: "BBB", replace_with: "x" }],
		});
		expect(
			tool.prepareArguments!({ path: null, edits: [["AAA", "BBB", "x"]] }),
		).toEqual({
			file: null,
			edits: [{ anchor_from: "AAA", anchor_to: "BBB", replace_with: "x" }],
		});
	});

	it("rejects malformed shapes with an actionable E_BAD_PAYLOAD hint", () => {
		const tool = buildToolDef();
		const bad = [
			undefined,
			{},
			"test.txt",
			["test.txt", ["AAA", "BBB"], "x"],
			{ edit: ["test.txt", ["AAA", "BBB"], "x"] },
			{ file: "test.txt" },
			{ file: "test.txt", edits: [] },
		];
		for (const args of bad) {
			expect(() => tool.prepareArguments!(args)).toThrow(/\[E_BAD_PAYLOAD\]/);
			expect(() => tool.prepareArguments!(args)).toThrow(/canonical payload/);
		}
	});

	it("rejects flat named fields with the canonical-shape hint", () => {
		const tool = buildToolDef();
		expect(() =>
			tool.prepareArguments!({
				file: "test.txt",
				anchor_from: "AAA",
				anchor_to: "BBB",
				replace_with: "new",
			}),
		).toThrow(/canonical payload/);
	});
});
