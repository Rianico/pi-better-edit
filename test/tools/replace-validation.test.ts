import { describe, expect, it } from "vitest";
import { assertReq, buildToolDef } from "../../src/edit";
import { normReq } from "../../src/edit-normalize";

describe("assertReq", () => {
	it("throws for non-object payloads", () => {
		expect(() => assertReq("string")).toThrow("E_BAD_PAYLOAD");
		expect(() => assertReq(null)).toThrow("E_BAD_PAYLOAD");
		expect(() => assertReq({ path: "test.txt" })).toThrow("E_BAD_PAYLOAD");
	});

	it("rejects the old named-object payload", () => {
		expect(() =>
			assertReq({
				path: "test.txt",
				remove_from: "AAA",
				remove_to: "BBB",
				replacement_text: "new",
			}),
		).toThrow("exactly");
	});

	it("accepts a path and null-path payload", () => {
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
		const args = { path: "test.txt", edits: [["AAA", "BBB", "line1\nline2"]] };
		expect(tool.prepareArguments!(args)).toEqual(args);
	});

	it("accepts a null-path payload for anchor inference", () => {
		const tool = buildToolDef();
		expect(
			tool.prepareArguments!({ path: null, edits: [["AAA", "BBB", "x"]] }),
		).toEqual({ path: null, edits: [["AAA", "BBB", "x"]] });
	});

	it("rejects malformed shapes with an actionable E_BAD_PAYLOAD hint", () => {
		const tool = buildToolDef();
		const bad = [
			undefined,
			{},
			"test.txt",
			["test.txt", ["AAA", "BBB"], "x"],
			{ edit: ["test.txt", ["AAA", "BBB"], "x"] },
			{ path: "test.txt" },
			{ path: "test.txt", edits: [] },
		];
		for (const args of bad) {
			expect(() => tool.prepareArguments!(args)).toThrow(/\[E_BAD_PAYLOAD\]/);
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
