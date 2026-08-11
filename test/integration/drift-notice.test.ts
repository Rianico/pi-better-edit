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

describe("drift notices for changed served territory outside the replace range", () => {
	it("appends a drift notice with the current drifted content; the notice rows verify cleanly in a follow-up edit", async () => {
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

				await writeFile(path, "alpha\nbeta\ngamma\nDELTA\n", "utf-8");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: alphaRef,
						remove_to: alphaRef,
						replacement_text: "A",
					},
					undefined,
					undefined,
					ctx,
				);

				const resultText = getText(result);
				expect(resultText).toContain("Successfully replaced");
				expect(resultText).toContain("Drift notice:");
				const driftRow = resultText
					.split("\n")
					.find((l) => /^[A-Za-z0-9]{3}│DELTA$/.test(l));
				expect(driftRow).toBeDefined();

				const deltaRef = extractHash(driftRow!);
				const followUp = await editTool.execute(
					"e2",
					{
						path: "sample.ts",
						remove_from: deltaRef,
						remove_to: deltaRef,
						replacement_text: "D",
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(followUp)).toContain("Successfully replaced");
				expect(await readFile(path, "utf-8")).toBe("A\nbeta\ngamma\nD\n");
			},
		);
	});

	it("reports drift on a noop replace", async () => {
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

				await writeFile(path, "alpha\nbeta\ngamma\nDELTA\n", "utf-8");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: alphaRef,
						remove_to: alphaRef,
						replacement_text: "alpha",
					},
					undefined,
					undefined,
					ctx,
				);

				const resultText = getText(result);
				expect(resultText).toContain("No changes made to sample.ts");
				expect(resultText).toContain("Drift notice:");
				const currentHashes = await lineHashes(
					"alpha\nbeta\ngamma\nDELTA\n",
					home.testPath,
				);
				expect(resultText).toContain(`${currentHashes[3]}│DELTA`);
			},
		);
	});

	it("emits a one-line pointer for already-reported drift instead of re-echoing rows", async () => {
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

				await writeFile(path, "alpha\nbeta\ngamma\nDELTA\n", "utf-8");
				const first = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: alphaRef,
						remove_to: alphaRef,
						replacement_text: "alpha",
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(first)).toContain("Drift notice:");
				expect(getText(first)).toContain("│DELTA");

				await writeFile(path, "alpha\nbeta\ngamma\nDELTA2\n", "utf-8");
				const second = await editTool.execute(
					"e2",
					{
						path: "sample.ts",
						remove_from: alphaRef,
						remove_to: alphaRef,
						replacement_text: "alpha",
					},
					undefined,
					undefined,
					ctx,
				);
				const secondText = getText(second);
				expect(secondText).toContain("already reported");
				expect(secondText).not.toContain("│DELTA2");
				expect(
					secondText.split("\n").filter((l) => /^[A-Za-z0-9]{3}│/.test(l)),
				).toHaveLength(0);
				expect(await readFile(path, "utf-8")).toBe(
					"alpha\nbeta\ngamma\nDELTA2\n",
				);
			},
		);
	});

	it("a read re-serves the lines and resets the pointer to a full notice on the next episode", async () => {
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
				const alphaRef = extractHash(
					getText(firstRead)
						.split("\n")
						.find((l) => l.includes("│alpha"))!,
				);

				await writeFile(path, "alpha\nbeta\ngamma\nDELTA\n", "utf-8");
				await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: alphaRef,
						remove_to: alphaRef,
						replacement_text: "alpha",
					},
					undefined,
					undefined,
					ctx,
				);

				await writeFile(path, "alpha\nbeta\ngamma\nDELTA2\n", "utf-8");
				const second = await editTool.execute(
					"e2",
					{
						path: "sample.ts",
						remove_from: alphaRef,
						remove_to: alphaRef,
						replacement_text: "alpha",
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(second)).toContain("already reported");

				await readTool.execute(
					"r2",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);

				await writeFile(path, "alpha\nbeta\ngamma\nDELTA3\n", "utf-8");
				const third = await editTool.execute(
					"e3",
					{
						path: "sample.ts",
						remove_from: alphaRef,
						remove_to: alphaRef,
						replacement_text: "alpha",
					},
					undefined,
					undefined,
					ctx,
				);
				const thirdText = getText(third);
				expect(thirdText).toContain("Drift notice:");
				expect(thirdText).toContain("│DELTA3");
				expect(thirdText).not.toContain("already reported");
			},
		);
	});

	it("keeps drift inside the range on the reject path with no drift notice", async () => {
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
				expect(rejected!.message).not.toContain("Drift notice");
				expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
			},
		);
	});

	it("tolerates an external positional shift above the range — unchanged shifted lines do not appear as drifted", async () => {
		await withTempFile(
			"sample.ts",
			"l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n",
			async ({ cwd, path }) => {
				const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

				const firstRead = await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);
				const l4Ref = extractHash(
					getText(firstRead)
						.split("\n")
						.find((l) => l.includes("│l4"))!,
				);

				await writeFile(path, "l0\nl1\nl4\nl5\nl6\nl7\nl8\nl9\n", "utf-8");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: l4Ref,
						remove_to: l4Ref,
						replacement_text: "R",
					},
					undefined,
					undefined,
					ctx,
				);

				const resultText = getText(result);
				expect(resultText).toContain("Successfully replaced");
				const notice = resultText.split("Drift notice:")[1] ?? "";
				expect(notice).toContain("2 line(s)");
				expect(notice.match(/^[A-Za-z0-9]{3}│R$/gm)).toHaveLength(1);
				expect(notice).toMatch(/^[A-Za-z0-9]{3}│l1$/m);
				expect(notice).toMatch(/^[A-Za-z0-9]{3}│l5$/m);
				expect(notice).not.toMatch(/│l[23]/);
				expect(await readFile(path, "utf-8")).toBe(
					"l0\nl1\nR\nl5\nl6\nl7\nl8\nl9\n",
				);
			},
		);
	});

	it("undo_last_replace results never carry a drift notice", async () => {
		await withTempFile(
			"sample.ts",
			"alpha\nbeta\ngamma\ndelta\n",
			async ({ cwd, path }) => {
				const { getTool, ctx } = setupIntegrationTest(cwd);
				const readTool = getTool("read");
				const editTool = getTool("replace");
				const undoTool = getTool("undo_last_replace");

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

				await writeFile(path, "alpha\nbeta\ngamma\nDELTA\n", "utf-8");
				const replaced = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: alphaRef,
						remove_to: alphaRef,
						replacement_text: "A",
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(replaced)).toContain("Drift notice:");

				const undone = await undoTool.execute(
					"u1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);
				expect(getText(undone)).toContain("Undone last replace on sample.ts.");
				expect(getText(undone)).not.toContain("Drift notice");
				expect(await readFile(path, "utf-8")).toBe(
					"alpha\nbeta\ngamma\nDELTA\n",
				);
			},
		);
	});
	it("shows the before/after lines around the drifted content and serves the context rows for follow-up edits", async () => {
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
				const alphaRef = extractHash(
					getText(firstRead)
						.split("\n")
						.find((l) => l.includes("│alpha"))!,
				);

				await writeFile(path, "alpha\nbeta\nGAMMA\ndelta\n", "utf-8");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: alphaRef,
						remove_to: alphaRef,
						replacement_text: "A",
					},
					undefined,
					undefined,
					ctx,
				);

				const resultText = getText(result);
				expect(resultText).toContain("Successfully replaced");
				expect(resultText).toContain("Drift notice:");

				const betaRow = resultText
					.split("\n")
					.find((l) => /^[A-Za-z0-9]{3}│beta$/.test(l));
				const gammaRow = resultText
					.split("\n")
					.find((l) => /^[A-Za-z0-9]{3}│GAMMA$/.test(l));
				const deltaRow = resultText
					.split("\n")
					.find((l) => /^[A-Za-z0-9]{3}│delta$/.test(l));
				expect(betaRow).toBeDefined();
				expect(gammaRow).toBeDefined();
				expect(deltaRow).toBeDefined();
				const notice = resultText.split("Drift notice:")[1] ?? "";
				expect(notice.indexOf(betaRow!)).toBeLessThan(
					notice.indexOf(gammaRow!),
				);
				expect(notice.indexOf(gammaRow!)).toBeLessThan(
					notice.indexOf(deltaRow!),
				);

				const betaRef = extractHash(betaRow!);
				const followUp = await editTool.execute(
					"e2",
					{
						path: "sample.ts",
						remove_from: betaRef,
						remove_to: betaRef,
						replacement_text: "B",
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(followUp)).toContain("Successfully replaced");
				expect(await readFile(path, "utf-8")).toBe(
					"A\nB\nGAMMA\ndelta\n",
				);
			},
		);
	});
});
