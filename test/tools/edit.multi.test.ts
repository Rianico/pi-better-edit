import { describe, expect, it } from "vitest";
import { Compile } from "typebox/compile";
import { readFile, writeFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { editToolSchema } from "../../src/edit";
import { prepareEditArguments } from "../../src/edit-normalize";
import {
	withTempFile,
	setupIntegrationTest,
	getText,
	extractHash,
} from "../support/fixtures";

async function doRead(ctx: any, readTool: any, path: string) {
	await readTool.execute("r1", { path }, undefined, undefined, ctx);
}

describe("edit multi-item tool", () => {
	it("applies disjoint same-file ranges in order", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\nddd\neee\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\nddd\neee\n", path);
				await doRead(ctx, readTool, "sample.ts");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						edits: [
							[hashes[0]!, hashes[0]!, "AAA"],
							[hashes[2]!, hashes[2]!, "CCC"],
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

	it("matches single-edit behavior for a one-item payload", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await doRead(ctx, readTool, "sample.ts");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						edits: [[hashes[1]!, hashes[1]!, "BBB"]],
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

	it("rejects the whole call with nothing written when one item has a stale anchor", async () => {
		await withTempFile(
			"sample.ts",
			"alpha\nbeta\ngamma\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("alpha\nbeta\ngamma\n", path);
				await doRead(ctx, readTool, "sample.ts");

				await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

				await expect(
					editTool.execute(
						"e1",
						{
							path: "sample.ts",
							edits: [
								[hashes[0]!, hashes[0]!, "ALPHA"],
								[hashes[1]!, hashes[1]!, "two"],
							],
						},
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/\[E_BATCH_ABORT\] edit\[1\] \(sample\.ts\) failed/);

				expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
			},
		);
	});

	it("echoes the current range (reject-and-serve) when an item's boundary anchor went stale", async () => {
		await withTempFile(
			"sample.ts",
			"alpha\nbeta\ngamma\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("alpha\nbeta\ngamma\n", path);
				await doRead(ctx, readTool, "sample.ts");

				await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

				const err = (await editTool
					.execute(
						"e1",
						{
							path: "sample.ts",
							edits: [
								[hashes[0]!, hashes[0]!, "ALPHA"],
								[hashes[1]!, hashes[2]!, "BETA\ngamma"],
							],
						},
						undefined,
						undefined,
						ctx,
					)
					.catch((e: unknown) => e)) as Error;
				expect(err.message).toContain("[E_BATCH_ABORT] edit[1]");

				const echoedBeta = err.message
					.split("\n")
					.find((l) => /^[A-Za-z0-9]{3}│BETA$/.test(l));
				expect(echoedBeta).toBeDefined();
				expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");

				const echoedHash = extractHash(echoedBeta!);
				const followUp = await editTool.execute(
					"e2",
					{
						path: "sample.ts",
						edits: [[echoedHash, echoedHash, "beta"]],
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(followUp)).toContain("Successfully edited");
				expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
			},
		);
	});

	it("rejects overlapping items with nothing written", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await doRead(ctx, readTool, "sample.ts");

				await expect(
					editTool.execute(
						"e1",
						{
							path: "sample.ts",
							edits: [
								[hashes[1]!, hashes[1]!, "BBB"],
								[hashes[1]!, hashes[1]!, "XX"],
							],
						},
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/\[E_BATCH_ABORT\] edit\[1\] \(sample\.ts\) failed/);

				expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
			},
		);
	});

	it("reports a noop item without failing the call", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await doRead(ctx, readTool, "sample.ts");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						edits: [
							[hashes[1]!, hashes[1]!, "BBB"],
							[hashes[2]!, hashes[2]!, "ccc"],
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

	it("reports no changes for an all-noop call", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await doRead(ctx, readTool, "sample.ts");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						edits: [[hashes[1]!, hashes[1]!, "bbb"]],
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

	it("rejects malformed envelopes with [E_BAD_PAYLOAD] without touching files", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await doRead(ctx, readTool, "sample.ts");

				const validator = Compile(editToolSchema);
				expect(
					validator.Check({
						path: "sample.ts",
						edits: [[hashes[0]!, hashes[0]!, "AAA"]],
					}),
				).toBe(true);
				expect(
					validator.Check({
						path: "sample.ts",
						edits: [
							{
								path: "sample.ts",
								remove_from: hashes[0]!,
								remove_to: hashes[0]!,
								replacement_text: "AAA",
							},
						],
					}),
				).toBe(false);

				await expect(
					editTool.execute(
						"e1",
						{
							path: "sample.ts",
							edits: [
								{
									path: "sample.ts",
									remove_from: hashes[0]!,
									remove_to: hashes[0]!,
									replacement_text: "AAA",
								},
							],
						} as any,
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/E_BAD_PAYLOAD/);
				await expect(
					editTool.execute(
						"e1",
						{ path: "sample.ts", edits: [] },
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/E_BAD_PAYLOAD/);

				await expect(
					editTool.execute("e1", "nope", undefined, undefined, ctx),
				).rejects.toThrow(/E_BAD_PAYLOAD/);

				await expect(
					editTool.execute(
						"e1",
						{
							path: "sample.ts",
							edits: [[hashes[0]!, hashes[0]!]],
						},
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/E_BAD_PAYLOAD/);

				const validItem = [hashes[0]!, hashes[0]!, "AAA"];
				const tooMany = Array.from({ length: 33 }, () => validItem);
				await expect(
					editTool.execute(
						"e1",
						{ path: "sample.ts", edits: tooMany },
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/E_BAD_PAYLOAD/);

				expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
			},
		);
	});

	it("resolves a missing path from the hash store with a warning", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\n", path);
			await doRead(ctx, readTool, "sample.ts");

			const result = await editTool.execute(
				"e1",
				{
					path: null,
					edits: [[hashes[0]!, hashes[0]!, "AAA"]],
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

	it("applies item autocorrections (reversed range swap) like single edit", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await doRead(ctx, readTool, "sample.ts");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						edits: [[hashes[2]!, hashes[0]!, "XX"]],
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(result)).toContain("Successfully edited");
				expect(
					result.details.warnings?.some((w: string) =>
						w.includes("[E_REVERSED_ANCHORS]"),
					),
				).toBe(true);
				expect(await readFile(path, "utf-8")).toBe("XX\n");
			},
		);
	});

	it("reports drift outside the edited range on a successful call", async () => {
		await withTempFile(
			"sample.ts",
			"alpha\nbeta\ngamma\ndelta\necho\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes(
					"alpha\nbeta\ngamma\ndelta\necho\n",
					path,
				);
				await doRead(ctx, readTool, "sample.ts");

				await writeFile(path, "alpha\nbeta\ngamma\ndelta\nECHO\n", "utf-8");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						edits: [[hashes[1]!, hashes[1]!, "BETA"]],
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

	it("applies the noop-loop guard to repeated all-noop calls", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await doRead(ctx, readTool, "sample.ts");

				const payload = {
					path: "sample.ts",
					edits: [[hashes[1]!, hashes[1]!, "bbb"]],
				};

				const first = await editTool.execute("e1", payload, undefined, undefined, ctx);
				expect(first.details.metrics.classification).toBe("noop");
				expect(getText(first)).not.toContain("[E_NOOP_LOOP]");

				const second = await editTool.execute("e2", payload, undefined, undefined, ctx);
				expect(getText(second)).toContain("[E_NOOP_LOOP] Notice");

				await expect(
					editTool.execute("e3", payload, undefined, undefined, ctx),
				).rejects.toThrow(/\[E_NOOP_LOOP\]/);
				expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
			},
		);
	});

	it("echoes the failing item's current range as usable anchors after a rejection", async () => {
		await withTempFile(
			"sample.ts",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
				await doRead(ctx, readTool, "sample.ts");

				const err = (await editTool
					.execute(
						"e1",
						{
							path: "sample.ts",
							edits: [
								[hashes[1]!, hashes[1]!, "BBB"],
								[hashes[1]!, hashes[1]!, "XX"],
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

				const followUp = await editTool.execute(
					"e2",
					{
						path: "sample.ts",
						edits: [[echoedHash, echoedHash, "BBB"]],
					},
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

describe("prepareEditArguments normalization", () => {
	it("keeps the canonical object-root payload unchanged", () => {
		expect(
			prepareEditArguments({
				path: "a.ts",
				edits: [["AAA", "BBB", "x"]],
			}),
		).toEqual({ path: "a.ts", edits: [["AAA", "BBB", "x"]] });
	});

	it("accepts null path and multi-item edits", () => {
		expect(
			prepareEditArguments({
				path: null,
				edits: [
					["AAA", "BBB", "x"],
					["CCC", "DDD", ""],
				],
			}),
		).toEqual({
			path: null,
			edits: [
				["AAA", "BBB", "x"],
				["CCC", "DDD", ""],
			],
		});
	});

	it("rejects malformed shapes with an actionable E_BAD_PAYLOAD hint", () => {
		for (const args of [
			undefined,
			{},
			"a.ts",
			{ path: "a.ts" },
			{ path: "a.ts", edits: [] },
			{ path: "a.ts", edits: "nope" },
			{ path: "a.ts", edits: [["AAA"]] },
			{ edit: ["a.ts", ["AAA", "BBB"], "x"] },
			["a.ts", ["AAA", "BBB"], "x"],
		]) {
			expect(() => prepareEditArguments(args)).toThrow(/\[E_BAD_PAYLOAD\]/);
			expect(() => prepareEditArguments(args)).toThrow(/canonical payload/);
		}
	});
});
