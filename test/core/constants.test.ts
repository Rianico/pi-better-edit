import { describe, expect, it } from "vitest";
import {
	AUTO_READ_MAX_LINES,
	CHANGED_ANCHOR_TEXT_BUDGET_BYTES,
	ANCHOR_CONTEXT_LINES,
	ANCHOR_MAX_OUTPUT_LINES,
	FILE_TYPE_SNIFF_BYTES,
} from "../../src/constants";

describe("constants", () => {
	it("AUTO_READ_MAX_LINES is a positive number", () => {
		expect(AUTO_READ_MAX_LINES).toBeGreaterThan(0);
		expect(typeof AUTO_READ_MAX_LINES).toBe("number");
	});

	it("CHANGED_ANCHOR_TEXT_BUDGET_BYTES is a positive number", () => {
		expect(CHANGED_ANCHOR_TEXT_BUDGET_BYTES).toBeGreaterThan(0);
		expect(typeof CHANGED_ANCHOR_TEXT_BUDGET_BYTES).toBe("number");
	});

	it("ANCHOR_CONTEXT_LINES is a non-negative number", () => {
		expect(ANCHOR_CONTEXT_LINES).toBeGreaterThanOrEqual(0);
		expect(typeof ANCHOR_CONTEXT_LINES).toBe("number");
	});

	it("ANCHOR_MAX_OUTPUT_LINES is a positive number", () => {
		expect(ANCHOR_MAX_OUTPUT_LINES).toBeGreaterThan(0);
		expect(typeof ANCHOR_MAX_OUTPUT_LINES).toBe("number");
	});

	it("FILE_TYPE_SNIFF_BYTES is a positive number", () => {
		expect(FILE_TYPE_SNIFF_BYTES).toBeGreaterThan(0);
		expect(typeof FILE_TYPE_SNIFF_BYTES).toBe("number");
	});
});