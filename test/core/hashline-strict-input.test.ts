import { describe, expect, it } from "vitest";
import {
	applyEdits,
	lineHashes,
	resEdits,
	type HTEdit,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("edit input validation", () => {
	it("strips bare HASH| prefix in content with warning", async () => {
		const file = "foo\nbar";
		const hashes = await lineHashes(file, home.testPath);
		const toolEdits: HTEdit[] = [
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: [`${hashes[0]!}│FOO`] },
    ];
    const result = applyEdits(file, resEdits(toolEdits));
    expect(result.content).toBe("FOO\nbar");
    expect(result.warnings?.[0]).toMatch(/Autocorrected edit 0: stripped "HASH│" prefix/);
    expect(result.warnings?.[0]).toMatch(/content_lines\[0\]/);
    expect(result.warnings?.[0]).toMatch(/1 of 1 stripped hash\(es\) match current file lines/);
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

	it("strips a bare prefix that matches an existing file line hash", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const betaHash = hashes[1]!;
		const result = applyTool([
      { hash_range_inclusive: [anchor, anchor], content_lines: [`${betaHash}│### heading`, "real content"] },
    ], hashes);
    expect(result.content).toBe("### heading\nreal content\nbeta\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/1 of 1 stripped hash\(es\) match current file lines/);
	});

	it("strips a bare prefix whose hash exists in the file hash set", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const gammaHash = hashes[2]!;
		const result = applyTool([
      { hash_range_inclusive: [anchor, anchor], content_lines: [`${gammaHash}│text`] },
    ], hashes);
    expect(result.content).toBe("text\nbeta\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/1 of 1 stripped hash\(es\) match current file lines/);
	});

	it("strips bare prefixes even when the hash is not in the file hash set", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool([
      { hash_range_inclusive: [anchor, anchor], content_lines: ["ZZZ│one", "ZZP│two"] },
    ], hashes);
    expect(result.content).toBe("one\ntwo\nbeta\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/none of the stripped hashes match current file lines/);
	});

	it("reports the edit index and content_lines index for each stripped line", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool([
      { hash_range_inclusive: [anchor, anchor], content_lines: ["ZZZ│one"] },
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["real", "ZZP│two"] },
    ], hashes);
    expect(result.content).toBe("one\nreal\ntwo\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/edit 0.*content_lines\[0\]/);
    expect(result.warnings?.[1]).toMatch(/edit 1.*content_lines\[1\]/);
	});

	it("keeps indentation after the separator while dropping leading prefix whitespace", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool([
      { hash_range_inclusive: [anchor, anchor], content_lines: [`  ${hashes[1]!}│  indented`] },
    ], hashes);
    expect(result.content).toBe("  indented\nbeta\ngamma\ndelta");
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

	it("strips prefixes from long lines without truncation", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const betaHash = hashes[1]!;
		const longLine = `${betaHash}│${"y".repeat(500)}`;
		const result = applyTool([
      { hash_range_inclusive: [anchor, anchor], content_lines: [longLine] },
    ], hashes);
    expect(result.content).toContain("y".repeat(500));
    expect(result.content).not.toContain("│");
	});
});
