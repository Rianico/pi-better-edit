import { describe, expect, it } from "vitest";
import { assertReq, buildToolDef } from "../../src/edit";

describe("assertReq", () => {
	it("throws for non-record input", () => {
		expect(() => assertReq("string")).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReq(null)).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReq(42)).toThrow("[E_BAD_SHAPE]");
	});

	it("throws for unknown fields", () => {
		expect(() => assertReq({ path: "test.txt", remove_from: "AAA", remove_to: "BBB", replacement_text: "new", unknown: "field" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for missing path", () => {
		expect(() => assertReq({ remove_from: "AAA", remove_to: "BBB", replacement_text: "new" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for empty path", () => {
		expect(() => assertReq({ path: "", remove_from: "AAA", remove_to: "BBB", replacement_text: "new" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for non-string path", () => {
		expect(() => assertReq({ path: 42, remove_from: "AAA", remove_to: "BBB", replacement_text: "new" }))
			.toThrow("[E_BAD_SHAPE]");
	});

  it("throws when replacement_text present but no remove_from/remove_to", () => {
    expect(() => assertReq({ path: "test.txt", replacement_text: "a" }))
      .toThrow(/remove_from/);
  });

  it("throws when remove_from/remove_to present but no replacement_text", () => {
    expect(() => assertReq({ path: "test.txt", remove_from: "AAA", remove_to: "BBB" }))
      .toThrow(/replacement_text/);
  });

  it("throws when neither edit field is present", () => {
    expect(() => assertReq({ path: "test.txt" }))
      .toThrow(/remove_from/);
  });

  it("accepts the top-level edit shape", () => {
    expect(() => assertReq({
      path: "test.txt",
      remove_from: "AAA", remove_to: "BBB",
      replacement_text: "new",
    })).not.toThrow();
  });

	it("throws for request without edits", () => {
		expect(() => assertReq({ path: "test.txt" })).toThrow("[E_BAD_SHAPE]");
	});
});

describe("anchor validation order", () => {
	it("rejects malformed anchors before any file I/O", async () => {
		const tool = buildToolDef();
		await expect(
			tool.execute(
				"e1",
				{
					path: "does-not-exist.ts",
					remove_from: "abcd", remove_to: "abcd",
					replacement_text: "x",
				},
				undefined,
				undefined,
				{ cwd: "/tmp" } as any,
			),
		).rejects.toThrow(/^\[E_BAD_REF\]/);
	});
});

describe("prepareArguments normalization", () => {
	it("passes through non-record input unchanged", () => {
		const tool = buildToolDef();
		expect(tool.prepareArguments!(null)).toBe(null);
		expect(tool.prepareArguments!("raw")).toBe("raw");
	});

	it("passes replacement_text through as a string", () => {
		const tool = buildToolDef();
		const prepared = tool.prepareArguments!({
			path: "test.txt",
			remove_from: "AAA", remove_to: "BBB",
			replacement_text: "line1\nline2",
		}) as Record<string, unknown>;
		expect(prepared.replacement_text).toBe("line1\nline2");
	});

	it("normalizes file_path to path", () => {
		const tool = buildToolDef();
		const prepared = tool.prepareArguments!({
			file_path: "test.txt",
			remove_from: "AAA", remove_to: "BBB",
			replacement_text: "x",
		}) as Record<string, unknown>;
		expect(prepared.path).toBe("test.txt");
		expect("file_path" in prepared).toBe(false);
	});
});
