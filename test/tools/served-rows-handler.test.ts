import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { loadHashStore } from "../../src/hash-store";
import { getServed } from "../../src/served-state";
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

function overlay(
	rows: Array<{ position: number; hash: string }>,
	base: (string | null)[] = [],
): (string | null)[] {
	const updated = base.slice();
	for (const row of rows) {
		while (updated.length <= row.position) updated.push(null);
		updated[row.position] = row.hash;
	}
	while (updated.length > 0 && updated[updated.length - 1] === null)
		updated.pop();
	return updated;
}

describe("served-rows tool_result handler", () => {
	it("records edit diff rows as serves when auto-read is on", async () => {
		await withTempDir("served-edit-", async (dir) => {
			const filePath = join(dir, "sample.txt");
			await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf-8");

			const { pi, handlers, getTool } = makeFakePi();
			register(pi);
			const readTool = getTool("read");
			const editTool = getTool("edit");
			const handler = handlers.get("tool_result");
			expect(handler).toBeDefined();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "test-session" } };

			const readResult = await readTool.execute(
				"r1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				ctx,
			);
			const readText = (
				readResult.content as Array<{ type: string; text: string }>
			)[0]!.text;
			const betaRef = readText
				.split("\n")
				.find((l) => l.includes("│beta"))!
				.split("│")[0]!;

			const editResult = await editTool.execute(
				"e1",
				["sample.txt", [betaRef, betaRef], "BETA"],
				undefined,
				undefined,
				ctx,
			);
			expect(editResult.details.servedRows).toBeDefined();
			expect(editResult.details.servedRows.length).toBeGreaterThan(0);

			const store = await loadHashStore();
			const servedBefore = getServed(store, "test-session", filePath);

			const result = await handler!(
				{
					toolName: "edit",
					isError: false,
					input: [null, [betaRef, betaRef], "BETA"],
					details: editResult.details,
					content: editResult.content,
				},
				ctx,
			);
			expect(result).toBeDefined();
			const content = (
				result as { content: Array<{ type: string; text: string }> }
			).content;
			expect(content).toHaveLength(1);
			expect(content[0]!.text).toBe(editResult.details.diff);

			const servedAfter = getServed(store, "test-session", filePath);
			expect(servedAfter).toEqual(
				overlay(editResult.details.servedRows, servedBefore),
			);
			for (const row of editResult.details.servedRows) {
				expect(servedAfter[row.position]).toBe(row.hash);
			}
		});
	});

	it("records undo_last_edit diff rows as serves (restored hashes)", async () => {
		await withTempDir("served-undo-", async (dir) => {
			const filePath = join(dir, "sample.txt");
			await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf-8");

			const { pi, handlers, getTool } = makeFakePi();
			register(pi);
			const readTool = getTool("read");
			const editTool = getTool("edit");
			const undoTool = getTool("undo_last_edit");
			const handler = handlers.get("tool_result");
			expect(handler).toBeDefined();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "test-session" } };

			await readTool.execute(
				"r1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				ctx,
			);
			const originalHashes = await lineHashes("alpha\nbeta\ngamma\n", filePath);

			await editTool.execute(
				"e1",
				["sample.txt", [originalHashes[1]!, originalHashes[1]!], "BETA"],
				undefined,
				undefined,
				ctx,
			);

			const undoResult = await undoTool.execute(
				"u1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				ctx,
			);
			expect(undoResult.isError).toBeFalsy();
			expect(undoResult.details.servedRows).toBeDefined();
			expect(undoResult.details.servedRows.length).toBeGreaterThan(0);

			const result = await handler!(
				{
					toolName: "undo_last_edit",
					isError: false,
					input: { path: "sample.txt" },
					details: undoResult.details,
					content: undoResult.content,
				},
				ctx,
			);
			expect(result).toBeDefined();

			const store = await loadHashStore();
			const served = getServed(store, "test-session", filePath);
			expect(served).toEqual(overlay(undoResult.details.servedRows));
			expect(served).toEqual(originalHashes);
		});
	});

	it("records auto-read preview rows after a write when auto-read is on", async () => {
		await withTempDir("served-write-", async (dir) => {
			const filePath = join(dir, "test.txt");
			await writeFile(filePath, "hello\nworld\n", "utf-8");

			const { pi, handlers } = makeFakePi();
			register(pi);
			const handler = handlers.get("tool_result");
			expect(handler).toBeDefined();

			const result = await handler!(
				{
					toolName: "write",
					isError: false,
					input: { path: "test.txt" },
					content: [{ type: "text", text: "File written." }],
				},
				{ cwd: dir, sessionManager: { getSessionId: () => "test-session" } },
			);
			expect(result).toBeDefined();

			const store = await loadHashStore();
			const expected = await lineHashes("hello\nworld\n", filePath);
			expect(getServed(store, "test-session", filePath)).toEqual(expected);
		});
	});
});
