import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { loadFileKindAndText, classifyFileKind } from "../../src/file-kind";
import { withTempFile } from "../support/fixtures";

describe("loadFileKindAndText", () => {
	it("reads a text file and returns its content", async () => {
		await withTempFile("sample.txt", "hello\nworld\n", async ({ cwd }) => {
			const result = await loadFileKindAndText(join(cwd, "sample.txt"));
			expect(result.kind).toBe("text");
			if (result.kind === "text") {
				expect(result.text).toBe("hello\nworld\n");
				expect(result.hadUtf8DecodeErrors).toBeUndefined();
			}
		});
	});

	it("returns empty text for an empty file", async () => {
		await withTempFile("empty.txt", "", async ({ cwd }) => {
			const result = await loadFileKindAndText(join(cwd, "empty.txt"));
			expect(result.kind).toBe("text");
			if (result.kind === "text") {
				expect(result.text).toBe("");
			}
		});
	});

	it("detects a directory", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const dirPath = join(cwd, "subdir");
			await mkdir(dirPath);
			const result = await loadFileKindAndText(dirPath);
			expect(result.kind).toBe("directory");
		});
	});

	it("detects null bytes and returns binary kind", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const binPath = join(cwd, "binary.bin");
			await writeFile(binPath, Buffer.from([0x48, 0x00, 0x65, 0x6c, 0x6c, 0x6f]));
			const result = await loadFileKindAndText(binPath);
			if (result.kind === "binary") {
				expect(result.description).toContain("null bytes");
			}
		});
	});

	it("detects non-UTF-8 bytes and flags hadUtf8DecodeErrors", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const legacyPath = join(cwd, "legacy.bin");
			await writeFile(legacyPath, Buffer.from([0x61, 0x62, 0x63, 0x80, 0x81]));
			const result2 = await loadFileKindAndText(legacyPath);
			expect(result2.kind).toBe("text");
			if (result2.kind === "text") {
				expect(result2.hadUtf8DecodeErrors).toBe(true);
			}
		});
	});
});

describe("classifyFileKind", () => {
	it("classifies a text file as text", async () => {
		await withTempFile("sample.txt", "hello\n", async ({ cwd }) => {
			const result = await classifyFileKind(join(cwd, "sample.txt"));
			expect(result).toEqual({ kind: "text" });
		});
	});

	it("classifies a directory as directory", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const dirPath = join(cwd, "subdir");
			await mkdir(dirPath);
			const result = await classifyFileKind(dirPath);
			expect(result).toEqual({ kind: "directory" });
		});
	});

	it("classifies a binary file as binary", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const binPath = join(cwd, "binary.bin");
			await writeFile(binPath, Buffer.from([0x00, 0x61]));
			const result = await classifyFileKind(binPath);
			expect(result.kind).toBe("binary");
		});
	});
});
