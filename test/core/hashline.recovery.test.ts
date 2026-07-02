import { describe, expect, it } from "vitest";
import {
  applyEdits,
  lineHash,
  lineHashes,
  resEdits,
  type Anchor,
  type HEdit,
  type HTEdit,
} from "../../src/hashline";
import { makeTag } from "../support/fixtures";

describe("applyEdits — error handling", () => {
	it("throws on hash mismatch", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [{ hash: "#XXPM" }, { hash: "#XXPM" }], content_lines: ["BBB"] },
		];
		expect(() => applyEdits(content, edits)).toThrow(/E_STALE_ANCHOR/);
	});

	it("throws when the hash matches no line in the file", () => {
		const content = "aaa\nbbb";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [{ hash: "ZZPM" }, { hash: "ZZPM" }], content_lines: ["x"] },
		];
		expect(() => applyEdits(content, edits)).toThrow(
			/2 stale anchors: "ZZPM", "ZZPM"/,
		);
	});

	it("throws on range start > end", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [makeTag(content, 3), makeTag(content, 1)],
				content_lines: ["x"],
			},
		];
		expect(() => applyEdits(content, edits)).toThrow(
			/must be <= end line/,
		);
	});

	it("reports multiple mismatches at once", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [{ hash: "#XXPM" }, { hash: "#XXPM" }], content_lines: ["A"] },
			{ hash_range_inclusive: [{ hash: "#YYWV" }, { hash: "#YYWV" }], content_lines: ["C"] },
		];
		expect(() => applyEdits(content, edits)).toThrow(
			/4 stale anchors/,
		);
	});

	it("lists stale anchor hashes in mismatch errors", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [{ hash: "#XXPM" }, { hash: "#XXPM" }], content_lines: ["A"] },
			{ hash_range_inclusive: [{ hash: "#YYWV" }, { hash: "#YYWV" }], content_lines: ["C"] },
		];
		expect(() => applyEdits(content, edits)).toThrow(
			/4 stale anchors: "#XXPM", "#XXPM", "#YYWV", "#YYWV"/,
		);
	});

	it("mismatch message contains actionable guidance", () => {
		expect(() =>
			applyEdits("aaa", [
				{
					hash_range_inclusive: [{ hash: "ZZPM" }, { hash: "ZZPM" }], content_lines: ["bbb"],
				} as any,
			]),
		).toThrow(/Call read\(\) to get fresh anchors/);
	});

	it("rejects overlapping replace ranges in one request", () => {
		const content = "aaa\nbbb\nccc\nddd";
		expect(() =>
			applyEdits(content, [
				{
					hash_range_inclusive: [makeTag(content, 2), makeTag(content, 3)],
				content_lines: ["X"],
				},
				{
					hash_range_inclusive: [makeTag(content, 3), makeTag(content, 3)], content_lines: ["Y"],
				},
			]),
		).toThrow(/E_EDIT_CONFLICT.*overlap.*same original line range/i);
	});
});

describe("applyEdits — heuristics", () => {
	it("warns on trailing } that duplicates the next surviving line", () => {
		const content = "if (ok) {\n  run();\n}\nafter();";
		const hashes = lineHashes(content);
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [makeTag(content, 1), makeTag(content, 2)],
				content_lines: ["if (ok) {", "  runSafe();", "}"],
			},
		];
		const result = applyEdits(content, edits);

		expect(result.content).toBe("if (ok) {\n  runSafe();\n}\n}\nafter();");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings![0]).toContain("Boundary duplication (trailing)");
		expect(result.warnings![0]).toContain("│  runSafe();");
		expect(result.warnings![0]).toContain(`${hashes[2]}│}`);
	});

	it("warns on trailing } that duplicates the next line", () => {
		const content = "function foo() {\n  const x = 1;\n  return x;\n}";
		const hashes = lineHashes(content);
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [makeTag(content, 2), makeTag(content, 3)],
				content_lines: ["  const y = 2;", "  return y;", "}"],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("function foo() {\n  const y = 2;\n  return y;\n}\n}");
		expect(result.warnings).toBeDefined();
		expect(result.warnings![0]).toContain("Boundary duplication (trailing)");
	});

	it("warns on trailing }); that duplicates the next line", () => {
		const content = "app.get(\"/api\", (req, res) => {\n  const data = fetchData();\n  res.json(data);\n});";
		const hashes = lineHashes(content);
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [makeTag(content, 2), makeTag(content, 3)],
				content_lines: ["  const result = processData();", "  res.json(result);", "});"],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("app.get(\"/api\", (req, res) => {\n  const result = processData();\n  res.json(result);\n});\n});");
		expect(result.warnings).toBeDefined();
		expect(result.warnings![0]).toContain("Boundary duplication (trailing)");
	});

	it("warns on trailing } else { that duplicates the next line", () => {
		const content = "if (condition) {\n  doSomething();\n} else {\n  doOther();\n}";
		const hashes = lineHashes(content);
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [makeTag(content, 1), makeTag(content, 2)],
				content_lines: ["if (condition) {", "  doNewThing();", "} else {"],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("if (condition) {\n  doNewThing();\n} else {\n} else {\n  doOther();\n}");
		expect(result.warnings).toBeDefined();
		expect(result.warnings![0]).toContain("Boundary duplication (trailing)");
	});

	it("warns on trailing duplicate even when mid-replacement also has matching lines", () => {
		const content = "a\n}\nb";
		const hashes = lineHashes(content);
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [makeTag(content, 1), makeTag(content, 1)],
				content_lines: ["x", "}", "y", "}"],
			},
		];
		const result = applyEdits(content, edits);

		expect(result.content).toBe("x\n}\ny\n}\n}\nb");
		expect(result.warnings).toBeDefined();
		expect(result.warnings![0]).toContain("Boundary duplication (trailing)");
	});

	it("preserves leading boundary-looking lines in replacements", () => {
		const content = "before();\nif (ok) {\n  run();\n}\nafter();";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [makeTag(content, 2), makeTag(content, 3)],
				content_lines: ["before();", "if (ok) {", "  runSafe();"],
			},
		];
		const result = applyEdits(content, edits);

		expect(result.content).toBe(
			"before();\nbefore();\nif (ok) {\n  runSafe();\n}\nafter();",
		);
		const hashes = lineHashes(content);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings![0]).toContain("Boundary duplication (leading)");
		expect(result.warnings![0]).toContain(`${hashes[0]}│before();`);
	});

	it("does not auto-correct escaped tab indentation", () => {
		const content = "root\n\tchild\n\t\tvalue\nend";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [makeTag(content, 3), makeTag(content, 3)], content_lines: ["\\t\\treplaced"],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("root\n\tchild\n\\t\\treplaced\nend");
		expect(result.warnings).toBeUndefined();
		expect(edits[0]).toEqual({
			hash_range_inclusive: [makeTag(content, 3), makeTag(content, 3)], content_lines: ["\\t\\treplaced"],
		});
	});

	it("warns on literal \\uDDDD without changing content", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [makeTag(content, 2), makeTag(content, 2)], content_lines: ["\\uDDDD"],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\n\\uDDDD\nccc");
		expect(result.warnings?.[0]).toContain("Detected literal \\uDDDD");
	});

	it("replaces a 1-line range with multiple lines (start == end, no warning)", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [makeTag(content, 2), makeTag(content, 2)], content_lines: ["x1", "x2", "x3"],
			},
		];
		const result = applyEdits(content, edits);

		expect(result.content).toBe("aaa\nx1\nx2\nx3\nccc\nddd");
		expect(result.warnings?.some((w) => w.includes("Single-anchor replace"))).toBeFalsy();
	});

	it("does not warn when a single-anchor replace receives one line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [makeTag(content, 2), makeTag(content, 2)], content_lines: ["BBB"],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nccc");
		expect(result.warnings).toBeUndefined();
	});

	it("does not warn when end is supplied for a range replace", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [makeTag(content, 2), makeTag(content, 3)],
				content_lines: ["x1", "x2", "x3"],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nx1\nx2\nx3\nddd");
		expect(
			result.warnings?.some((w) => w.includes("Single-anchor replace")) ??
				false,
		).toBe(false);
	});
});

describe("integration: resEdits → applyEdits", () => {
	it("full pipeline: tool-schema edit → resolve → apply", () => {
		const content = "aaa\nbbb\nccc";
		const hash = lineHashes(content)[1]!;
		const toolEdits: HTEdit[] = [
			{ hash_range_inclusive: [hash, hash], content_lines: ["BBB"] },
		];
		const resolved = resEdits(toolEdits);
		const result = applyEdits(content, resolved);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});

	it("full pipeline: string content_lines are rejected", () => {
		const content = "aaa\nbbb\nccc";
		const hash = lineHashes(content)[1]!;
		const toolEdits: HTEdit[] = [
			{ hash_range_inclusive: [hash, hash], content_lines: "BBB" } as unknown as HTEdit,
		];
		expect(() => resEdits(toolEdits)).toThrow(
			/content_lines" must be a string array/i,
		);
	});

	it("full pipeline: null content_lines are rejected instead of deleting", () => {
		const content = "aaa\nbbb\nccc";
		const hash = lineHashes(content)[1]!;
		const toolEdits: HTEdit[] = [
			{ hash_range_inclusive: [hash, hash], content_lines: null } as unknown as HTEdit,
		];
		expect(() => resEdits(toolEdits)).toThrow(
			/content_lines" must be a string array/i,
		);
	});

	it("full pipeline: hashline-prefixed array content_lines are rejected (no autocorrection)", () => {
		const content = "aaa\nbbb\nccc";
		const hash = lineHashes(content)[1]!;

		const toolEdits: HTEdit[] = [
			{ hash_range_inclusive: [hash, hash], content_lines: [`+${hash}│BBB`] },
		];
		expect(() => resEdits(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("full pipeline: copied diff-preview hunks are rejected (no autocorrection)", () => {
		const content = "aaa\nbbb\nccc";
		const hashes = lineHashes(content);
		const start = hashes[0]!;
		const end = hashes[2]!;
		const replacement = [
			` ${hashes[0]!}:aaa`,
			"-2    bbb",
			`+${hashes[1]!}:BBB`,
			` ${hashes[2]!}:ccc`,
		];
		const toolEdits: HTEdit[] = [
			{ hash_range_inclusive: [start, end], content_lines: replacement },
		];
		expect(() => resEdits(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("full pipeline: tool-level content_lines:[\"\"] is normalized to a delete (no extra blank line)", () => {

		const content = "aaa\nbbb\nccc\n";
		const hash = lineHashes(content)[1]!;
		const toolEdits: HTEdit[] = [
			{ hash_range_inclusive: [hash, hash], content_lines: [""] },
		];
		const resolved = resEdits(toolEdits);
		const result = applyEdits(content, resolved);
		expect(result.content).toBe("aaa\nccc\n");
	});
});
