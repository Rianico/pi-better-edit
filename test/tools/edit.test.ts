import { describe, expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import {
	withTempFile,
	setupIntegrationTest,
	useTestHome,
} from "../support/fixtures";

const home = useTestHome();

describe("regEdit", () => {
	it("rejects malformed null lines during direct execute without modifying the file", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);

			await expect(
				editTool.execute(
					"e1",
					{ path: "sample.ts", edits: [[hashes[0]!, hashes[0]!, null]] },
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow();
		});
	});

	it("accepts multi-line replacement_text with \\n separators", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);

			const result = await editTool.execute(
				"e1",
				{ path: "sample.ts", edits: [[hashes[0]!, hashes[0]!, "a\nb"]] },
				undefined,
				undefined,
				ctx,
			);
			expect(result.content[0].text).toContain("Successfully edited");

			const content = await readFile(path, "utf-8");
			expect(content).toBe("a\nb\nbbb\n");
		});
	});

	it("renders details diff while keeping diff out of LLM-visible text", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);

			const result = await editTool.execute(
				"e1",
				{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "BBB"]] },
				undefined,
				undefined,
				ctx,
			);
			expect(result.content[0].text).toContain("Successfully edited");
			expect(result.content[0].text).toContain(
				"Added 1 line(s), removed 1 line(s).",
			);
			expect(result.details?.diff).toBeDefined();
			expect(result.details?.diff).toContain("BBB");
		});
	});

	it("autocorrects bare HASH│ prefix in content_lines with a warning", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);

			const result = await editTool.execute(
				"e1",
				{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, `${hashes[1]!}│BBB`]] },
				undefined,
				undefined,
				ctx,
			);
			expect(result.content[0].text).toContain("Successfully edited");
			expect(result.content[0].text).toContain("E_BARE_HASH_PREFIX");
			expect(result.content[0].text).toContain(`stripped "HASH│" prefix`);
			expect(result.details?.diff).toContain("BBB");
			expect(result.details?.diff).not.toContain(`${hashes[1]}│BBB`);
		});
	});

	it("autocorrects diff-preview rows in content_lines with a warning", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);

			const result = await editTool.execute(
				"e1",
				{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, `+${hashes[1]!}│BBB`]] },
				undefined,
				undefined,
				ctx,
			);
			expect(result.content[0].text).toContain("Successfully edited");
			expect(result.content[0].text).toContain("[E_INVALID_PATCH]");
			expect(result.content[0].text).toContain(`stripped diff-preview marker`);
			expect(result.details?.diff).toContain("BBB");
			expect(result.details?.diff).not.toContain(`+${hashes[1]}│BBB`);
		});
	});

	it("autocorrects reversed remove_from/remove_to with correct line counts", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);

			const result = await editTool.execute(
				"e1",
				{ path: "sample.ts", edits: [[hashes[2]!, hashes[1]!, "X"]] },
				undefined,
				undefined,
				ctx,
			);
			expect(result.content[0].text).toContain("Successfully edited");
			expect(result.content[0].text).toContain(
				"Added 1 line(s), removed 2 line(s).",
			);
			expect(result.content[0].text).toContain("[E_BAD_OP]");
			expect(result.content[0].text).toContain(
				"reversed remove_from/remove_to",
			);
			expect(result.details?.diff).toContain("X");
		});
	});

	it("autocorrects HASH│ rows in remove_from/remove_to with a warning", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
				await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);

				const result = await editTool.execute(
					"e1",
					{ path: "sample.ts", edits: [[`${hashes[1]!}│bbb`, `${hashes[1]!}│bbb`, "BBB"]] },
					undefined,
					undefined,
					ctx,
				);
				expect(result.content[0].text).toContain("Successfully edited");
				expect(result.content[0].text).toContain("[E_BAD_REF]");
				expect(result.content[0].text).toContain(`stripped "HASH│" prefix`);
				expect(result.details?.diff).toContain("BBB");
				const content = await readFile(path, "utf-8");
				expect(content).toBe("aaa\nBBB\nccc\n");
			},
		);
	});
});

describe("regEdit — robustness", () => {
	it("reports success even when the post-edit snapshot fails", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
				await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);
				const fileReader = await import("../../src/file-reader");
				const spy = vi
					.spyOn(fileReader, "fileSnap")
					.mockRejectedValue(new Error("stat failed"));
				try {
					const result = await editTool.execute(
						"e1",
						{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "BBB"]] },
						undefined,
						undefined,
						ctx,
					);
					expect(result.content[0].text).toContain("Successfully edited");
					expect(result.details?.snapshotId).toBeUndefined();
				} finally {
					spy.mockRestore();
				}
				const content = await readFile(path, "utf-8");
				expect(content).toBe("aaa\nBBB\nccc\n");
			},
		);
	});

	it("reports success even when the noop-path snapshot fails", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);
			const fileReader = await import("../../src/file-reader");
			const spy = vi
				.spyOn(fileReader, "fileSnap")
				.mockRejectedValue(new Error("stat failed"));
			try {
				const result = await editTool.execute(
					"e1",
					{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "bbb"]] },
					undefined,
					undefined,
					ctx,
				);
				expect(result.content[0].text).toContain("No changes made");
				expect(result.details?.classification).toBe("noop");
			} finally {
				spy.mockRestore();
			}
		});
	});

	it("applies the edit even when snapshot persistence fails", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
				await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);
				const hashStore = await import("../../src/snapshot-store");
				const spy = vi
					.spyOn(hashStore, "upsertSnapshot")
					.mockImplementation(() => {
						throw new Error("store down");
					});
				try {
					const result = await editTool.execute(
						"e1",
						{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "BBB"]] },
						undefined,
						undefined,
						ctx,
					);
					expect(result.content[0].text).toContain("Successfully edited");
				} finally {
					spy.mockRestore();
				}
				const content = await readFile(path, "utf-8");
				expect(content).toBe("aaa\nBBB\nccc\n");
			},
		);
	});

	it("still refuses the edit when undo persistence fails", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
				await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);
				const undoStore = await import("../../src/undo-store");
				const spy = vi.spyOn(undoStore, "writeUndo").mockImplementation(() => {
					throw new Error("store down");
				});
				try {
					await expect(
						editTool.execute(
							"e1",
							{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "BBB"]] },
							undefined,
							undefined,
							ctx,
						),
					).rejects.toThrow(/E_UNDO_UNAVAILABLE/);
				} finally {
					spy.mockRestore();
				}
				const content = await readFile(path, "utf-8");
				expect(content).toBe("aaa\nbbb\nccc\n");
			},
		);
	});
});
