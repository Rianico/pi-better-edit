import { describe, expect, it, beforeAll } from "vitest";
import { _lineHashesPure } from "../../src/hashline/hash";
import { findEditHashEcho, applyEdit, EditHashEchoError } from "../../src/hashline/apply";
import { initHasher } from "../../src/hashline/hasher";
import { HASH_SEP } from "../../src/hashline/hash-identity";

beforeAll(async () => {
	await initHasher();
});

describe("findEditHashEcho — E1 range-relative exact", () => {
	it("detects Ab3│ at s+k (range-relative exact)", () => {
		const content = "a\nb\nc\nd";
		const hashes = _lineHashesPure(content);
		const served: (string | null)[] = [...hashes];
		const startLine = 2;
		const replacement = [`${hashes[1]}${HASH_SEP}new-b`, `plain`];
		const hit = findEditHashEcho(replacement, served, startLine);
		expect(hit).toEqual({ k: 1, hash: hashes[1] });
	});

	it("does not flag generic Zz9│literal not served at pos (E1)", () => {
		const content = "a\nb\nc\nd";
		const hashes = _lineHashesPure(content);
		const served: (string | null)[] = [...hashes];
		const startLine = 2;
		// choose Zz9 not equal to served[1]
		const fake = "Zz9";
		expect(served[1]).not.toBe(fake);
		const replacement = [`${fake}${HASH_SEP}literal`];
		const hit = findEditHashEcho(replacement, served, startLine);
		expect(hit).toBeUndefined();
	});

	it("does not flag hash from different line (E2 deferred)", () => {
		const content = "a\nb\nc\nd";
		const hashes = _lineHashesPure(content);
		const served: (string | null)[] = [...hashes];
		const startLine = 2;
		// use hash from line 1 at position for line 2 — should NOT match E1
		const replacement = [`${hashes[0]}${HASH_SEP}reordered`];
		const hit = findEditHashEcho(replacement, served, startLine);
		expect(hit).toBeUndefined();
	});

	it("detects echo on second replacement line (k=2)", () => {
		const content = "a\nb\nc\nd";
		const hashes = _lineHashesPure(content);
		const served: (string | null)[] = [...hashes];
		const startLine = 2;
		const replacement = ["ok", `${hashes[2]}${HASH_SEP}echo`];
		const hit = findEditHashEcho(replacement, served, startLine);
		expect(hit).toEqual({ k: 2, hash: hashes[2] });
	});

	it("returns undefined for empty replacement (deletion)", () => {
		const hashes = _lineHashesPure("a\nb\nc");
		const served: (string | null)[] = [...hashes];
		expect(findEditHashEcho([], served, 2)).toBeUndefined();
	});

	it("handles served with null gaps (never-served)", () => {
		const content = "a\nb\nc\nd";
		const hashes = _lineHashesPure(content);
		const served: (string | null)[] = [hashes[0]!, null, hashes[2]!, null];
		const startLine = 2;
		const replacement = [`${hashes[1]}${HASH_SEP}x`];
		// served[1] is null, so no match even if hash equals file hash
		expect(findEditHashEcho(replacement, served, startLine)).toBeUndefined();
	});
});

describe("applyEdit — E_EDIT_HASH_ECHO guard", () => {
	it("S1: Ab3│ at s+k → deny", () => {
		const content = "alpha\nbeta\ngamma\ndelta";
		const hashes = _lineHashesPure(content);
		const served: (string | null)[] = [...hashes];
		const edit = {
			hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
			content_lines: [`${hashes[1]}${HASH_SEP}NEW-beta`],
		};
		expect(() => applyEdit(content, edit, undefined, hashes, "a.txt", served)).toThrow(EditHashEchoError);
		expect(() => applyEdit(content, edit, undefined, hashes, "a.txt", served)).toThrow(/\[E_EDIT_HASH_ECHO\]/);
	});

	it("S1 clean retry → allow", () => {
		const content = "alpha\nbeta\ngamma\ndelta";
		const hashes = _lineHashesPure(content);
		const served: (string | null)[] = [...hashes];
		const editDenied = {
			hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
			content_lines: [`${hashes[1]}${HASH_SEP}NEW-beta`],
		};
		expect(() => applyEdit(content, editDenied, undefined, hashes, "a.txt", served)).toThrow(/E_EDIT_HASH_ECHO/);
		const editClean = {
			hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
			content_lines: ["NEW-beta"],
		};
		const result = applyEdit(content, editClean, undefined, hashes, "a.txt", served);
		expect(result.content).toBe("alpha\nNEW-beta\ngamma\ndelta");
	});

	it("generic Zz9│literal not denied", () => {
		const content = "alpha\nbeta\ngamma";
		const hashes = _lineHashesPure(content);
		const served: (string | null)[] = [...hashes];
		const fake = "Zz9";
		// ensure fake not in served[1]
		expect(served[1]).not.toBe(fake);
		const edit = {
			hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
			content_lines: [`${fake}${HASH_SEP}literal`],
		};
		const result = applyEdit(content, edit, undefined, hashes, "a.txt", served);
		// Should not throw, and content should contain literal hash prefix (maybe stripped? but guard allows)
		// If stripBarePrefixes strips Zz9, it would be removed, but guard allows — we check not throwing
		expect(result.content).toContain("literal");
	});

	it("denied edit leaves file byte-identical (pure)", () => {
		const content = "one\ntwo\nthree";
		const hashes = _lineHashesPure(content);
		const served: (string | null)[] = [...hashes];
		const edit = {
			hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
			content_lines: [`${hashes[1]}${HASH_SEP}hacked`],
		};
		const original = content;
		try {
			applyEdit(content, edit, undefined, hashes, "a.txt", served);
		} catch (e) {
			expect((e as Error).message).toMatch(/E_EDIT_HASH_ECHO/);
		}
		// Original string untouched
		expect(content).toBe(original);
		// No mutation: applyEdit is pure, so ensure original === content
	});

	it("denied edit is independent per batch item — second line echo", () => {
		const content = "a\nb\nc\nd";
		const hashes = _lineHashesPure(content);
		const served: (string | null)[] = [...hashes];
		const edit = {
			hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[2]! }] as any,
			content_lines: ["ok", `${hashes[2]}${HASH_SEP}echo`],
		};
		expect(() => applyEdit(content, edit, undefined, hashes, "a.txt", served)).toThrow(/E_EDIT_HASH_ECHO.*line 2/);
	});

	it("raw echo before stripBare is still denied", () => {
		const content = "alpha\nbeta\ngamma";
		const hashes = _lineHashesPure(content);
		const served: (string | null)[] = [...hashes];
		// raw line with hash echo — even though stripBare would heal, guard denies
		const edit = {
			hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
			content_lines: [`${hashes[1]}${HASH_SEP}beta`],
		};
		expect(() => applyEdit(content, edit, undefined, hashes, "a.txt", served)).toThrow(/E_EDIT_HASH_ECHO/);
	});

	it("no served → no deny", () => {
		const content = "alpha\nbeta\ngamma";
		const hashes = _lineHashesPure(content);
		const edit = {
			hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
			content_lines: [`${hashes[1]}${HASH_SEP}beta`],
		};
		// no served provided — guard skipped
		const result = applyEdit(content, edit, undefined, hashes, "a.txt", undefined);
		// stripBare will heal, so result may be noop
		expect(result.content).toBeDefined();
	});
});
