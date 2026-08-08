import { describe, expect, it } from "vitest";
import { assertReq, buildToolDef } from "../../src/replace";

describe("assertReq", () => {
	it("throws for non-record input", () => {
		expect(() => assertReq("string")).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReq(null)).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReq(42)).toThrow("[E_BAD_SHAPE]");
	});

	it("throws for unknown fields", () => {
		expect(() => assertReq({ path: "test.txt", hash_bounds: ["AAA", "BBB"], new_content: "new", unknown: "field" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for missing path", () => {
		expect(() => assertReq({ hash_bounds: ["AAA", "BBB"], new_content: "new" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for empty path", () => {
		expect(() => assertReq({ path: "", hash_bounds: ["AAA", "BBB"], new_content: "new" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for non-string path", () => {
		expect(() => assertReq({ path: 42, hash_bounds: ["AAA", "BBB"], new_content: "new" }))
			.toThrow("[E_BAD_SHAPE]");
	});

  it("throws when new_content present but no hash_bounds", () => {
    expect(() => assertReq({ path: "test.txt", new_content: "a" }))
      .toThrow(/hash_bounds/);
  });

  it("throws when hash_bounds present but no new_content", () => {
    expect(() => assertReq({ path: "test.txt", hash_bounds: ["AAA", "BBB"] }))
      .toThrow(/new_content/);
  });

  it("throws when neither edit field is present", () => {
    expect(() => assertReq({ path: "test.txt" }))
      .toThrow(/hash_bounds/);
  });

  it("accepts the top-level edit shape", () => {
    expect(() => assertReq({
      path: "test.txt",
      hash_bounds: ["AAA", "BBB"],
      new_content: "new",
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
					hash_bounds: ["abcd", "abcd"],
					new_content: "x",
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

	it("passes new_content through as a string", () => {
		const tool = buildToolDef();
		const prepared = tool.prepareArguments!({
			path: "test.txt",
			hash_bounds: ["AAA", "BBB"],
			new_content: "line1\nline2",
		}) as Record<string, unknown>;
		expect(prepared.new_content).toBe("line1\nline2");
	});

	it("normalizes file_path to path", () => {
		const tool = buildToolDef();
		const prepared = tool.prepareArguments!({
			file_path: "test.txt",
			hash_bounds: ["AAA", "BBB"],
			new_content: "x",
		}) as Record<string, unknown>;
		expect(prepared.path).toBe("test.txt");
		expect("file_path" in prepared).toBe(false);
	});
});
