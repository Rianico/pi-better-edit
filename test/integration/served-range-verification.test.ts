import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import {
	withTempFile,
	setupIntegrationTest,
	useTestHome,
	getText,
	extractHash,
} from "../support/fixtures";

const home = useTestHome();

describe("served-state range verification for edit", () => {
	it("rejects with [E_RANGE_STALE] naming the first offending line and leaves the file unchanged", async () => {
		await withTempFile(
			"sample.ts",
			"alpha\nbeta\ngamma\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

				const firstRead = await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);
				const text = getText(firstRead);
				const alphaRef = extractHash(
					text.split("\n").find((l) => l.includes("│alpha"))!,
				);
				const gammaRef = extractHash(
					text.split("\n").find((l) => l.includes("│gamma"))!,
				);

				await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

				await expect(
					editTool.execute(
						"e1",
						{
							path: "sample.ts",
							remove_from: alphaRef,
							remove_to: gammaRef,
							replacement_text: "X",
						},
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/E_RANGE_STALE.*line 2/);

				expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
			},
		);
	});

	it("echoes the current range as fresh rows; retrying with them applies without read and does not loop", async () => {
		await withTempFile(
			"sample.ts",
			"alpha\nbeta\ngamma\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

				const firstRead = await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);
				const text = getText(firstRead);
				const alphaRef = extractHash(
					text.split("\n").find((l) => l.includes("│alpha"))!,
				);
				const gammaRef = extractHash(
					text.split("\n").find((l) => l.includes("│gamma"))!,
				);

				await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

				let rejected: Error | undefined;
				try {
					await editTool.execute(
						"e1",
						{
							path: "sample.ts",
							remove_from: alphaRef,
							remove_to: gammaRef,
							replacement_text: "X",
						},
						undefined,
						undefined,
						ctx,
					);
				} catch (error) {
					rejected = error as Error;
				}
				expect(rejected).toBeDefined();
				expect(rejected!.message).toMatch(/E_RANGE_STALE/);

				const echoLines = rejected!.message
					.split("\n")
					.filter((l) => /^[A-Za-z0-9]{3}│/.test(l));
				const currentHashes = await lineHashes(
					"alpha\nBETA\ngamma\n",
					home.testPath,
				);
				expect(echoLines).toEqual([
					`${currentHashes[0]}│alpha`,
					`${currentHashes[1]}│BETA`,
					`${currentHashes[2]}│gamma`,
				]);

				const retryFrom = echoLines[0]!.split("│")[0]!;
				const retryTo = echoLines[2]!.split("│")[0]!;
				const retry = await editTool.execute(
					"e2",
					{
						path: "sample.ts",
						remove_from: retryFrom,
						remove_to: retryTo,
						replacement_text: "X\nY",
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(retry)).toContain("Successfully edited");
				expect(await readFile(path, "utf-8")).toBe("X\nY\n");

				await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");
				const secondStale = await editTool.execute(
					"e3",
					{
						path: "sample.ts",
						remove_from: retryFrom,
						remove_to: retryTo,
						replacement_text: "Z",
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(secondStale)).toContain("Successfully edited");
				expect(await readFile(path, "utf-8")).toBe("Z\n");
			},
		);
	});

	it("tolerates an out-of-range in-place content change below the range", async () => {
		await withTempFile(
			"sample.ts",
			"alpha\nbeta\ngamma\ndelta\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

				const firstRead = await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);
				const text = getText(firstRead);
				const alphaRef = extractHash(
					text.split("\n").find((l) => l.includes("│alpha"))!,
				);
				const betaRef = extractHash(
					text.split("\n").find((l) => l.includes("│beta"))!,
				);

				await writeFile(path, "alpha\nbeta\ngamma\nDELTA\n", "utf-8");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: alphaRef,
						remove_to: betaRef,
						replacement_text: "A\nB",
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(result)).toContain("Successfully edited");
				expect(await readFile(path, "utf-8")).toBe("A\nB\ngamma\nDELTA\n");
			},
		);
	});

	it("tolerates a deletion above the range (positional shift)", async () => {
		await withTempFile(
			"sample.ts",
			"a1\na2\nbeta\ngamma\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

				const firstRead = await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);
				const text = getText(firstRead);
				const betaRef = extractHash(
					text.split("\n").find((l) => l.includes("│beta"))!,
				);
				const gammaRef = extractHash(
					text.split("\n").find((l) => l.includes("│gamma"))!,
				);

				await writeFile(path, "a2\nbeta\ngamma\n", "utf-8");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: betaRef,
						remove_to: gammaRef,
						replacement_text: "B\nG",
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(result)).toContain("Successfully edited");
				expect(await readFile(path, "utf-8")).toBe("a2\nB\nG\n");
			},
		);
	});

	it("verifies a change-then-revert interior (b → B → b on disk)", async () => {
		await withTempFile(
			"sample.ts",
			"alpha\nbeta\ngamma\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

				const firstRead = await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);
				const text = getText(firstRead);
				const alphaRef = extractHash(
					text.split("\n").find((l) => l.includes("│alpha"))!,
				);
				const gammaRef = extractHash(
					text.split("\n").find((l) => l.includes("│gamma"))!,
				);

				await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");
				await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: alphaRef,
						remove_to: gammaRef,
						replacement_text: "X\nY",
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(result)).toContain("Successfully edited");
				expect(await readFile(path, "utf-8")).toBe("X\nY\n");
			},
		);
	});

	it("keeps single-line edits behaving exactly as before", async () => {
		await withTempFile(
			"sample.ts",
			"alpha\nbeta\ngamma\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

				const firstRead = await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);
				const text = getText(firstRead);
				const betaRef = extractHash(
					text.split("\n").find((l) => l.includes("│beta"))!,
				);

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: betaRef,
						remove_to: betaRef,
						replacement_text: "BETA",
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(result)).toContain("Successfully edited");
				expect(getText(result)).toContain(
					"Added 1 line(s), removed 1 line(s).",
				);
				expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
			},
		);
	});

	it("records [E_STALE_ANCHOR] context rows as serves for edits over that territory", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

			const firstRead = await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);
			const text = getText(firstRead);
			const alphaRef = extractHash(
				text.split("\n").find((l) => l.includes("│alpha"))!,
			);
			const betaRef = extractHash(
				text.split("\n").find((l) => l.includes("│beta"))!,
			);

			await writeFile(path, "alpha\nBETA\n", "utf-8");

			let rejected: Error | undefined;
			try {
				await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: alphaRef,
						remove_to: betaRef,
						replacement_text: "X",
					},
					undefined,
					undefined,
					ctx,
				);
			} catch (error) {
				rejected = error as Error;
			}
			expect(rejected).toBeDefined();
			expect(rejected!.message).toMatch(/E_STALE_ANCHOR/);
			expect(rejected!.message).toContain(
				"Current context around resolved anchor",
			);

			const contextRow = rejected!.message
				.split("\n")
				.find((l) => l.includes("│BETA"))!;
			const currentHashes = await lineHashes("alpha\nBETA\n", home.testPath);
			expect(contextRow).toContain(currentHashes[1]!);
			const betaRefFromContext = contextRow.split("│")[0]!.split(": ")[1]!;

			const retry = await editTool.execute(
				"e2",
				{
					path: "sample.ts",
					remove_from: betaRefFromContext,
					remove_to: betaRefFromContext,
					replacement_text: "BETA2",
				},
				undefined,
				undefined,
				ctx,
			);
			expect(getText(retry)).toContain("Successfully edited");
			expect(await readFile(path, "utf-8")).toBe("alpha\nBETA2\n");
		});
	});

	it("fail-safes when the boundary hashes were never served (fresh session, no prior read)", async () => {
		await withTempFile(
			"sample.ts",
			"alpha\nbeta\ngamma\n",
			async ({ cwd, path }) => {
				const { ctx, editTool } = setupIntegrationTest(cwd);
				const hashes = await lineHashes("alpha\nbeta\ngamma\n", home.testPath);

				await expect(
					editTool.execute(
						"e1",
						{
							path: "sample.ts",
							remove_from: hashes[0]!,
							remove_to: hashes[2]!,
							replacement_text: "X",
						},
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/cannot verify range against served state/);

				expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
			},
		);
	});
});
