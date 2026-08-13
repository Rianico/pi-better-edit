import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { loadHashStore, getServed } from "../../src/hash-store";
import { lineHashes } from "../../src/hashline";
import { useTestHome, withTempDir } from "../support/fixtures";

useTestHome();

function makeFakePi() {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const tools = new Map<string, any>();
	return {
		pi: {
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
		} as any,
		handlers,
		getTool(name: string) {
			return tools.get(name);
		},
	};
}

describe("batch_edit tool_result handler", () => {
	it("records per-file batch diff rows as serves", async () => {
		await withTempDir("batch-served-", async (dir) => {
			const aPath = join(dir, "a.txt");
			const bPath = join(dir, "b.txt");
			await writeFile(aPath, "alpha\nbeta\ngamma\n", "utf-8");
			await writeFile(bPath, "one\ntwo\nthree\n", "utf-8");

			const { pi, handlers, getTool } = makeFakePi();
			register(pi);
			const readTool = getTool("read");
			const batchTool = getTool("batch_edit");
			const handler = handlers.get("tool_result");
			expect(handler).toBeDefined();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "test-session" } };

			await readTool.execute("r1", { path: "a.txt" }, undefined, undefined, ctx);
			await readTool.execute("r1", { path: "b.txt" }, undefined, undefined, ctx);
			const aHashes = await lineHashes("alpha\nbeta\ngamma\n", aPath);
			const bHashes = await lineHashes("one\ntwo\nthree\n", bPath);

			const result = await batchTool.execute(
				"b1",
				{
					edits: [
						{ path: "a.txt", remove_from: aHashes[1]!, remove_to: aHashes[1]!, replacement_text: "BETA" },
						{ path: "b.txt", remove_from: bHashes[1]!, remove_to: bHashes[1]!, replacement_text: "TWO" },
					],
				},
				undefined,
				undefined,
				ctx,
			);
			expect(result.details.servedByPath).toHaveLength(2);

			const handlerResult = await handler!(
				{
					toolName: "batch_edit",
					isError: false,
					input: { edits: [{ path: "a.txt" }, { path: "b.txt" }] },
					details: result.details,
					content: result.content,
				},
				ctx,
			);
			expect(handlerResult).toBeDefined();

			const store = await loadHashStore();
			expect(getServed(store, "test-session", aPath)).toEqual(
				await lineHashes("alpha\nBETA\ngamma\n", aPath),
			);
			expect(getServed(store, "test-session", bPath)).toEqual(
				await lineHashes("one\nTWO\nthree\n", bPath),
			);
		});
	});

	it("lets a follow-up single edit verify against the batch diff rows", async () => {
		await withTempDir("batch-chain-", async (dir) => {
			const aPath = join(dir, "a.txt");
			await writeFile(aPath, "alpha\nbeta\ngamma\n", "utf-8");

			const { pi, handlers, getTool } = makeFakePi();
			register(pi);
			const readTool = getTool("read");
			const editTool = getTool("edit");
			const batchTool = getTool("batch_edit");
			const handler = handlers.get("tool_result");
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "test-session" } };

			await readTool.execute("r1", { path: "a.txt" }, undefined, undefined, ctx);
			const aHashes = await lineHashes("alpha\nbeta\ngamma\n", aPath);

			const result = await batchTool.execute(
				"b1",
				{
					edits: [
						{ path: "a.txt", remove_from: aHashes[1]!, remove_to: aHashes[1]!, replacement_text: "BETA" },
					],
				},
				undefined,
				undefined,
				ctx,
			);

			await handler!(
				{
					toolName: "batch_edit",
					isError: false,
					input: { edits: [{ path: "a.txt" }] },
					details: result.details,
					content: result.content,
				},
				ctx,
			);

			const betaRow = result.details.diff
				.split("\n")
				.find((l: string) => l.includes("│BETA"))!;
			const betaHash = betaRow.split("│")[0]!.replace("+", "");

			const followUp = await editTool.execute(
				"e1",
				{
					path: "a.txt",
					remove_from: betaHash,
					remove_to: betaHash,
					replacement_text: "BETA2",
				},
				undefined,
				undefined,
				ctx,
			);
			expect(followUp.isError).toBeFalsy();
			const text = (followUp.content as Array<{ type: string; text: string }>)[0]!.text;
			expect(text).toContain("Successfully edited");
		});
	});
});
