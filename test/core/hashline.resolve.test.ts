import { describe, expect, it } from "vitest";
import {
	resEdits,
	type Anchor,
	type HTEdit,
} from "../../src/hashline";

describe("resEdits", () => {
	it("resolves replace with hash_range_inclusive", () => {
		const edits: HTEdit[] = [
      { hash_range_inclusive: ["ZZP", "PPW"], content_lines: ["a", "b"] },
		];
		const resolved = resEdits(edits);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]).toHaveProperty("hash_range_inclusive");
		expect(resolved[0]).toHaveProperty("content_lines");
	});

	it("resolves a 1-line replace (same anchor)", () => {
		const edits: HTEdit[] = [
      { hash_range_inclusive: ["MQX", "MQX"], content_lines: ["new"] },
		];
		const resolved = resEdits(edits);
		expect(resolved).toHaveLength(1);
		const r = resolved[0] as {
			hash_range_inclusive: [Anchor, Anchor];
      content_lines: string[];
		};
		expect(r.hash_range_inclusive[0].hash).toBe("MQX");
		expect(r.hash_range_inclusive[1].hash).toBe("MQX");
	});

	it("throws on replace with no hash_range_inclusive (E_BAD_SHAPE)", () => {
    const edits = [{ content_lines: ["new"] }] as any;
		expect(() => resEdits(edits)).toThrow(/^\[E_BAD_SHAPE\]/);
	});

	it("throws on malformed hash_range_inclusive", () => {
		const edits: HTEdit[] = [
      { hash_range_inclusive: ["not-valid", "not-valid"], content_lines: ["x"] },
		];
		expect(() => resEdits(edits)).toThrow(/Invalid anchor/);
	});

	it("rejects string content_lines input", () => {
		const edits: HTEdit[] = [
			{
				hash_range_inclusive: ["ZZP", "ZZP"],
        content_lines: "hello\nworld\n",
			} as unknown as HTEdit,
		];
		expect(() => resEdits(edits)).toThrow(
      /content_lines" must be a string array/i,
		);
	});

	it("rejects null content_lines input", () => {
		const edits: HTEdit[] = [
			{
				hash_range_inclusive: ["ZZP", "ZZP"],
        content_lines: null,
			} as unknown as HTEdit,
		];
		expect(() => resEdits(edits)).toThrow(
      /content_lines" must be a string array/i,
		);
	});

	it("rejects unknown fields", () => {
    const edits = [{ hash_range_inclusive: ["ZZP", "ZZP"], content_lines: ["x"], extra: true }] as any;
		expect(() => resEdits(edits)).toThrow(
			/unknown or unsupported fields/i,
		);
	});

	it("rejects missing content_lines", () => {
		const edits = [{ hash_range_inclusive: ["ZZP", "ZZP"] }] as any;
		expect(() => resEdits(edits)).toThrow(
      /requires a "content_lines" field/i,
		);
	});
});
