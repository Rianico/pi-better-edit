import { describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	computeLineHashes,
	resolveEditAnchors,
	type HashlineToolEdit,
} from "../../src/hashline";

describe("strict edit input (no autocorrection)", () => {
	it("rejects bare HASH| prefix in content with E_BARE_HASH_PREFIX", () => {
		const file = "foo\nbar";
		const hashes = computeLineHashes(file);
		const toolEdits: HashlineToolEdit[] = [
			{ old_range: [hashes[0]!, hashes[0]!], new_lines: [`${hashes[0]!}│foo`] },
		];
		let caught: Error | undefined;
		try {
			applyHashlineEdits(file, resolveEditAnchors(toolEdits));
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/^\[E_BARE_HASH_PREFIX\]/);
		expect(caught!.message).toMatch(/match file line hashes/);
	});

	it("rejects string new_lines before patch-prefix validation", () => {
		const file = "foo\nbar";
		const hashes = computeLineHashes(file);
		const toolEdits: HashlineToolEdit[] = [
			{
				old_range: [hashes[0]!, hashes[0]!], new_lines: `+${hashes[0]!}:foo`,
			} as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(
			/new_lines" must be a string array/i,
		);
	});

	it("rejects diff deletion rows in array form", () => {
		const file = "foo\nbar";
		const hashes = computeLineHashes(file);
		const toolEdits: HashlineToolEdit[] = [
			{ old_range: [hashes[0]!, hashes[0]!], new_lines: ["-1    foo"] },
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("accepts plain literal content unchanged", () => {
		const file = "foo\nbar";
		const hashes = computeLineHashes(file);
		const toolEdits: HashlineToolEdit[] = [
			{ old_range: [hashes[0]!, hashes[0]!], new_lines: ["bar"] },
		];
		const resolved = resolveEditAnchors(toolEdits);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]!.new_lines).toEqual(["bar"]);
	});

	it("preserves '#' comment lines that do not match the strict prefix", () => {
		const file = "foo\nbar";
		const hashes = computeLineHashes(file);
		const toolEdits: HashlineToolEdit[] = [
			{ old_range: [hashes[0]!, hashes[0]!], new_lines: ["# keep me"] },
		];
		const resolved = resolveEditAnchors(toolEdits);
		expect(resolved[0]!.new_lines).toEqual(["# keep me"]);
	});
});

describe("partial hash prefixes copied into content (issue #24)", () => {
	const file = "alpha\nbeta\ngamma\ndelta";
	const hashes = computeLineHashes(file);
	const anchor = hashes[0]!;
	const betaHash = hashes[1]!;
	const gammaHash = hashes[2]!;

	function applyTool(toolEdits: HashlineToolEdit[]) {
		return applyHashlineEdits(file, resolveEditAnchors(toolEdits));
	}

	it("rejects with E_BARE_HASH_PREFIX when a bare prefix matches an existing file line hash", () => {
		let caught: Error | undefined;
		try {
			applyTool([
				{ old_range: [anchor, anchor], new_lines: [`${betaHash}│### heading`, "real content"] },
			]);
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/^\[E_BARE_HASH_PREFIX\]/);
		expect(caught!.message).toContain(`${betaHash}│### heading`);
		expect(caught!.message).toMatch(/match file line hashes/);
	});

	it("rejects valid literal 'HHHH:' content when HHHH exists in the file hash set", () => {
		let caught: Error | undefined;
		try {
			applyTool([
				{ old_range: [anchor, anchor], new_lines: [`${gammaHash}│text`] },
			]);
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/^\[E_BARE_HASH_PREFIX\]/);
		expect(caught!.message).toContain(`${gammaHash}│text`);
	});

	it("rejects even when bare prefixes miss the file hash set (no 'strong signal' gate)", () => {
		let caught: Error | undefined;
		try {
			applyTool([
			{ old_range: [anchor, anchor], new_lines: ["ZZZ│one", "ZZP│two"] },
			]);
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/^\[E_BARE_HASH_PREFIX\]/);
		expect(caught!.message).toMatch(/None match file line hashes/);
	});

	it("reports the edit index and new_lines index for each offending line", () => {
		let caught: Error | undefined;
		try {
			applyTool([
				{ old_range: [anchor, anchor], new_lines: ["ZZZ│one"] },
				{ old_range: [anchor, anchor], new_lines: ["real", "ZZP│two"] },
			]);
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/edit 0, new_lines\[0\]/);
		expect(caught!.message).toMatch(/edit 1, new_lines\[1\]/);
	});

	it("accepts a single legit 'TS: TypeScript' line without warning", () => {
		const result = applyTool([
			{ old_range: [anchor, anchor], new_lines: ["TS: TypeScript"] },
		]);
		expect(result.warnings ?? []).toEqual([]);
		expect(result.content).toContain("TS: TypeScript");
	});

	it("does not false-positive on shorter valid-content prefixes like '#' or '+'", () => {
		const result = applyTool([
			{ old_range: [anchor, anchor], new_lines: ["# heading"] },
		]);
		expect(result.warnings ?? []).toEqual([]);
	});
});
