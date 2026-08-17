import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { editToolSchema } from "../../src/edit";
import {
	setupIntegrationTest,
	withTempFile,
	useTestHome,
} from "../support/fixtures";
const home = useTestHome();

describe("editToolSchema", () => {
	it("has the exact tuple shape", () => {
		const schema = editToolSchema as any;
		expect(schema.type).toBe("array");
		expect(schema.items).toHaveLength(3);
		expect(schema.items[0].anyOf).toBeDefined();
		expect(schema.items[1].type).toBe("array");
		expect(schema.items[1].items).toHaveLength(2);
	});
});

describe("regEdit", () => {
	it("edits a single line via execute", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			const result = await editTool.execute(
				"e1",
				["sample.txt", [hashes[1]!, hashes[1]!], "BBB"],
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(result.content[0].text).toContain(
				"Successfully edited in sample.txt",
			);
			expect(result.content[0].text).toContain(
				"Added 1 line(s), removed 1 line(s).",
			);
		});
	});

	it("edits a range of lines via execute", async () => {
		await withTempFile(
			"sample.txt",
			"aaa\nbbb\nccc\nddd\n",
			async ({ cwd }) => {
				const { readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", home.testPath);
				await readTool.execute(
					"r1",
					{ path: "sample.txt" },
					undefined,
					undefined,
					{ cwd } as any,
				);

				const result = await editTool.execute(
					"e1",
					["sample.txt", [hashes[1]!, hashes[2]!], "BBB\nCCC"],
					undefined,
					undefined,
					{ cwd } as any,
				);

				expect(result.content[0].text).toContain(
					"Successfully edited in sample.txt",
				);
				expect(result.content[0].text).toContain(
					"Added 2 line(s), removed 2 line(s).",
				);
			},
		);
	});

	it("deletes a line via execute (empty content_lines)", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			const result = await editTool.execute(
				"e1",
				["sample.txt", [hashes[1]!, hashes[1]!], ""],
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(result.content[0].text).toContain(
				"Successfully edited in sample.txt",
			);
			expect(result.content[0].text).toContain(
				"Added 0 line(s), removed 1 line(s).",
			);
		});
	});

	it("reports noop when content is unchanged", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			const result = await editTool.execute(
				"e1",
				["sample.txt", [hashes[1]!, hashes[1]!], "bbb"],
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(result.content[0].text).toContain("No changes made to sample.txt");
			expect(result.details.classification).toBe("noop");
		});
	});

	it("rejects stale anchors with [E_STALE_ANCHOR]", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
			const { editTool } = setupIntegrationTest(cwd);

			await expect(
				editTool.execute(
					"e1",
					["sample.txt", ["ZZZ", "ZZZ"], "x"],
					undefined,
					undefined,
					{ cwd } as any,
				),
			).rejects.toThrow(/E_STALE_ANCHOR/);
		});
	});

	it("rejects deleting an entire non-empty file", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
			const { readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			await expect(
				editTool.execute(
					"e1",
					["sample.txt", [hashes[0]!, hashes[1]!], ""],
					undefined,
					undefined,
					{ cwd } as any,
				),
			).rejects.toThrow(/E_WOULD_EMPTY/);
		});
	});

	it("rejects unknown fields at top level via schema validation", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.txt",
						remove_from: hashes[1]!,
						remove_to: hashes[1]!,
						replacement_text: "BBB",
						unknown_field: "bad",
					} as any,
					undefined,
					undefined,
					{ cwd } as any,
				),
			).rejects.toThrow(/E_BAD_SHAPE/);
		});
	});

	it("reports metrics with edits_attempted = 1", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
			await readTool.execute(
				"r1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			const result = await editTool.execute(
				"e1",
				["sample.txt", [hashes[1]!, hashes[1]!], "BBB"],
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(result.details.metrics.edits_attempted).toBe(1);
			expect(result.details.metrics.classification).toBe("applied");
		});
	});

	it("preserves CRLF line endings", async () => {
		await withTempFile(
			"crlf.txt",
			"alpha\r\nbeta\r\ngamma\r\n",
			async ({ cwd, path }) => {
				const { readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("alpha\nbeta\ngamma\n", home.testPath);
				await readTool.execute(
					"r1",
					{ path: "crlf.txt" },
					undefined,
					undefined,
					{ cwd } as any,
				);

				await editTool.execute(
					"e1",
					["crlf.txt", [hashes[1]!, hashes[1]!], "BETA"],
					undefined,
					undefined,
					{ cwd } as any,
				);

				const content = await readFile(path, "utf-8");
				expect(content).toBe("alpha\r\nBETA\r\ngamma\r\n");
			},
		);
	});
});
