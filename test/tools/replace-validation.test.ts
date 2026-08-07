import { describe, expect, it } from "vitest";
import { assertReq, assertNoLegacyKeys, buildToolDef } from "../../src/replace";
import { withTempFile, makeFakePiRegistry } from "../support/fixtures";
import register from "../../index";

describe("assertReq", () => {
	it("throws for non-record input", () => {
		expect(() => assertReq("string")).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReq(null)).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReq(42)).toThrow("[E_BAD_SHAPE]");
	});

	it("throws for legacy shape with oldText", () => {
		expect(() => assertReq({ path: "test.txt", oldText: "old", newText: "new" }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with newText", () => {
		expect(() => assertReq({ path: "test.txt", newText: "new" }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with old_text", () => {
		expect(() => assertReq({ path: "test.txt", old_text: "old" }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with new_text", () => {
		expect(() => assertReq({ path: "test.txt", new_text: "new" }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with start", () => {
		expect(() => assertReq({ path: "test.txt", start: 1 }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with end", () => {
		expect(() => assertReq({ path: "test.txt", end: 5 }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for legacy shape with lines", () => {
		expect(() => assertReq({ path: "test.txt", lines: ["line1"] }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for unknown fields", () => {
		expect(() => assertReq({ path: "test.txt", hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"], unknown: "field" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws E_LEGACY_SHAPE for a changes array (unsupported dialect)", () => {
		expect(() => assertReq({ path: "test.txt", changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] }] }))
			.toThrow("[E_LEGACY_SHAPE]");
	});

	it("throws for missing path", () => {
		expect(() => assertReq({ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for empty path", () => {
		expect(() => assertReq({ path: "", hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for non-string path", () => {
		expect(() => assertReq({ path: 42, hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] }))
			.toThrow("[E_BAD_SHAPE]");
	});

  it("throws when content_lines present but no hash_range_inclusive", () => {
    expect(() => assertReq({ path: "test.txt", content_lines: ["a"] }))
      .toThrow(/content_lines/);
  });

  it("throws when hash_range_inclusive present but no content_lines", () => {
    expect(() => assertReq({ path: "test.txt", hash_range_inclusive: ["AAA", "BBB"] }))
      .toThrow(/hash_range_inclusive/);
  });

  it("throws when neither edit field is present", () => {
    expect(() => assertReq({ path: "test.txt" }))
      .toThrow(/hash_range_inclusive/);
  });

  it("accepts the top-level edit shape", () => {
    expect(() => assertReq({
      path: "test.txt",
      hash_range_inclusive: ["AAA", "BBB"],
      content_lines: ["new"],
    })).not.toThrow();
  });

	it("throws for request without edits", () => {
		expect(() => assertReq({ path: "test.txt" })).toThrow("[E_BAD_SHAPE]");
	});
});

describe("legacy dialect rejection in the execution path", () => {
	it("prepareArguments rejects legacy keys with E_LEGACY_SHAPE", () => {
		const { pi, getTool } = makeFakePiRegistry();
		register(pi);
		const tool = getTool("replace");
		expect(() => tool.prepareArguments({ path: "test.txt", oldText: "a", newText: "b" })).toThrow(/^\[E_LEGACY_SHAPE\]/);
		expect(() => tool.prepareArguments({ path: "test.txt", old_text: "a" })).toThrow(/^\[E_LEGACY_SHAPE\]/);
		expect(() => tool.prepareArguments({ path: "test.txt", changes: [] })).toThrow(/^\[E_LEGACY_SHAPE\]/);
	});
	it("execute rejects legacy dialect with E_LEGACY_SHAPE before schema validation", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const tool = getTool("replace");
			await expect(
				tool.execute("e1", { path: "sample.ts", oldText: "aaa", newText: "bbb" }, undefined, undefined, { cwd } as any),
			).rejects.toThrow(/^\[E_LEGACY_SHAPE\]/);
		});
	});

	it("raw execute rejects a changes array with E_LEGACY_SHAPE before any file I/O", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
			const tool = buildToolDef();
			await expect(
				tool.execute("e1", { path: "sample.ts", changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] }] }, undefined, undefined, { cwd } as any),
			).rejects.toThrow(/^\[E_LEGACY_SHAPE\]/);
		});
	});
});

describe("assertNoLegacyKeys", () => {
	it("accepts non-record input without throwing", () => {
		expect(() => assertNoLegacyKeys(null)).not.toThrow();
		expect(() => assertNoLegacyKeys("text")).not.toThrow();
		expect(() => assertNoLegacyKeys(["changes"])).not.toThrow();
		expect(() => assertNoLegacyKeys(42)).not.toThrow();
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
					hash_range_inclusive: ["abcd", "abcd"],
					content_lines: ["x"],
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

	it("parses a JSON-string content_lines into an array", () => {
		const tool = buildToolDef();
		const prepared = tool.prepareArguments!({
			path: "test.txt",
			hash_range_inclusive: ["AAA", "BBB"],
			content_lines: '["line1", "line2"]',
		}) as Record<string, unknown>;
		expect(prepared.content_lines).toEqual(["line1", "line2"]);
	});

	it("rejects a JSON-string content_lines that is not an array", () => {
		const tool = buildToolDef();
		expect(() => tool.prepareArguments!({
			path: "test.txt",
			hash_range_inclusive: ["AAA", "BBB"],
			content_lines: '"not-an-array"',
		})).toThrow(/\[E_BAD_SHAPE\]/);
	});

	it("normalizes file_path to path", () => {
		const tool = buildToolDef();
		const prepared = tool.prepareArguments!({
			file_path: "test.txt",
			hash_range_inclusive: ["AAA", "BBB"],
			content_lines: ["x"],
		}) as Record<string, unknown>;
		expect(prepared.path).toBe("test.txt");
		expect("file_path" in prepared).toBe(false);
	});
});
