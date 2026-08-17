import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";
import {
	withTempFile,
	withTempDir,
	setupIntegrationTest,
	getText,
	extractHash,
} from "../support/fixtures";

async function readBatchTool(ctx: any, readTool: any, path: string) {
	await readTool.execute("r1", { path }, undefined, undefined, ctx);
}

describe("batch_edit tool", () => {
	it("applies disjoint same-file ranges in order", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\nddd\neee\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
				const batchTool = getTool("batch_edit");
				const hashes = await lineHashes("aaa\nbbb\nccc\nddd\neee\n", path);
				await readBatchTool(ctx, readTool, "sample.ts");

				const result = await batchTool.execute(
					"b1",
					{
						edits: [
							{
								path: "sample.ts",
								remove_from: hashes[0]!,
								remove_to: hashes[0]!,
								replacement_text: "AAA",
							},
							{
								path: "sample.ts",
								remove_from: hashes[2]!,
								remove_to: hashes[2]!,
								replacement_text: "CCC",
							},
						],
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(result)).toContain("Successfully edited 1 file(s)");
				expect(getText(result)).toContain("2 of 2 edit(s) applied");
				expect(await readFile(path, "utf-8")).toBe("AAA\nbbb\nCCC\nddd\neee\n");
				expect(result.details.diff).toContain("│AAA");
				expect(result.details.diff).toContain("│CCC");
			},
		);
	});

	it("applies edits across files in one call", async () => {
		await withTempDir("batch-cross-", async (dir) => {
			const first = join(dir, "a.txt");
			const second = join(dir, "b.txt");
			await writeFile(first, "alpha\nbeta\ngamma\n", "utf-8");
			await writeFile(second, "one\ntwo\nthree\n", "utf-8");

			const { ctx, readTool, getTool } = setupIntegrationTest(dir);
			const batchTool = getTool("batch_edit");
			const aHashes = await lineHashes("alpha\nbeta\ngamma\n", first);
			const bHashes = await lineHashes("one\ntwo\nthree\n", second);
			await readBatchTool(ctx, readTool, "a.txt");
			await readBatchTool(ctx, readTool, "b.txt");

			const result = await batchTool.execute(
				"b1",
				{
					edits: [
						{
							path: "a.txt",
							remove_from: aHashes[1]!,
							remove_to: aHashes[1]!,
							replacement_text: "BETA",
						},
						{
							path: "b.txt",
							remove_from: bHashes[1]!,
							remove_to: bHashes[1]!,
							replacement_text: "TWO",
						},
					],
				},
				undefined,
				undefined,
				ctx,
			);
			expect(getText(result)).toContain("Successfully edited 2 file(s)");
			expect(await readFile(first, "utf-8")).toBe("alpha\nBETA\ngamma\n");
			expect(await readFile(second, "utf-8")).toBe("one\nTWO\nthree\n");
			expect(result.details.servedByPath).toHaveLength(2);
		});
	});

	it("matches single-edit behavior for a one-item batch", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
				const batchTool = getTool("batch_edit");
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await readBatchTool(ctx, readTool, "sample.ts");

				const result = await batchTool.execute(
					"b1",
					{
						edits: [
							{
								path: "sample.ts",
								remove_from: hashes[1]!,
								remove_to: hashes[1]!,
								replacement_text: "BBB",
							},
						],
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(result)).toContain("Successfully edited 1 file(s)");
				expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
				expect(result.details.diff).toContain("│BBB");
			},
		);
	});

	it("rejects the whole batch with nothing written when one item has a stale anchor", async () => {
		await withTempDir("batch-abort-", async (dir) => {
			const first = join(dir, "a.txt");
			const second = join(dir, "b.txt");
			await writeFile(first, "alpha\nbeta\ngamma\n", "utf-8");
			await writeFile(second, "one\ntwo\nthree\n", "utf-8");

			const { ctx, readTool, getTool } = setupIntegrationTest(dir);
			const batchTool = getTool("batch_edit");
			const aHashes = await lineHashes("alpha\nbeta\ngamma\n", first);
			const bHashes = await lineHashes("one\ntwo\nthree\n", second);
			await readBatchTool(ctx, readTool, "a.txt");
			await readBatchTool(ctx, readTool, "b.txt");

			await writeFile(second, "one\nTWO\nthree\n", "utf-8");

			await expect(
				batchTool.execute(
					"b1",
					{
						edits: [
							{
								path: "a.txt",
								remove_from: aHashes[1]!,
								remove_to: aHashes[1]!,
								replacement_text: "BETA",
							},
							{
								path: "b.txt",
								remove_from: bHashes[1]!,
								remove_to: bHashes[1]!,
								replacement_text: "two",
							},
						],
					},
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow(/\[E_BATCH_ABORT\] edits\[1\] \(b\.txt\) failed/);

			expect(await readFile(first, "utf-8")).toBe("alpha\nbeta\ngamma\n");
			expect(await readFile(second, "utf-8")).toBe("one\nTWO\nthree\n");
		});
	});

	it("echoes the current range (reject-and-serve) when a batch item's boundary anchor went stale", async () => {
		await withTempFile(
			"sample.ts",
			"alpha\nbeta\ngamma\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
				const batchTool = getTool("batch_edit");
				const hashes = await lineHashes("alpha\nbeta\ngamma\n", path);
				await readBatchTool(ctx, readTool, "sample.ts");

				await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

				const err = (await batchTool
					.execute(
						"b1",
						{
							edits: [
								{
									path: "sample.ts",
									remove_from: hashes[1]!,
									remove_to: hashes[2]!,
									replacement_text: "BETA\ngamma",
								},
							],
						},
						undefined,
						undefined,
						ctx,
					)
					.catch((e: unknown) => e)) as Error;
				expect(err.message).toContain("[E_BATCH_ABORT]");

				const echoedBeta = err.message
					.split("\n")
					.find((l) => /^[A-Za-z0-9]{3}│BETA$/.test(l));
				expect(echoedBeta).toBeDefined();
				expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");

				const echoedHash = extractHash(echoedBeta!);
				const editTool = getTool("edit");
				const followUp = await editTool.execute(
					"e1",
					["sample.ts", [echoedHash, echoedHash], "beta"],
					undefined,
					undefined,
					ctx,
				);
				expect(getText(followUp)).toContain("Successfully edited");
				expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
			},
		);
	});

	it("rejects overlapping same-file items with nothing written", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
				const batchTool = getTool("batch_edit");
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await readBatchTool(ctx, readTool, "sample.ts");

				await expect(
					batchTool.execute(
						"b1",
						{
							edits: [
								{
									path: "sample.ts",
									remove_from: hashes[1]!,
									remove_to: hashes[1]!,
									replacement_text: "BBB",
								},
								{
									path: "sample.ts",
									remove_from: hashes[1]!,
									remove_to: hashes[1]!,
									replacement_text: "XX",
								},
							],
						},
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/\[E_BATCH_ABORT\] edits\[1\] \(sample\.ts\) failed/);

				expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
			},
		);
	});

	it("reports a noop item without failing the batch", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
				const batchTool = getTool("batch_edit");
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await readBatchTool(ctx, readTool, "sample.ts");

				const result = await batchTool.execute(
					"b1",
					{
						edits: [
							{
								path: "sample.ts",
								remove_from: hashes[1]!,
								remove_to: hashes[1]!,
								replacement_text: "BBB",
							},
							{
								path: "sample.ts",
								remove_from: hashes[2]!,
								remove_to: hashes[2]!,
								replacement_text: "ccc",
							},
						],
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(result)).toContain("1 of 2 edit(s) applied (1 noop)");
				expect(getText(result)).toContain("was a noop");
				expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
				expect(result.details.metrics.classification).toBe("applied");
			},
		);
	});

	it("reports no changes for an all-noop batch", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
				const batchTool = getTool("batch_edit");
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await readBatchTool(ctx, readTool, "sample.ts");

				const result = await batchTool.execute(
					"b1",
					{
						edits: [
							{
								path: "sample.ts",
								remove_from: hashes[1]!,
								remove_to: hashes[1]!,
								replacement_text: "bbb",
							},
						],
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(result)).toContain("No changes made");
				expect(result.details.metrics.classification).toBe("noop");
				expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
			},
		);
	});

	it("rejects malformed envelopes with [E_BAD_SHAPE] without touching files", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
				const batchTool = getTool("batch_edit");
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await readBatchTool(ctx, readTool, "sample.ts");

				const validItem = {
					path: "sample.ts",
					remove_from: hashes[0]!,
					remove_to: hashes[0]!,
					replacement_text: "AAA",
				};

				await expect(
					batchTool.execute("b1", { edits: [] }, undefined, undefined, ctx),
				).rejects.toThrow(/E_BAD_SHAPE/);

				await expect(
					batchTool.execute("b1", { edits: "nope" }, undefined, undefined, ctx),
				).rejects.toThrow(/E_BAD_SHAPE/);

				await expect(
					batchTool.execute(
						"b1",
						{
							edits: [
								{
									path: "sample.ts",
									remove_from: hashes[0]!,
									remove_to: hashes[0]!,
								},
							],
						},
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/E_BAD_SHAPE/);

				const tooMany = Array.from({ length: 33 }, () => ({ ...validItem }));
				await expect(
					batchTool.execute(
						"b1",
						{ edits: tooMany },
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/E_BAD_SHAPE/);

				expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
			},
		);
	});

	it("resolves a missing per-item path from the hash store with a warning", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
			const batchTool = getTool("batch_edit");
			const hashes = await lineHashes("aaa\nbbb\n", path);
			await readBatchTool(ctx, readTool, "sample.ts");

			const result = await batchTool.execute(
				"b1",
				{
					edits: [
						{
							remove_from: hashes[0]!,
							remove_to: hashes[0]!,
							replacement_text: "AAA",
						},
					],
				},
				undefined,
				undefined,
				ctx,
			);
			expect(getText(result)).toContain("Successfully edited");
			expect(
				result.details.warnings?.some((w: string) =>
					w.includes('missing "path" resolved to'),
				),
			).toBe(true);
			expect(await readFile(path, "utf-8")).toBe("AAA\nbbb\n");
		});
	});

	it("applies per-item autocorrections (reversed range swap) like single edit", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
				const batchTool = getTool("batch_edit");
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await readBatchTool(ctx, readTool, "sample.ts");

				const result = await batchTool.execute(
					"b1",
					{
						edits: [
							{
								path: "sample.ts",
								remove_from: hashes[2]!,
								remove_to: hashes[0]!,
								replacement_text: "XX",
							},
						],
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(result)).toContain("Successfully edited");
				expect(
					result.details.warnings?.some((w: string) =>
						w.includes("[E_BAD_OP]"),
					),
				).toBe(true);
				expect(await readFile(path, "utf-8")).toBe("XX\n");
			},
		);
	});

	it("reports drift outside the edited range on a successful batch", async () => {
		await withTempFile(
			"sample.ts",
			"alpha\nbeta\ngamma\ndelta\necho\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
				const batchTool = getTool("batch_edit");
				const hashes = await lineHashes(
					"alpha\nbeta\ngamma\ndelta\necho\n",
					path,
				);
				await readBatchTool(ctx, readTool, "sample.ts");

				await writeFile(path, "alpha\nbeta\ngamma\ndelta\nECHO\n", "utf-8");

				const result = await batchTool.execute(
					"b1",
					{
						edits: [
							{
								path: "sample.ts",
								remove_from: hashes[1]!,
								remove_to: hashes[1]!,
								replacement_text: "BETA",
							},
						],
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(result)).toContain("Successfully edited");
				expect(result.details.driftNotice).toContain("drift:");
				expect(result.details.driftNotice).toContain("ECHO");
				expect(await readFile(path, "utf-8")).toBe(
					"alpha\nBETA\ngamma\ndelta\nECHO\n",
				);
			},
		);
	});

	it("applies the noop-loop guard to repeated all-noop batches", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
				const batchTool = getTool("batch_edit");
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await readBatchTool(ctx, readTool, "sample.ts");

				const payload = {
					edits: [
						{
							path: "sample.ts",
							remove_from: hashes[1]!,
							remove_to: hashes[1]!,
							replacement_text: "bbb",
						},
					],
				};

				const first = await batchTool.execute(
					"b1",
					payload,
					undefined,
					undefined,
					ctx,
				);
				expect(first.details.metrics.classification).toBe("noop");
				expect(getText(first)).not.toContain("[E_NOOP_LOOP]");

				const second = await batchTool.execute(
					"b2",
					payload,
					undefined,
					undefined,
					ctx,
				);
				expect(getText(second)).toContain("[E_NOOP_LOOP] Notice");

				await expect(
					batchTool.execute("b3", payload, undefined, undefined, ctx),
				).rejects.toThrow(/\[E_NOOP_LOOP\]/);
				expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
			},
		);
	});

	it("echoes the failing item's current range as usable anchors after a batch rejection", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
				const batchTool = getTool("batch_edit");
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await readBatchTool(ctx, readTool, "sample.ts");

				const err = (await batchTool
					.execute(
						"b1",
						{
							edits: [
								{
									path: "sample.ts",
									remove_from: hashes[1]!,
									remove_to: hashes[1]!,
									replacement_text: "BBB",
								},
								{
									path: "sample.ts",
									remove_from: hashes[1]!,
									remove_to: hashes[1]!,
									replacement_text: "XX",
								},
							],
						},
						undefined,
						undefined,
						ctx,
					)
					.catch((e: unknown) => e)) as Error;
				expect(err.message).toContain("[E_BATCH_ABORT]");

				const echoedRow = err.message
					.split("\n")
					.find((l) => l.includes(`│${"bbb"}`))!;
				const echoedHash = extractHash(echoedRow);

				const editTool = getTool("edit");
				const followUp = await editTool.execute(
					"e1",
					["sample.ts", [echoedHash, echoedHash], "BBB"],
					undefined,
					undefined,
					ctx,
				);
				expect(getText(followUp)).toContain("Successfully edited");
				expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
			},
		);
	});
});
