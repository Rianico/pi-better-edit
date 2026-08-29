import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { prepareFile } from "../../src/file-content/index.js";
import { withTempFile } from "../support/fixtures.js";

describe("FileContent — deep seam", () => {
	it("prepares text with normalized LF, hashes, and preview", async () => {
		await withTempFile("sample.txt", "a\r\nb\r\nc\n", async ({ cwd }) => {
			const res = await prepareFile("sample.txt", cwd, {});
			expect(res.kind).toBe("text");
			expect(res.normalized).toBe("a\nb\nc\n");
			expect(res.bom).toBe("");
			expect(res.fileHashes.length).toBe(3);
			expect(res.preview).toContain("│a");
			expect(res.served.length).toBeGreaterThan(0);
		});
	});

	it("handles BOM and utf-8 note", async () => {
		await withTempFile("bom.txt", "\uFEFFhello\nworld\n", async ({ cwd }) => {
			const res = await prepareFile("bom.txt", cwd, {});
			expect(res.kind).toBe("text");
			expect(res.bom).toBe("\uFEFF");
			expect(res.normalized).toBe("hello\nworld\n");
		});
	});

	it("respects offset/limit in preview", async () => {
		await withTempFile("paged.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
			const res = await prepareFile("paged.txt", cwd, { offset: 2, limit: 2 });
			expect(res.preview).toContain("│b");
			expect(res.preview).toContain("│c");
			expect(res.preview).not.toContain("│a");
		});
	});

	it("short-circuits directory", async () => {
		await withTempFile("sample.txt", "x\n", async ({ cwd }) => {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(join(cwd, "subdir"));
			const res = await prepareFile("subdir", cwd, {});
			expect(res.kind).toBe("directory");
			expect(res.preview).toBe("");
			expect(res.fileHashes).toEqual([]);
		});
	});

	it("reports oversize line via preview warning", async () => {
		await withTempFile("big.txt", `${"x".repeat(250 * 1024)}\n`, async ({ cwd }) => {
			const res = await prepareFile("big.txt", cwd, {});
			expect(res.kind).toBe("text");
			expect(res.preview).toContain("exceeds");
		});
	});

	it("snapshot hit via loader cache", async () => {
		await withTempFile("cache.txt", "hello\n", async ({ cwd }) => {
			const a = await prepareFile("cache.txt", cwd, {});
			const b = await prepareFile("cache.txt", cwd, {});
			expect(a.fileHashes).toEqual(b.fileHashes);
		});
	});
});
