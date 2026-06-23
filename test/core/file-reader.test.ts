import { describe, expect, it } from "vitest";
import { readNormFile } from "../../src/file-reader";
import { withTempFile } from "../support/fixtures";

describe("readNormFile", () => {
	it("reads a normal file and returns NormFile with correct fields", async () => {
		await withTempFile("sample.txt", "hello\nworld", async ({ cwd }) => {
			const result = await readNormFile("sample.txt", cwd, undefined);
			expect(result.absolutePath).toMatch(/sample\.txt$/);
			expect(result.normalized).toBe("hello\nworld");
			expect(result.bom).toBe("");
			expect(result.originalEnding).toBe("\n");
			expect(result.fileHashes).toHaveLength(2);
			expect(result.fileHashes[0]).toMatch(/^[A-Za-z0-9_\-]{3}$/);
			expect(result.fileHashes[1]).toMatch(/^[A-Za-z0-9_\-]{3}$/);
			expect(result.hadUtf8DecodeErrors).toBe(false);
		});
	});

	it("handles UTF-8 files with BOM (BOM stripped by TextDecoder)", async () => {
		await withTempFile("bom.txt", "hello", async ({ cwd, path }) => {
			const { writeFile } = await import("fs/promises");
			await writeFile(path, "\uFEFFhello\n", "utf-8");
			const result = await readNormFile("bom.txt", cwd, undefined);
			expect(result.bom).toBe("");
			expect(result.normalized).toBe("hello\n");
		});
	});

	it("detects CRLF line endings and normalizes to LF", async () => {
		await withTempFile("crlf.txt", "hello", async ({ cwd, path }) => {
			const { writeFile } = await import("fs/promises");
			await writeFile(path, "alpha\r\nbeta\r\n", "utf-8");
			const result = await readNormFile("crlf.txt", cwd, undefined);
			expect(result.originalEnding).toBe("\r\n");
			expect(result.normalized).toBe("alpha\nbeta\n");
		});
	});

	it("detects LF line endings and leaves content unchanged", async () => {
		await withTempFile("lf.txt", "alpha\nbeta", async ({ cwd }) => {
			const result = await readNormFile("lf.txt", cwd, undefined);
			expect(result.originalEnding).toBe("\n");
			expect(result.normalized).toBe("alpha\nbeta");
		});
	});

	it("uses a preloaded LFile when provided", async () => {
		await withTempFile("sample.txt", "ignored", async ({ cwd }) => {
			const preloaded = {
				kind: "text" as const,
				text: "preloaded\ncontent",
			};
			const result = await readNormFile("sample.txt", cwd, undefined, undefined, preloaded);
			expect(result.normalized).toBe("preloaded\ncontent");
		});
	});

	it("throws File not found for non-existent file", async () => {
		await expect(
			readNormFile("nonexistent.txt", "/tmp", undefined),
		).rejects.toThrow("File not found");
	});

	it("computes correct hashes for the normalized content", async () => {
		await withTempFile("data.txt", "aaa\nbbb\nccc", async ({ cwd }) => {
			const result = await readNormFile("data.txt", cwd, undefined);
			expect(result.fileHashes).toHaveLength(3);

			for (const hash of result.fileHashes) {
			}

			expect(result.fileHashes[0]).not.toBe(result.fileHashes[1]);
			expect(result.fileHashes[1]).not.toBe(result.fileHashes[2]);
		});
	});

	it("handles a file without trailing newline", async () => {
		await withTempFile("notrailing.txt", "hello\nworld", async ({ cwd }) => {
			const result = await readNormFile("notrailing.txt", cwd, undefined);
			expect(result.normalized).toBe("hello\nworld");
			expect(result.fileHashes).toHaveLength(2);
		});
	});

	it("handles bare CR line endings (old Mac style)", async () => {
		await withTempFile("oldmac.txt", "hello", async ({ cwd, path }) => {
			const { writeFile } = await import("fs/promises");
			await writeFile(path, "alpha\rbeta\r", "utf-8");
			const result = await readNormFile("oldmac.txt", cwd, undefined);
			expect(result.normalized).toBe("alpha\nbeta\n");
		});
	});
});
