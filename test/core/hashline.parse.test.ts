import { describe, expect, it } from "vitest";
import { parseText, parseHashRef } from "../../src/hashline";

describe("parseHashRef", () => {
	it("parses a hash anchor without # prefix", () => {
		const ref = parseHashRef("aB3");
		expect(ref).toEqual({ hash: "aB3" });
	});

	it("rejects trailing content after the anchor", () => {
		expect(() => parseHashRef("aB3:const x = 1;")).toThrow(
			/Expected a 3-char alphanumeric anchor/,
		);
	});

	it("rejects a full HASH│content line copied into hash_range_inclusive", () => {
		expect(() => parseHashRef("aB3│const x = 1;")).toThrow(
			/hash_range_inclusive must contain the 3-char hash only/,
		);
	});
	it("rejects leading >>> markers (strict mode: no marker stripping)", () => {
		expect(() => parseHashRef(">>> aB3")).toThrow(/E_BAD_REF/);
	});

	it("rejects + and - diff markers (strict mode: anchor only)", () => {
		expect(() => parseHashRef("+aB3")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-aB3")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-#aB3")).toThrow(/E_BAD_REF/);
	});

	it("rejects - and _ anywhere in the anchor (not in the alphabet)", () => {
		expect(() => parseHashRef("-qk")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-_-")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("---")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("aB_")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("aB-")).toThrow(/E_BAD_REF/);
	});

	it("rejects + as a hash body character (not in alphabet)", () => {
		expect(() => parseHashRef("+qk")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("#+qk")).toThrow(/E_BAD_REF/);
	});

	it("rejects malformed anchors with E_BAD_REF", () => {
		expect(() => parseHashRef("invalid")).toThrow(/^\[E_BAD_REF\]/);
	});

	it("rejects legacy LINE#HASH format", () => {
		expect(() => parseHashRef("5aB3")).toThrow(
			/Use the hash alone/,
		);
	});

	it("rejects wrong-length anchors", () => {
		expect(() => parseHashRef("aB")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("aB3x")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("aB3x")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("#aB3x")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("#aB3x")).toThrow(/E_BAD_REF/);
	});

	it("rejects anchors with invalid alphabet", () => {
		expect(() => parseHashRef("!@#")).toThrow(/^\[E_BAD_REF\]/);
	});
});

describe("parseText", () => {
	it("rejects null with a clear error (use [] to delete)", () => {
		expect(() => parseText(null)).toThrow(/^\[E_BAD_SHAPE\].*string array/);
	});

  it("rejects string input with clear error (must use array)", () => {
    expect(() => parseText("a\nb")).toThrow(
      /must be a native JSON array of strings, not a JSON string/,
    );
  });

  it("rejects string input with trailing newline", () => {
    expect(() => parseText("a\nb\n")).toThrow(
      /must be a native JSON array of strings, not a JSON string/,
    );
  });

  it("rejects string input with trailing whitespace", () => {
    expect(() => parseText("a\nb\n  ")).toThrow(
      /must be a native JSON array of strings, not a JSON string/,
    );
  });

  it("rejects empty string input", () => {
    expect(() => parseText("")).toThrow(
      /must be a native JSON array of strings, not a JSON string/,
    );
  });

	it("passes through array input verbatim", () => {
		const input = ["a", "b"];
		expect(parseText(input)).toEqual(input);
	});

	it("preserves '# keep me' comment lines (no autocorrection)", () => {
		expect(parseText(["# keep me"])).toEqual(["# keep me"]);
	});

	it("preserves literal '+' prefixed content (no autocorrection)", () => {
		expect(parseText(["+added"])).toEqual(["+added"]);
	});

  it("returns empty string as a single empty line for blank content (array input)", () => {
    expect(parseText([""])).toEqual([""]);
  });
	it("passes through diff-preview rows verbatim (marker stripping happens in applyEdits)", () => {
		expect(parseText(["+aB3│foo", "+xYp│bar"])).toEqual(["+aB3│foo", "+xYp│bar"]);
		expect(parseText([" aB3│keep", "-10    old", " xYp│after"])).toEqual([" aB3│keep", "-10    old", " xYp│after"]);
		expect(parseText([" aB3│keep", "-   │old", " xYp│after"])).toEqual([" aB3│keep", "-   │old", " xYp│after"]);
		expect(parseText(["-aB3│old", "- aB3│old"])).toEqual(["-aB3│old", "- aB3│old"]);
	});

	it("passes through numbered deletion rows as literal content", () => {
		expect(parseText(["-10    old"])).toEqual(["-10    old"]);
	});

	it("accepts literal minus-prefixed content that is not a diff row", () => {
		expect(parseText(["-   something", "-abc", "- old style"])).toEqual(["-   something", "-abc", "- old style"]);
	});

  it("rejects string-form rendered diff hunks (string input rejected)", () => {
    const input = " aB3│keep\n-10    old\n+xYp│new\n mNo│after";
    expect(() => parseText(input)).toThrow(
      /must be a native JSON array of strings, not a JSON string/,
    );
  });
});
