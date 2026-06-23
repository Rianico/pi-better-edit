import { describe, expect, it } from "vitest";
import {
  applyEdits,
  affRange,
  lineHashes,
  fmtRegion,
  resEdits,
  type HTEdit,
  type HEdit,
} from "../../src/hashline";
import { makeTag } from "../support/fixtures";


describe("stale-position compound edits", () => {
	it("rejects stale anchors after a replace", () => {
		// After a replace, the original line anchor should no longer be valid
		// at the same position (its content changed).
		const originalLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
		const content = originalLines.join("\n");

		const line5Hash = makeTag(content, 5).hash;
		const edits: HEdit[] = [
			{ old_range: [{ hash: line5Hash }, { hash: line5Hash }], new_lines: ["NEW_LINE_5"] },
		];

		const result = applyEdits(content, edits);
		expect(result.content.split("\n")[4]).toBe("NEW_LINE_5"); // line 5 in final doc

		// Attempting to use the OLD hash (for the original line 5) on the
		// result should fail because the line at that hash no longer exists.
		expect(() => {
			applyEdits(result.content, [
				{ old_range: [{ hash: line5Hash }, { hash: line5Hash }], new_lines: ["ANOTHER"] },
			]);
		}).toThrow(/stale anchor/);

		// The correct anchor uses the fresh hash for "NEW_LINE_5" in the new
		// file.
		const freshHash = lineHashes(result.content)[4]!;
		const result2 = applyEdits(result.content, [
			{ old_range: [{ hash: freshHash }, { hash: freshHash }], new_lines: ["UPDATED_LINE_5"] },
		]);
		expect(result2.content.split("\n")[4]).toBe("UPDATED_LINE_5");
	});

	it("tracks correct final coordinates for a range replace", () => {
		// 10-line file
		const originalLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
		const content = originalLines.join("\n");

		// Replace lines 2-4 with 3 new lines
		const line2Hash = makeTag(content, 2).hash;
		const line4Hash = makeTag(content, 4).hash;
		const toolEdits: HTEdit[] = [
			{
				old_range: [line2Hash, line4Hash], new_lines: ["NEW_2", "NEW_3", "NEW_4"],
			},
		];

		// Resolve through the tool-schema → HEdit pipeline
		const resolved: HEdit[] = resEdits(toolEdits);

		// Apply all edits at once
		const result = applyEdits(content, resolved);

		// ── Verify final content ──
		const expectedLines = [
			"line1",
			"NEW_2",
			"NEW_3",
			"NEW_4",
			"line5",
			"line6",
			"line7",
			"line8",
			"line9",
			"line10",
		];
		expect(result.content).toBe(expectedLines.join("\n"));

		// ── Verify firstChangedLine and lastChangedLine ──
		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(4);

		// ── Verify line count ──
		expect(result.content.split("\n").length).toBe(10);

		// ── Verify affRange returns null with default contextLines (0) ──
		const anchorRange = affRange({
			firstChangedLine: result.firstChangedLine,
			lastChangedLine: result.lastChangedLine,
			resultLineCount: expectedLines.length,
		});
		expect(anchorRange).toBeNull();
	});

	it("tracks correct coordinates when replace shrinks lines", () => {
		// Replace 2 lines with 1 (shrink).
		const content = "a\nb\nc\nd\ne";
		const edits: HEdit[] = [
			{ old_range: [makeTag(content, 3), makeTag(content, 4)], new_lines: ["C_D"] },
		];
		const result = applyEdits(content, edits);

		// Final doc: a, b, C_D, e  (4 lines)
		expect(result.content).toBe("a\nb\nC_D\ne");
		expect(result.firstChangedLine).toBe(3);
		expect(result.lastChangedLine).toBe(3);
	});
});
