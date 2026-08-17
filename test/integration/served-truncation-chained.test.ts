import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
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

async function hashRefs(
	readTool: any,
	path: string,
	ctx: ToolResultCtx,
	needles: string[],
): Promise<Record<string, string>> {
	const read = await readTool.execute(
		"r1",
		{ path },
		undefined,
		undefined,
		ctx,
	);
	const lines = getText(read).split("\n");
	const out: Record<string, string> = {};
	for (const needle of needles) {
		const line = lines.find((l) => l.includes(`│${needle}`));
		if (!line) throw new Error(`read output did not show "${needle}"`);
		out[needle] = extractHash(line);
	}
	return out;
}

describe("served-state truncation keeps chained edits verifiable", () => {
	it("truncates post-edit diff serves to the post-edit line count", async () => {
		await withTempFile(
			"sample.ts",
			"a\nb\nc\nb\nd\ne\nb\nf\n",
			async ({ cwd }) => {
				const { handlers, getTool } = makeSeamPi();
				const readTool = getTool("read");
				const editTool = getTool("edit");
				const toolResultHandler = handlers.get("tool_result") as (
					event: ToolResultEvent,
					ctx: ToolResultCtx,
				) => Promise<any>;
				expect(toolResultHandler).toBeDefined();
				const ctx = { cwd };

				const refs = await hashRefs(readTool, "sample.ts", ctx, [
					"a",
					"c",
					"d",
					"e",
				]);

				const edit1 = await editTool.execute(
					"e1",
					["sample.ts", [refs["a"]!, refs["c"]!], ""],
					undefined,
					undefined,
					ctx,
				);
				expect(getText(edit1)).toContain("Successfully edited");

				const delivered = await toolResultHandler(
					{
						toolName: "edit",
						isError: false,
						input: { path: "sample.ts" },
						details: edit1.details,
						content: edit1.content,
					},
					ctx,
				);
				expect(delivered).toBeDefined();

				await readTool.execute(
					"r2",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);

				const edit2 = await editTool.execute(
					"e2",
					["sample.ts", [refs["d"]!, refs["e"]!], ""],
					undefined,
					undefined,
					ctx,
				);
				expect(getText(edit2)).toContain("Successfully edited");
				expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe(
					"b\nb\nf\n",
				);
			},
		);
	});

	it("truncates read serves to the file's current line count after shrink", async () => {
		await withTempFile(
			"sample.ts",
			"a\nb\nc\nb\nd\ne\nb\nf\n",
			async ({ cwd }) => {
				const { handlers, getTool } = makeSeamPi();
				const readTool = getTool("read");
				const editTool = getTool("edit");
				const toolResultHandler = handlers.get("tool_result") as (
					event: ToolResultEvent,
					ctx: ToolResultCtx,
				) => Promise<any>;
				expect(toolResultHandler).toBeDefined();
				const ctx = { cwd };

				await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);

				await writeFile(join(cwd, "sample.ts"), "b\nd\ne\nb\nf\n", "utf-8");
				await readTool.execute(
					"r2",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);

				const refs = await hashRefs(readTool, "sample.ts", ctx, ["d", "e"]);
				const edit = await editTool.execute(
					"e1",
					["sample.ts", [refs["d"]!, refs["e"]!], ""],
					undefined,
					undefined,
					ctx,
				);
				expect(getText(edit)).toContain("Successfully edited");
				expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe(
					"b\nb\nf\n",
				);
			},
		);
	});

	it("truncates per-file batch diff serves before chained edits", async () => {
		await withTempFile(
			"sample.ts",
			"a\nb\nc\nb\nd\ne\nb\nf\n",
			async ({ cwd }) => {
				const { handlers, getTool } = makeSeamPi();
				const readTool = getTool("read");
				const batchTool = getTool("batch_edit");
				const editTool = getTool("edit");
				const toolResultHandler = handlers.get("tool_result") as (
					event: ToolResultEvent,
					ctx: ToolResultCtx,
				) => Promise<any>;
				expect(toolResultHandler).toBeDefined();
				const ctx = { cwd };

				const refs = await hashRefs(readTool, "sample.ts", ctx, [
					"a",
					"c",
					"d",
					"e",
				]);

				const batchResult = await batchTool.execute(
					"b1",
					{
						edits: [
							["sample.ts", [refs["a"]!, refs["c"]!], ""],
						],
					},
					undefined,
					undefined,
					ctx,
				);
				expect(getText(batchResult)).toContain("Successfully edited");

				const delivered = await toolResultHandler(
					{
						toolName: "batch_edit",
						isError: false,
						input: { edits: [["sample.ts", [refs["a"]!, refs["c"]!], ""]] },
						details: batchResult.details,
						content: batchResult.content,
					},
					ctx,
				);
				expect(delivered).toBeDefined();

				await readTool.execute(
					"r2",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);

				const edit = await editTool.execute(
					"e1",
					["sample.ts", [refs["d"]!, refs["e"]!], ""],
					undefined,
					undefined,
					ctx,
				);
				expect(getText(edit)).toContain("Successfully edited");
				expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe(
					"b\nb\nf\n",
				);
			},
		);
	});
});
