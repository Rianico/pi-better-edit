import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { withTempFile, getText, extractHash } from "../support/fixtures";

type ToolResultEvent = {
	toolName: string;
	isError: boolean;
	input: unknown;
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
				{ path: "sample.ts", edits: [[l2Ref, l2Ref, "X"]] },
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
					input: ["sample.ts", [l2Ref, l2Ref], "X"],
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
				{ path: "sample.ts", edits: [[l1Ref, xRef, "A\nB"]] },
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
				{ path: "sample.ts", edits: [[l2Ref, l2Ref, "X"]] },
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
					{ path: "sample.ts", edits: [[l1Ref, xRef, "A\nB"]] },
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
});
