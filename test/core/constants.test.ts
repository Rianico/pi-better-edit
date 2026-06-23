import { describe, expect, it } from "vitest";
import {
	AUTO_READ_MAX,
	ANCHOR_BUDGET,
	CTX_LINES,
	MAX_OUT,
	SNIFF_BYTES,
} from "../../src/constants";

describe("constants", () => {
	it("AUTO_READ_MAX is a positive number", () => {
		expect(AUTO_READ_MAX).toBeGreaterThan(0);
		expect(typeof AUTO_READ_MAX).toBe("number");
	});

	it("ANCHOR_BUDGET is a positive number", () => {
		expect(ANCHOR_BUDGET).toBeGreaterThan(0);
		expect(typeof ANCHOR_BUDGET).toBe("number");
	});

	it("CTX_LINES is a non-negative number", () => {
		expect(CTX_LINES).toBeGreaterThanOrEqual(0);
		expect(typeof CTX_LINES).toBe("number");
	});

	it("MAX_OUT is a positive number", () => {
		expect(MAX_OUT).toBeGreaterThan(0);
		expect(typeof MAX_OUT).toBe("number");
	});

	it("SNIFF_BYTES is a positive number", () => {
		expect(SNIFF_BYTES).toBeGreaterThan(0);
		expect(typeof SNIFF_BYTES).toBe("number");
	});
});
