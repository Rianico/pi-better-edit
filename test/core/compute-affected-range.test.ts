import { describe, expect, it } from "vitest";
import { affRange } from "../../src/hashline";

describe("affRange", () => {
  it("returns null when firstChangedLine is undefined", () => {
    expect(
      affRange({
        firstChangedLine: undefined,
        lastChangedLine: 5,
        resultLineCount: 10,
      }),
    ).toBeNull();
  });

  it("returns null when lastChangedLine is undefined", () => {
    expect(
      affRange({
        firstChangedLine: 2,
        lastChangedLine: undefined,
        resultLineCount: 10,
      }),
    ).toBeNull();
  });

	it("returns null with default contextLines (0)", () => {

		const result = affRange({
			firstChangedLine: 5,
			lastChangedLine: 5,
			resultLineCount: 20,
		});
		expect(result).toBeNull();
	});

	it("returns range with explicit contextLines", () => {
		const result = affRange({
			firstChangedLine: 5,
			lastChangedLine: 5,
			resultLineCount: 20,
			contextLines: 2,
		});
		expect(result).toEqual({ start: 3, end: 7 });
	});

	it("returns null for multi-line change with default contextLines", () => {
		const result = affRange({
			firstChangedLine: 10,
			lastChangedLine: 15,
			resultLineCount: 30,
		});
		expect(result).toBeNull();
	});

	it("returns null for changes near BOF with default contextLines", () => {
		const result = affRange({
			firstChangedLine: 1,
			lastChangedLine: 2,
			resultLineCount: 20,
		});
		expect(result).toBeNull();
	});

	it("returns null for changes near EOF with default contextLines", () => {
		const result = affRange({
			firstChangedLine: 19,
			lastChangedLine: 20,
			resultLineCount: 20,
		});
		expect(result).toBeNull();
	});

  it("returns null when range + context exceeds maxOutputLines", () => {
    const result = affRange({
      firstChangedLine: 1,
      lastChangedLine: 15,
      resultLineCount: 20,
      maxOutputLines: 12,
    });

		expect(result).toBeNull();
  });

  it("accepts a range that exactly fits maxOutputLines", () => {
    const result = affRange({
      firstChangedLine: 3,
      lastChangedLine: 8,
      resultLineCount: 20,
      maxOutputLines: 12,
      contextLines: 2,
    });

		expect(result).toEqual({ start: 1, end: 10 });
  });

  it("supports custom contextLines", () => {
    const result = affRange({
      firstChangedLine: 5,
      lastChangedLine: 5,
      resultLineCount: 20,
      contextLines: 1,
    });
    expect(result).toEqual({ start: 4, end: 6 });
  });

	it("returns null for empty-file result (P2 regression)", () => {
		expect(
      affRange({
        firstChangedLine: 1,
        lastChangedLine: 1,
        resultLineCount: 0,
      }),
		).toBeNull();
  });
});
