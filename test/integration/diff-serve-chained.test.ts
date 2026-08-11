import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { withTempFile, getText, extractHash } from "../support/fixtures";

type ToolResultEvent = {
	toolName: string;
	isError: boolean;
	input: Record<string, unknown>;
	details: any;
	content: Array<{ type: string; text: string }>;
};
type ToolResultCtx = { cwd: string };

function makeSeamPi() {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const tools = new Map<string, any>();
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
		getActiveTools() {
			return [];
		},
		setActiveTools() {},
	} as any;
	register(pi);
	return {
		handlers,
		getTool(name: string) {
			return tools.get(name);
		},
	};
}

describe("diff rows serve chained edits", () => {
	it("serves edit diff rows so follow-up edits anchor on them without a read", async () => {
		await withTempFile("sample.ts", "l1\nl2\nl3\nl4\nl5\n", async ({ cwd }) => {
			const { handlers, getTool } = makeSeamPi();
			const readTool = getTool("read");
			const editTool = getTool("edit");
			const toolResultHandler = handlers.get("tool_result") as (
				event: ToolResultEvent,
				ctx: ToolResultCtx,
			) => Promise<any>;
			expect(toolResultHandler).toBeDefined();
			const ctx = { cwd };

			const firstRead = await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);
			const readText = getText(firstRead);
			const l2Ref = extractHash(
				readText.split("\n").find((l) => l.includes("│l2"))!,
			);

			const editResult = await editTool.execute(
				"e1",
				{
					path: "sample.ts",
					remove_from: l2Ref,
					remove_to: l2Ref,
					replacement_text: "X",
				},
				undefined,
				undefined,
				ctx,
			);
			expect(getText(editResult)).toContain("Successfully edited");
			const diff = editResult.details.diff as string;
			expect(diff).toContain("│X");

			const delivered = await toolResultHandler(
				{
					toolName: "edit",
					isError: false,
					input: { path: "sample.ts" },
					details: editResult.details,
					content: editResult.content,
				},
				ctx,
			);
			expect(delivered).toBeDefined();

			const diffLines = diff.split("\n");
			const l1Ref = diffLines
				.find((l) => l.startsWith(" ") && l.includes("│l1"))!
				.slice(1, 4);
			const xRef = diffLines
				.find((l) => l.startsWith("+") && l.includes("│X"))!
				.slice(1, 4);

			const chained = await editTool.execute(
				"e2",
				{
					path: "sample.ts",
					remove_from: l1Ref,
					remove_to: xRef,
					replacement_text: "A\nB",
				},
				undefined,
				undefined,
				ctx,
			);
			expect(getText(chained)).toContain("Successfully edited");
			expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe(
				"A\nB\nl3\nl4\nl5\n",
			);
		});
	});

	it("rejects a follow-up anchored on diff rows when the handler never ran (no serve)", async () => {
		await withTempFile("sample.ts", "l1\nl2\nl3\nl4\nl5\n", async ({ cwd }) => {
			const { getTool } = makeSeamPi();
			const readTool = getTool("read");
			const editTool = getTool("edit");
			const ctx = { cwd };

			const firstRead = await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);
			const readText = getText(firstRead);
			const l2Ref = extractHash(
				readText.split("\n").find((l) => l.includes("│l2"))!,
			);

			const editResult = await editTool.execute(
				"e1",
				{
					path: "sample.ts",
					remove_from: l2Ref,
					remove_to: l2Ref,
					replacement_text: "X",
				},
				undefined,
				undefined,
				ctx,
			);
			expect(getText(editResult)).toContain("Successfully edited");
			const diff = editResult.details.diff as string;

			const diffLines = diff.split("\n");
			const l1Ref = diffLines
				.find((l) => l.startsWith(" ") && l.includes("│l1"))!
				.slice(1, 4);
			const xRef = diffLines
				.find((l) => l.startsWith("+") && l.includes("│X"))!
				.slice(1, 4);

			await expect(
				editTool.execute(
					"e2",
					{
						path: "sample.ts",
						remove_from: l1Ref,
						remove_to: xRef,
						replacement_text: "A\nB",
					},
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow(/E_RANGE_UNVERIFIED/);
			expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe(
				"l1\nX\nl3\nl4\nl5\n",
			);
		});
	});

	it("recovers in one reject-and-serve roundtrip when auto-read is disabled", async () => {
		await withTempFile("sample.ts", "l1\nl2\nl3\nl4\nl5\n", async ({ cwd }) => {
			const configDir = join(cwd, ".config", "pi-hashline-edit-pro");
			await mkdir(configDir, { recursive: true });
			await writeFile(
				join(configDir, "config.json"),
				JSON.stringify({ autoRead: false }),
				"utf-8",
			);

			const { handlers, getTool } = makeSeamPi();
			const sessionStart = handlers.get("session_start") as (
				event: unknown,
				ctx: unknown,
			) => Promise<unknown>;
			await sessionStart(
				{},
				{
					getActiveTools: () => [],
					setActiveTools: () => {},
					ui: { notify() {} },
				},
			);

			const readTool = getTool("read");
			const editTool = getTool("edit");
			const toolResultHandler = handlers.get("tool_result") as (
				event: ToolResultEvent,
				ctx: ToolResultCtx,
			) => Promise<any>;
			const ctx = { cwd };

			const firstRead = await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);
			const text = getText(firstRead);
			const l1Ref = extractHash(
				text.split("\n").find((l) => l.includes("│l1"))!,
			);
			const l2Ref = extractHash(
				text.split("\n").find((l) => l.includes("│l2"))!,
			);
			const l3Ref = extractHash(
				text.split("\n").find((l) => l.includes("│l3"))!,
			);

			const firstEdit = await editTool.execute(
				"e1",
				{
					path: "sample.ts",
					remove_from: l2Ref,
					remove_to: l2Ref,
					replacement_text: "X",
				},
				undefined,
				undefined,
				ctx,
			);
			expect(getText(firstEdit)).toContain("Successfully edited");

			const delivered = await toolResultHandler(
				{
					toolName: "edit",
					isError: false,
					input: { path: "sample.ts" },
					details: firstEdit.details,
					content: firstEdit.content,
				},
				ctx,
			);
			expect(delivered).toBeUndefined();

			let rejected: Error | undefined;
			try {
				await editTool.execute(
					"e2",
					{
						path: "sample.ts",
						remove_from: l1Ref,
						remove_to: l3Ref,
						replacement_text: "A\nB\nC",
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
			expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe(
				"l1\nX\nl3\nl4\nl5\n",
			);

			const echoLines = rejected!.message
				.split("\n")
				.filter((l) => /^[A-Za-z0-9]{3}│/.test(l));
			expect(echoLines.length).toBe(3);

			const retryFrom = extractHash(echoLines[0]!);
			const retryTo = extractHash(echoLines[2]!);
			const retry = await editTool.execute(
				"e3",
				{
					path: "sample.ts",
					remove_from: retryFrom,
					remove_to: retryTo,
					replacement_text: "A\nB\nC",
				},
				undefined,
				undefined,
				ctx,
			);
			expect(getText(retry)).toContain("Successfully edited");
			expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe(
				"A\nB\nC\nl4\nl5\n",
			);
		});
	});
});
