import { describe, expect, it } from "vitest";
import { computeDrift } from "../../src/drift";

describe("computeDrift", () => {
	it("returns undefined when nothing drifted outside the range", () => {
		const result = computeDrift({
			served: ["h00", "h01", "h02"],
			resultHashes: ["h00", "h01", "h02"],
			resultLines: ["a", "b", "c"],
			rangeStartLine: 2,
			rangeEndLine: 2,
			startHash: "h01",
			endHash: "h01",
			delta: 0,
			reported: new Set(),
		});
		expect(result).toBeUndefined();
	});

	it("reports an in-place drift below the range with its post-edit content", () => {
		const result = computeDrift({
			served: ["h00", "h01", "h02", "h03"],
			resultHashes: ["h00", "h01", "h02", "X03"],
			resultLines: ["a", "b", "c", "changed"],
			rangeStartLine: 2,
			rangeEndLine: 2,
			startHash: "h01",
			endHash: "h01",
			delta: 0,
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.allAlreadyReported).toBe(false);
		expect(result!.rows).toEqual([
			{ position: 3, hash: "X03", content: "changed" },
		]);
		expect(result!.text).toContain("Drift notice:");
		expect(result!.text).toContain("X03│changed");
	});

	it("excludes the resolved range even when a boundary line was deleted", () => {
		const result = computeDrift({
			served: ["h00", "h01", "h02", "h03", "h04"],
			resultHashes: ["h00", "h01", "X03", "h04"],
			resultLines: ["a", "b", "x", "d"],
			rangeStartLine: 3,
			rangeEndLine: 4,
			startHash: "h02",
			endHash: "h03",
			delta: -1,
			reported: new Set(),
		});
		expect(result).toBeUndefined();
	});

	it("applies the edit's positional shift to served entries below the range", () => {
		const result = computeDrift({
			served: ["h00", "h01", "h02", "h03", "h04"],
			resultHashes: ["h00", "h01", "h03", "X04"],
			resultLines: ["a", "b", "d", "shifted"],
			rangeStartLine: 3,
			rangeEndLine: 3,
			startHash: "h02",
			endHash: "h02",
			delta: -1,
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.rows).toEqual([
			{ position: 3, hash: "X04", content: "shifted" },
		]);
	});

	it("keeps positions of served entries above the range regardless of delta", () => {
		const result = computeDrift({
			served: ["h00", "h01", "h02"],
			resultHashes: ["h00", "X01", "h02"],
			resultLines: ["a", "changed", "c"],
			rangeStartLine: 3,
			rangeEndLine: 3,
			startHash: "h02",
			endHash: "h02",
			delta: -5,
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.rows).toEqual([
			{ position: 1, hash: "X01", content: "changed" },
		]);
	});

	it("counts served entries shifted out of the file as drifted without rows", () => {
		const result = computeDrift({
			served: ["h00", "h01", "h02"],
			resultHashes: ["X02"],
			resultLines: ["c"],
			rangeStartLine: 1,
			rangeEndLine: 1,
			startHash: "h00",
			endHash: "h00",
			delta: -2,
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.total).toBe(2);
		expect(result!.rows).toEqual([{ position: 0, hash: "X02", content: "c" }]);
	});

	it("emits a one-line pointer when every drifted line is already reported", () => {
		const result = computeDrift({
			served: ["h00", "h01", "h02", "h03"],
			resultHashes: ["h00", "h01", "h02", "X03"],
			resultLines: ["a", "b", "c", "changed"],
			rangeStartLine: 1,
			rangeEndLine: 1,
			startHash: "h00",
			endHash: "h00",
			delta: 0,
			reported: new Set(["h03"]),
		});
		expect(result).toBeDefined();
		expect(result!.allAlreadyReported).toBe(true);
		expect(result!.rows).toEqual([]);
		expect(result!.text).toContain("already reported");
		expect(result!.text).not.toContain("│");
	});

	it("shows a full notice with rows for all drifted lines when any is not yet reported", () => {
		const result = computeDrift({
			served: ["h00", "h01", "h02", "h03"],
			resultHashes: ["X00", "h01", "h02", "X03"],
			resultLines: ["changedA", "b", "c", "changedD"],
			rangeStartLine: 2,
			rangeEndLine: 2,
			startHash: "h01",
			endHash: "h01",
			delta: 0,
			reported: new Set(["h03"]),
		});
		expect(result).toBeDefined();
		expect(result!.allAlreadyReported).toBe(false);
		expect(result!.rows).toEqual([
			{ position: 0, hash: "X00", content: "changedA" },
			{ position: 3, hash: "X03", content: "changedD" },
		]);
	});

	it("caps the echoed rows and appends a hint for the remainder", () => {
		const served: (string | null)[] = [];
		const resultHashes: string[] = [];
		const resultLines: string[] = [];
		for (let i = 0; i < 200; i++) {
			served.push(`h${i}`);
			resultHashes.push(i === 0 ? `h${i}` : `R${i}`);
			resultLines.push(`line ${i}`);
		}
		const result = computeDrift({
			served,
			resultHashes,
			resultLines,
			rangeStartLine: 1,
			rangeEndLine: 1,
			startHash: "h0",
			endHash: "h0",
			delta: 0,
			reported: new Set(),
			cap: 150,
		});
		expect(result).toBeDefined();
		expect(result!.rows).toHaveLength(150);
		expect(result!.total).toBe(199);
		expect(result!.text).toContain("[... 49 more drifted line(s)");
	});

	it("ignores never-served markers", () => {
		const result = computeDrift({
			served: ["h00", null, "h02"],
			resultHashes: ["h00", "X01", "h02"],
			resultLines: ["a", "changed", "c"],
			rangeStartLine: 1,
			rangeEndLine: 1,
			startHash: "h00",
			endHash: "h00",
			delta: 0,
			reported: new Set(),
		});
		expect(result).toBeUndefined();
	});

	it("tolerates an external positional shift above the range — only genuinely removed lines drift", () => {
		const served = [
			"h00",
			"h01",
			"h02",
			"h03",
			"h04",
			"h05",
			"h06",
			"h07",
			"h08",
			"h09",
		];
		const resultHashes = ["h00", "h01", "X04", "h05", "h06", "h07", "h08", "h09"];
		const resultLines = ["a", "b", "R", "e", "f", "g", "h", "i"];
		const result = computeDrift({
			served,
			resultHashes,
			resultLines,
			rangeStartLine: 3,
			rangeEndLine: 3,
			startHash: "h04",
			endHash: "h04",
			delta: 0,
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.total).toBe(2);
		expect(result!.rows).toHaveLength(2);
		for (const row of result!.rows) {
			expect(row.position).toBeGreaterThanOrEqual(0);
			expect(row.position).toBeLessThan(resultHashes.length);
			expect(["e", "f", "g", "h", "i"]).not.toContain(row.content);
		}
		expect(result!.text).not.toContain("│e");
		expect(result!.text).not.toContain("│f");
		expect(result!.text).not.toContain("│g");
		expect(result!.text).not.toContain("│h");
		expect(result!.text).not.toContain("│i");
	});
});
