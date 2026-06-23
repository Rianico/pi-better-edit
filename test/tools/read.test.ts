import { describe, it, expect, vi, beforeEach } from "vitest";
import register from "../../index";
import { fmtRegion, lineHashes } from "../../src/hashline";
import { fmtReadPreview } from "../../src/read";
import { lineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

vi.mock("../../src/file-kind", () => ({
	loadFileKindAndText: vi.fn(),
	classifyFileKind: vi.fn(),
}));

import * as fileKindMod from "../../src/file-kind";

describe("fmtReadPreview", () => {
	it("refuses to emit a truncated hashline for an oversized first line", () => {
		const longLine = "x".repeat(70_000);
		const result = fmtReadPreview(longLine, { offset: 1 });

		expect(result.text).toContain("Hashline output requires full lines");
		expect(result.truncation?.truncated).toBe(true);
		expect(result.truncation?.truncatedBy).toBe("bytes");
		expect(result.truncation?.firstLineExceedsLimit).toBe(true);
	});

	it("formats ordinary lines as HASH|content (no line number)", () => {
		const result = fmtReadPreview("alpha\nbeta", { offset: 1 });

		expect(result.text).not.toMatch(/^\d/m);
		expect(result.text).toContain("│alpha");
		expect(result.text).toContain("│beta");
	});

	it("uses the file's precomputed hash array for visible lines", () => {
		const text = Array.from(
			{ length: 10 },
			(_, index) => `line-${index + 1}`,
		).join("\n");
		const result = fmtReadPreview(text, { offset: 8 });
		const hashes = lineHashes(text);

		expect(result.text.split("\n").slice(0, 3)).toEqual([
			`${hashes[7]}│line-8`,
			`${hashes[8]}│line-9`,
			`${hashes[9]}│line-10`,
		]);
	});

	it("returns an advisory for empty files instead of a synthetic empty-line anchor", () => {
		const result = fmtReadPreview("", { offset: 1 });
		expect(result.text).toContain("File is empty");
		expect(result.text).toContain("Use edit to insert content");
		expect(result.text).not.toMatch(/^\d/m);
	});

	it("hides the terminal newline sentinel from preview output", () => {
		const result = fmtReadPreview("alpha\nbeta\n", { offset: 1 });
		const hashes = lineHashes("alpha\nbeta\n");
		expect(result.text).toContain(`${hashes[0]}│alpha`);
		expect(result.text).toContain(`${hashes[1]}│beta`);
		expect(result.text).not.toMatch(/^\d#/m);
		expect(result.text).not.toContain("2 lines total");
	});

	it("keeps continuation hints for partial previews", () => {
		const result = fmtReadPreview("alpha\nbeta", {
			offset: 1,
			limit: 1,
		});

		expect(result.text).toContain("Use offset=2 to continue");
	});

	it("reports when offset is beyond end of content", () => {
		const result = fmtReadPreview("alpha\nbeta", { offset: 10 });

		expect(result.text).toContain("Offset 10 is beyond end of file");
		expect(result.text).toContain("2 lines total");
	});

	it("rejects fractional offsets", () => {
		expect(() =>
			fmtReadPreview("alpha\nbeta", { offset: 1.5 }),
		).toThrow(/offset.*positive integer/i);
	});

	it("rejects non-positive limits", () => {
		expect(() =>
			fmtReadPreview("alpha\nbeta", { limit: 0 }),
		).toThrow(/limit.*positive integer/i);
	});
});

describe("fmtRegion", () => {
	it("formats lines as HASH|content rows", () => {

		const allLines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
		const content = allLines.join("\n");
		const hashes = lineHashes(content);
		const visibleLines = allLines.slice(4, 7);
		const visibleHashes = hashes.slice(4, 7);
		const result = fmtRegion(visibleHashes, visibleLines);

		expect(result).toBe(
			`${visibleHashes[0]}│line-5\n` +
				`${visibleHashes[1]}│line-6\n` +
				`${visibleHashes[2]}│line-7`,
		);
	});

	it("does not pad line numbers (the format drops them)", () => {
		const allLines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
		const content = allLines.join("\n");
		const hashes = lineHashes(content);
		const visibleLines = allLines.slice(7, 10);
		const visibleHashes = hashes.slice(7, 10);
		const result = fmtRegion(visibleHashes, visibleLines);

		expect(result).toBe(
			`${visibleHashes[0]}│line-8\n` +
				`${visibleHashes[1]}│line-9\n` +
				`${visibleHashes[2]}│line-10`,
		);
	});

	it("handles a single line", () => {
		const result = fmtRegion(["h1h1"], ["hello"]);
		expect(result).toBe(`h1h1│hello`);
	});

	it("handles empty array", () => {
		const result = fmtRegion([], []);
		expect(result).toBe("");
	});
});

describe("read tool protocol", () => {
	beforeEach(() => {
		vi.mocked(fileKindMod.loadFileKindAndText).mockReset();
		vi.mocked(fileKindMod.classifyFileKind).mockReset();
	});

	it("returns the empty-file advisory through the registered tool", async () => {
		await withTempFile("empty.txt", "", async ({ cwd }) => {
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "",
			});

			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const readTool = getTool("read");

			const result = await readTool.execute(
				"r1",
				{ path: "empty.txt" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0].text).toContain("File is empty");
			expect(result.content[0].text).not.toMatch(/^\d/m);
		});
	});

	it("omits the trailing newline sentinel through the registered tool", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "alpha\nbeta\n",
			});

			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const readTool = getTool("read");

			const result = await readTool.execute(
				"r1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(result.content[0].text).toContain("│alpha");
			expect(result.content[0].text).toContain("│beta");
			expect(result.content[0].text).not.toMatch(/^\d#/m);
		});
	});

	it("uses the shared text loader instead of classifying then re-reading text files", async () => {
		await withTempFile("sample.txt", "ignored\n", async ({ cwd }) => {
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "alpha\nbeta\n",
			});
			vi.mocked(fileKindMod.classifyFileKind).mockRejectedValue(
				new Error("read tool should not call classifyFileKind on text paths"),
			);

			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const readTool = getTool("read");

			const result = await readTool.execute(
				"r1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(result.content[0].text).toContain("│alpha");
			expect(result.content[0].text).toContain("│beta");
			expect(vi.mocked(fileKindMod.classifyFileKind)).not.toHaveBeenCalled();
		});
	});

	it("warns that editing rewrites a file containing non-utf-8 bytes", async () => {
		await withTempFile("legacy.c", "ignored\n", async ({ cwd }) => {

			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "int � = 0;\n",
				hadUtf8DecodeErrors: true,
			});

			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const readTool = getTool("read");

			const result = await readTool.execute(
				"r1",
				{ path: "legacy.c" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(result.content[0].text).toContain(
				"editing rewrites the file as UTF-8",
			);
		});
	});

	it("does not warn for clean utf-8 text", async () => {
		await withTempFile("clean.txt", "ignored\n", async ({ cwd }) => {
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "alpha\nvalid � replacement character\n",
			});

			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const readTool = getTool("read");

			const result = await readTool.execute(
				"r1",
				{ path: "clean.txt" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(result.content[0].text).not.toContain("Non-UTF-8");
		});
	});
});
