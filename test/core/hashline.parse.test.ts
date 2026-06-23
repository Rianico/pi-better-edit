import { describe, expect, it } from "vitest";
import { parseText, parseHashRef } from "../../src/hashline";

describe("parseHashRef", () => {
	it("parses a hash anchor without # prefix", () => {
		const ref = parseHashRef("aB3");
		expect(ref).toEqual({ hash: "aB3" });
	});

	it("rejects trailing content after the anchor", () => {
		expect(() => parseHashRef("aB3:const x = 1;")).toThrow(
			/Expected a 3-char base64 anchor/,
		);
	});

	it("rejects a full HASH│content line copied into hash_range_incl", () => {
		expect(() => parseHashRef("aB3│const x = 1;")).toThrow(
			/hash_range_incl must contain the 3-char hash only/,
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

	it("accepts a hash that starts with - in the body (alphabet char, not a marker)", () => {
		expect(parseHashRef("-qk")).toEqual({ hash: "-qk" });
		expect(parseHashRef("-_-")).toEqual({ hash: "-_-" });
		expect(parseHashRef("---")).toEqual({ hash: "---" });
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
	it("returns [] for null", () => {
		expect(parseText(null)).toEqual([]);
	});

	it("splits string on newline", () => {
		expect(parseText("a\nb")).toEqual(["a", "b"]);
	});

	it("removes trailing blank line from string input", () => {
		expect(parseText("a\nb\n")).toEqual(["a", "b"]);
	});

	it("preserves a trailing whitespace-only content line in string input", () => {
		expect(parseText("a\nb\n  ")).toEqual(["a", "b", "  "]);
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

	it("returns empty string as a single empty line for blank content", () => {
		expect(parseText("")).toEqual([""]);
	});

	it("rejects array input that contains HASH| prefixes", () => {
		expect(() => parseText(["+aB3│foo", "+xYp│bar"])).toThrow(
			/^\[E_INVALID_PATCH\]/,
		);
	});

	it("rejects diff-preview hunks with + and context hash prefixes", () => {
		expect(() =>
				parseText([" aB3│keep", "+xYp│new", " mNo│after"]),
		).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("rejects diff-preview deletion rows", () => {
		expect(() =>
				parseText([" aB3│keep", "-10    old", " xYp│after"]),
		).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("rejects string-form rendered diff hunks", () => {
		const input = " aB3│keep\n-10    old\n+xYp│new\n mNo│after";
		expect(() => parseText(input)).toThrow(/^\[E_INVALID_PATCH\]/);
	});
});
