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

describe("served-state edge cases for edit", () => {
	it("rejects [E_RANGE_UNSERVED] for a range spanning paged-read gaps, then applies on retry", async () => {
		const content =
			["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"].join("\n") + "\n";
		await withTempFile("sample.ts", content, async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

			const first = await readTool.execute(
				"r1",
				{ path: "sample.ts", limit: 3 },
				undefined,
				undefined,
				ctx,
			);
			const firstText = getText(first);
			const l3Ref = extractHash(
				firstText.split("\n").find((l) => l.includes("│l3"))!,
			);

			const second = await readTool.execute(
				"r2",
				{ path: "sample.ts", offset: 7 },
				undefined,
				undefined,
				ctx,
			);
			const secondText = getText(second);
			const l7Ref = extractHash(
				secondText.split("\n").find((l) => l.includes("│l7"))!,
			);

			let rejected: Error | undefined;
			try {
				await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: l3Ref,
						remove_to: l7Ref,
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
			expect(rejected!.message).toMatch(/E_RANGE_UNSERVED.*Line 4/);
			expect(await readFile(path, "utf-8")).toBe(content);

			const echoLines = rejected!.message
				.split("\n")
				.filter((l) => /^[A-Za-z0-9]{3}│/.test(l));
			expect(echoLines).toHaveLength(5);

			const retryFrom = echoLines[0]!.split("│")[0]!;
			const retryTo = echoLines[4]!.split("│")[0]!;
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
			expect(await readFile(path, "utf-8")).toBe("l1\nl2\nX\nY\nl8\nl9\n");
		});
	});

	it("rejects an interior line changed to content served elsewhere ([E_RANGE_STALE], never a false accept)", async () => {
		await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

			const first = await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);
			const text = getText(first);
			const aRef = extractHash(text.split("\n").find((l) => l.includes("│a"))!);
			const dRef = extractHash(text.split("\n").find((l) => l.includes("│d"))!);

			await writeFile(path, "a\nb\nb\nd\n", "utf-8");

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: aRef,
						remove_to: dRef,
						replacement_text: "X",
					},
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow(/E_RANGE_STALE.*Line 3/);

			expect(await readFile(path, "utf-8")).toBe("a\nb\nb\nd\n");
		});
	});

	it("fail-safes with [E_RANGE_UNVERIFIED] when a boundary hash was served at two positions", async () => {
		await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

			const first = await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);
			const aRef = extractHash(
				getText(first)
					.split("\n")
					.find((l) => l.includes("│a"))!,
			);

			await writeFile(path, "x\ny\na\n", "utf-8");
			await readTool.execute(
				"r2",
				{ path: "sample.ts", offset: 3 },
				undefined,
				undefined,
				ctx,
			);

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: aRef,
						remove_to: aRef,
						replacement_text: "X",
					},
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow(/E_RANGE_UNVERIFIED.*served at 2 positions/);

			expect(await readFile(path, "utf-8")).toBe("x\ny\na\n");
		});
	});

	it("fail-safes with [E_RANGE_UNVERIFIED] when a boundary was never served (paged read)", async () => {
		const content = "l1\nl2\nl3\nl4\nl5\n";
		await withTempFile("sample.ts", content, async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

			await readTool.execute(
				"r1",
				{ path: "sample.ts", limit: 2 },
				undefined,
				undefined,
				ctx,
			);

			const hashes = await lineHashes(content, home.testPath);

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: hashes[3]!,
						remove_to: hashes[4]!,
						replacement_text: "X",
					},
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow(/E_RANGE_UNVERIFIED.*has no served position/);

			expect(await readFile(path, "utf-8")).toBe(content);
		});
	});

	it("caps large-range rejection echoes with a pagination hint and leaves the file unchanged", async () => {
		const lines = Array.from(
			{ length: 200 },
			(_, i) => `line_${String(i + 1).padStart(3, "0")}`,
		);
		const content = lines.join("\n") + "\n";
		const mutated =
			lines.map((l) => (l === "line_100" ? "MUTATED_100" : l)).join("\n") +
			"\n";

		await withTempFile("sample.ts", content, async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

			const first = await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);
			const text = getText(first);
			const firstRef = extractHash(
				text.split("\n").find((l) => l.includes("│line_001"))!,
			);
			const lastRef = extractHash(
				text.split("\n").find((l) => l.includes("│line_200"))!,
			);

			await writeFile(path, mutated, "utf-8");

			let rejected: Error | undefined;
			try {
				await editTool.execute(
					"e1",
					{
						path: "sample.ts",
						remove_from: firstRef,
						remove_to: lastRef,
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
			expect(rejected!.message).toMatch(/E_RANGE_STALE.*Line 100/);

			const echoLines = rejected!.message
				.split("\n")
				.filter((l) => /^[A-Za-z0-9]{3}│/.test(l));
			expect(echoLines).toHaveLength(150);
			expect(rejected!.message).toMatch(
				/\[\s*\.\.\.\s*50 more lines — use read with offset=151 to see the rest\]/,
			);
			expect(await readFile(path, "utf-8")).toBe(mutated);
		});
	});
});
