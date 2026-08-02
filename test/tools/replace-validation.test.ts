import { describe, expect, it } from "vitest";
import { assertReq } from "../../src/replace";
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
		expect(() => assertReq({ path: "test.txt", changes: [], unknown: "field" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for missing path", () => {
		expect(() => assertReq({ changes: [] }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for empty path", () => {
		expect(() => assertReq({ path: "", changes: [] }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("throws for non-string path", () => {
		expect(() => assertReq({ path: 42, changes: [] }))
			.toThrow("[E_BAD_SHAPE]");
	});

  it("throws for non-array edits", () => {
    expect(() => assertReq({ path: "test.txt", changes: "not array" }))
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

  it("throws when neither changes array nor top-level edit fields present", () => {
    expect(() => assertReq({ path: "test.txt" }))
      .toThrow(/hash_range_inclusive/);
  });

  it("accepts the normalized internal shape (path + changes array)", () => {
    expect(() => assertReq({
      path: "test.txt",
      changes: [{ hash_range_inclusive: ["AAA", "BBB"], content_lines: ["new"] }],
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
});
