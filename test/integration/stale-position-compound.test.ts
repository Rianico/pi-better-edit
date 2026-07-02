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

		const originalLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
		const content = originalLines.join("\n");

		const line5Hash = makeTag(content, 5).hash;
		const changes: HEdit[] = [
      { hash_range_inclusive: [{ hash: line5Hash }, { hash: line5Hash }], content_lines: ["NEW_LINE_5"] },
    ];
    const result = applyEdits(content, changes);
		expect(result.content.split("\n")[4]).toBe("NEW_LINE_5");

		expect(() => {
			applyEdits(result.content, [
        { hash_range_inclusive: [{ hash: line5Hash }, { hash: line5Hash }], content_lines: ["ANOTHER"] },
      ]);
    }).toThrow(/stale anchor/);

		const freshHash = lineHashes(result.content)[4]!;
		const result2 = applyEdits(result.content, [
      { hash_range_inclusive: [{ hash: freshHash }, { hash: freshHash }], content_lines: ["UPDATED_LINE_5"] },
    ]);
    expect(result2.content.split("\n")[4]).toBe("UPDATED_LINE_5");
	});

	it("tracks correct final coordinates for a range replace", () => {

		const originalLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
		const content = originalLines.join("\n");

		const line2Hash = makeTag(content, 2).hash;
		const line4Hash = makeTag(content, 4).hash;
		const toolEdits: HTEdit[] = [
			{
        hash_range_inclusive: [line2Hash, line4Hash], content_lines: ["NEW_2", "NEW_3", "NEW_4"],
      },
    ];

		const resolved: HEdit[] = resEdits(toolEdits);

		const result = applyEdits(content, resolved);

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

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(4);

		expect(result.content.split("\n").length).toBe(10);

		const anchorRange = affRange({
			firstChangedLine: result.firstChangedLine,
			lastChangedLine: result.lastChangedLine,
			resultLineCount: expectedLines.length,
		});
		expect(anchorRange).toBeNull();
	});

	it("tracks correct coordinates when replace shrinks lines", () => {

		const content = "a\nb\nc\nd\ne";
		const changes: HEdit[] = [
      { hash_range_inclusive: [makeTag(content, 3), makeTag(content, 4)], content_lines: ["C_D"] },
    ];
    const result = applyEdits(content, changes);

		expect(result.content).toBe("a\nb\nC_D\ne");
		expect(result.firstChangedLine).toBe(3);
		expect(result.lastChangedLine).toBe(3);
	});
});
