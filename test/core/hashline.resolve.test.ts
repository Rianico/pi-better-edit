import { describe, expect, it } from "vitest";
import {
	resEdit,
	type Anchor,
	type HTEdit,
} from "../../src/hashline";

describe("resEdit", () => {
	it("resolves replace with hash_bounds", () => {
		const edit: HTEdit = { hash_bounds: ["ZZP", "PPW"], new_content: "a\nb" };
		const resolved = resEdit(edit);
		expect(resolved).toHaveProperty("hash_bounds");
		expect(resolved).toHaveProperty("content_lines");
	});

	it("resolves a 1-line replace (same anchor)", () => {
		const edit: HTEdit = { hash_bounds: ["MQX", "MQX"], new_content: "new" };
		const resolved = resEdit(edit);
		const r = resolved as {
			hash_bounds: [Anchor, Anchor];
      content_lines: string[];
		};
		expect(r.hash_bounds[0].hash).toBe("MQX");
		expect(r.hash_bounds[1].hash).toBe("MQX");
	});

	it("throws on replace with no hash_bounds (E_BAD_SHAPE)", () => {
    const edit = { new_content: "new" } as any;
		expect(() => resEdit(edit)).toThrow(/^\[E_BAD_SHAPE\]/);
	});

	it("throws on malformed hash_bounds", () => {
		const edit: HTEdit = { hash_bounds: ["not-valid", "not-valid"], new_content: "x" };
		expect(() => resEdit(edit)).toThrow(/Invalid anchor/);
	});

  it("rejects array new_content input", () => {
    const edit = {
      hash_bounds: ["ZZP", "ZZP"],
      new_content: ["hello", "world"],
    } as unknown as HTEdit;
    expect(() => resEdit(edit)).toThrow(
      /must be a string with \\n line separators, not an array/i,
    );
  });

  it("splits string new_content on line separators", () => {
    const edit = {
      hash_bounds: ["ZZP", "ZZP"],
      new_content: "line1\nline2\n",
    } as unknown as HTEdit;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["line1", "line2"]);
  });

  it("normalizes CRLF in new_content", () => {
    const edit = {
      hash_bounds: ["ZZP", "ZZP"],
      new_content: "a\r\nb",
    } as unknown as HTEdit;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["a", "b"]);
  });

	it("rejects null new_content input", () => {
		const edit = {
			hash_bounds: ["ZZP", "ZZP"],
      new_content: null,
		} as unknown as HTEdit;
		expect(() => resEdit(edit)).toThrow(
      /must be a string with \\n line separators, not an array/i,
		);
	});

	it("rejects unknown fields", () => {
    const edit = { hash_bounds: ["ZZP", "ZZP"], new_content: "x", extra: true } as any;
		expect(() => resEdit(edit)).toThrow(
			/unknown or unsupported fields/i,
		);
	});

	it("rejects missing new_content", () => {
		const edit = { hash_bounds: ["ZZP", "ZZP"] } as any;
		expect(() => resEdit(edit)).toThrow(
      /requires a "new_content" field/i,
		);
	});
});
