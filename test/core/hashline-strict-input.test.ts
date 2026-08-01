import { describe, expect, it } from "vitest";
import {
	applyEdits,
	lineHashes,
	resEdits,
	type HTEdit,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("strict edit input (no autocorrection)", () => {
	it("rejects bare HASH| prefix in content with E_BARE_HASH_PREFIX", async () => {
		const file = "foo\nbar";
		const hashes = await lineHashes(file, home.testPath);
		const toolEdits: HTEdit[] = [
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: [`${hashes[0]!}│foo`] },
    ];
    let caught: Error | undefined;
		try {
			applyEdits(file, resEdits(toolEdits));
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/^\[E_BARE_HASH_PREFIX\]/);
		expect(caught!.message).toMatch(/match file line hashes/);
	});

	it("rejects string content_lines before patch-prefix validation", () => {
		const toolEdits: HTEdit[] = [
			{
        hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: `+ZZZ:foo`,
      } as unknown as HTEdit,
    ];
    expect(() => resEdits(toolEdits)).toThrow(
      /must be a native JSON array of strings, not a JSON string/i,
    );
	});

	it("rejects diff deletion rows in array form", () => {
		const toolEdits: HTEdit[] = [
      { hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: ["-1    foo"] },
    ];
    expect(() => resEdits(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("accepts plain literal content unchanged", () => {
		const toolEdits: HTEdit[] = [
      { hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: ["bar"] },
    ];
    const resolved = resEdits(toolEdits);
		expect(resolved).toHaveLength(1);
    expect(resolved[0]!.content_lines).toEqual(["bar"]);
	});

	it("preserves '#' comment lines that do not match the strict prefix", () => {
		const toolEdits: HTEdit[] = [
      { hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: ["# keep me"] },
    ];
    const resolved = resEdits(toolEdits);
    expect(resolved[0]!.content_lines).toEqual(["# keep me"]);
	});
});

describe("partial hash prefixes copied into content (issue #24)", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdits: HTEdit[], precomputedHashes?: string[]) {
		return applyEdits(file, resEdits(toolEdits), undefined, precomputedHashes);
	}

	it("rejects with E_BARE_HASH_PREFIX when a bare prefix matches an existing file line hash", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const betaHash = hashes[1]!;
		let caught: Error | undefined;
		try {
      applyTool([
        { hash_range_inclusive: [anchor, anchor], content_lines: [`${betaHash}│### heading`, "real content"] },
      ], hashes);
    } catch (e) {
      caught = e as Error;
    }
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/^\[E_BARE_HASH_PREFIX\]/);
		expect(caught!.message).toContain(`${betaHash}│### heading`);
		expect(caught!.message).toMatch(/match file line hashes/);
	});

	it("rejects valid literal 'HHHH:' content when HHHH exists in the file hash set", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const gammaHash = hashes[2]!;
		let caught: Error | undefined;
		try {
      applyTool([
        { hash_range_inclusive: [anchor, anchor], content_lines: [`${gammaHash}│text`] },
      ], hashes);
    } catch (e) {
      caught = e as Error;
    }
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/^\[E_BARE_HASH_PREFIX\]/);
		expect(caught!.message).toContain(`${gammaHash}│text`);
	});

	it("rejects even when bare prefixes miss the file hash set (no 'strong signal' gate)", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		let caught: Error | undefined;
		try {
      applyTool([
      { hash_range_inclusive: [anchor, anchor], content_lines: ["ZZZ│one", "ZZP│two"] },
      ], hashes);
    } catch (e) {
      caught = e as Error;
    }
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/^\[E_BARE_HASH_PREFIX\]/);
		expect(caught!.message).toMatch(/None match file line hashes/);
	});

	it("reports the edit index and content_lines index for each offending line", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		let caught: Error | undefined;
		try {
      applyTool([
        { hash_range_inclusive: [anchor, anchor], content_lines: ["ZZZ│one"] },
        { hash_range_inclusive: [anchor, anchor], content_lines: ["real", "ZZP│two"] },
      ], hashes);
    } catch (e) {
      caught = e as Error;
    }
		expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/edit 0, content_lines\[0\]/);
    expect(caught!.message).toMatch(/edit 1, content_lines\[1\]/);
	});

	it("accepts a single legit 'TS: TypeScript' line without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool([
      { hash_range_inclusive: [anchor, anchor], content_lines: ["TS: TypeScript"] },
    ], hashes);
    expect(result.warnings ?? []).toEqual([]);
		expect(result.content).toContain("TS: TypeScript");
	});

	it("does not false-positive on shorter valid-content prefixes like '#' or '+'", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool([
      { hash_range_inclusive: [anchor, anchor], content_lines: ["# heading"] },
    ], hashes);
    expect(result.warnings ?? []).toEqual([]);
	});
});
