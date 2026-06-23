import { describe, expect, it } from "vitest";
import {
	resEdits,
	type Anchor,
	type HTEdit,
} from "../../src/hashline";

describe("resEdits", () => {
	it("resolves replace with old_range", () => {
		const edits: HTEdit[] = [
			{ old_range: ["ZZP", "PPW"], new_lines: ["a", "b"] },
		];
		const resolved = resEdits(edits);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]).toHaveProperty("old_range");
		expect(resolved[0]).toHaveProperty("new_lines");
	});

	it("resolves a 1-line replace (same anchor)", () => {
		const edits: HTEdit[] = [
			{ old_range: ["MQX", "MQX"], new_lines: ["new"] },
		];
		const resolved = resEdits(edits);
		expect(resolved).toHaveLength(1);
		const r = resolved[0] as {
			old_range: [Anchor, Anchor];
			new_lines: string[];
		};
		expect(r.old_range[0].hash).toBe("MQX");
		expect(r.old_range[1].hash).toBe("MQX");
	});

	it("throws on replace with no old_range", () => {
		const edits = [{ new_lines: ["new"] }] as any;
		expect(() => resEdits(edits)).toThrow(/requires an "old_range" pair/i);
	});

	it("throws on malformed old_range", () => {
		const edits: HTEdit[] = [
			{ old_range: ["not-valid", "not-valid"], new_lines: ["x"] },
		];
		expect(() => resEdits(edits)).toThrow(/Invalid anchor/);
	});

	it("rejects string new_lines input", () => {
		const edits: HTEdit[] = [
			{
				old_range: ["ZZP", "ZZP"],
				new_lines: "hello\nworld\n",
			} as unknown as HTEdit,
		];
		expect(() => resEdits(edits)).toThrow(
			/new_lines" must be a string array/i,
		);
	});

	it("rejects null new_lines input", () => {
		const edits: HTEdit[] = [
			{
				old_range: ["ZZP", "ZZP"],
				new_lines: null,
			} as unknown as HTEdit,
		];
		expect(() => resEdits(edits)).toThrow(
			/new_lines" must be a string array/i,
		);
	});

	it("rejects unknown fields", () => {
		const edits = [{ old_range: ["ZZP", "ZZP"], new_lines: ["x"], extra: true }] as any;
		expect(() => resEdits(edits)).toThrow(
			/unknown or unsupported fields/i,
		);
	});

	it("rejects missing new_lines", () => {
		const edits = [{ old_range: ["ZZP", "ZZP"] }] as any;
		expect(() => resEdits(edits)).toThrow(
			/requires a "new_lines" field/i,
		);
	});
});
