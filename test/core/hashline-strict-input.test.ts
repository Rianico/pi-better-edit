import { describe, expect, it } from "vitest";
import {
	applyEdit,
	lineHashes,
	resEdit,
	type HTEdit,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("edit input validation", () => {
	it("strips bare HASH| prefix in content with warning", async () => {
		const file = "foo\nbar";
		const hashes = await lineHashes(file, home.testPath);
		const toolEdit: HTEdit = { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: [`${hashes[0]!}│FOO`] };
    const result = applyEdit(file, resEdit(toolEdit));
		expect(result.content).toBe("FOO\nbar");
		expect(result.warnings?.[0]).toMatch(/Autocorrected: stripped "HASH│" prefix/);
		expect(result.warnings?.[0]).toMatch(/content_lines\[0\]/);
		expect(result.warnings?.[0]).toMatch(/1 of 1 stripped hash\(es\) match current file lines/);
	});

	it("rejects string content_lines before patch-prefix validation", () => {
		const toolEdit: HTEdit = {
      hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: `+ZZZ:foo`,
    } as unknown as HTEdit;
    expect(() => resEdit(toolEdit)).toThrow(
      /must be a native JSON array of strings, not a JSON string/i,
    );
	});

	it("passes through numbered deletion rows as literal content", () => {
		const toolEdit: HTEdit = { hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: ["-1    foo"] };
    const resolved = resEdit(toolEdit);
		expect(resolved.content_lines).toEqual(["-1    foo"]);
	});

	it("accepts plain literal content unchanged", () => {
		const toolEdit: HTEdit = { hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: ["bar"] };
    const resolved = resEdit(toolEdit);
		expect(resolved.content_lines).toEqual(["bar"]);
	});

	it("preserves '#' comment lines that do not match the strict prefix", () => {
		const toolEdit: HTEdit = { hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: ["# keep me"] };
    const resolved = resEdit(toolEdit);
    expect(resolved.content_lines).toEqual(["# keep me"]);
	});
});

describe("partial hash prefixes copied into content (issue #24)", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
		return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
	}

	it("strips a bare prefix that matches an existing file line hash", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const betaHash = hashes[1]!;
		const result = applyTool(
      { hash_range_inclusive: [anchor, anchor], content_lines: [`${betaHash}│### heading`, "real content"] },
    hashes);
    expect(result.content).toBe("### heading\nreal content\nbeta\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/1 of 1 stripped hash\(es\) match current file lines/);
	});

	it("strips a bare prefix whose hash exists in the file hash set", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const gammaHash = hashes[2]!;
		const result = applyTool(
      { hash_range_inclusive: [anchor, anchor], content_lines: [`${gammaHash}│text`] },
    hashes);
    expect(result.content).toBe("text\nbeta\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/1 of 1 stripped hash\(es\) match current file lines/);
	});

	it("strips bare prefixes even when the hash is not in the file hash set", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { hash_range_inclusive: [anchor, anchor], content_lines: ["ZZZ│one", "ZZP│two"] },
    hashes);
    expect(result.content).toBe("one\ntwo\nbeta\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/none of the stripped hashes match current file lines/);
	});

	it("reports the content_lines index for each stripped line", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { hash_range_inclusive: [anchor, anchor], content_lines: ["ZZZ│one", "real", "ZZP│two"] },
    hashes);
    expect(result.content).toBe("one\nreal\ntwo\nbeta\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/content_lines\[0\], content_lines\[2\]/);
	});

	it("keeps indentation after the separator while dropping leading prefix whitespace", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { hash_range_inclusive: [anchor, anchor], content_lines: [`  ${hashes[1]!}│  indented`] },
    hashes);
    expect(result.content).toBe("  indented\nbeta\ngamma\ndelta");
	});

	it("accepts a single legit 'TS: TypeScript' line without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { hash_range_inclusive: [anchor, anchor], content_lines: ["TS: TypeScript"] },
    hashes);
    expect(result.warnings ?? []).toEqual([]);
		expect(result.content).toContain("TS: TypeScript");
	});

	it("does not false-positive on shorter valid-content prefixes like '#' or '+'", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { hash_range_inclusive: [anchor, anchor], content_lines: ["# heading"] },
    hashes);
    expect(result.warnings ?? []).toEqual([]);
	});

	it("strips prefixes from long lines without truncation", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const betaHash = hashes[1]!;
		const longLine = `${betaHash}│${"y".repeat(500)}`;
		const result = applyTool(
      { hash_range_inclusive: [anchor, anchor], content_lines: [longLine] },
    hashes);
    expect(result.content).toContain("y".repeat(500));
    expect(result.content).not.toContain("│");
	});
});

describe("diff preview rows copied into content", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
		return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
	}

	it("strips +HASH│ addition rows with warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { hash_range_inclusive: [anchor, anchor], content_lines: [`+${hashes[1]!}│### heading`, "real content"] },
    hashes);
		expect(result.content).toBe("### heading\nreal content\nbeta\ngamma\ndelta");
		expect(result.warnings?.[0]).toMatch(/Autocorrected: stripped diff-preview marker/);
		expect(result.warnings?.[0]).toMatch(/content_lines\[0\]/);
	});

	it("strips -HASH│ and -   │ deletion rows with warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { hash_range_inclusive: [anchor, anchor], content_lines: [`-${hashes[1]!}│one`, "-   │two"] },
    hashes);
		expect(result.content).toBe("one\ntwo\nbeta\ngamma\ndelta");
		expect(result.warnings?.[0]).toMatch(/content_lines\[0\], content_lines\[1\]/);
	});

	it("leaves numbered deletion rows as literal content without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { hash_range_inclusive: [anchor, anchor], content_lines: ["-1    foo"] },
    hashes);
		expect(result.content).toBe("-1    foo\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves plain +x / -x unified-diff lines as literal content without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { hash_range_inclusive: [anchor, anchor], content_lines: ["+added", "-removed"] },
    hashes);
		expect(result.content).toBe("+added\n-removed\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});
});
