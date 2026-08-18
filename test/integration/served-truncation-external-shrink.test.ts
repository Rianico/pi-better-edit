import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { withTempFile, getText, extractHash } from "../support/fixtures";
import { loadHashStore } from "../../src/hash-store";
import { getServed, sessionKeyFor } from "../../src/served-state";

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

async function servedArray(
	ctx: ToolResultCtx,
	path: string,
): Promise<(string | null)[]> {
	const store = await loadHashStore();
	return getServed(store, sessionKeyFor(ctx as never), path);
}

function positionsOf(served: (string | null)[], hash: string): number[] {
	return served
		.map((h, i) => (h === hash ? i : -1))
		.filter((i) => i >= 0);
}

describe("served-state truncation survives an external shrink (issue #27)", () => {
	it("rejection echo after an external shrink leaves no hash at 2 served positions", async () => {
		await withTempFile(
			"sample.ts",
			"a\nb\nc\nd\ne\nf\ng\nh\n",
			async ({ cwd }) => {
				const { getTool } = makeSeamPi();
				const readTool = getTool("read");
				const editTool = getTool("edit");
				const ctx = { cwd };
				const abs = join(cwd, "sample.ts");

				const read = await readTool.execute(
					"r1",
					{ path: "sample.ts" },
					undefined,
					undefined,
					ctx,
				);
				const lines = getText(read).split("\n");
				const aRef = extractHash(lines.find((l) => l.includes("│a"))!);
				const fRef = extractHash(lines.find((l) => l.includes("│f"))!);
				expect(positionsOf(await servedArray(ctx, abs), fRef)).toEqual([5]);

				await writeFile(abs, "f\ng\n", "utf-8");

				await expect(
					editTool.execute(
						"e1",
						{ path: "sample.ts", edits: [[aRef, fRef, "F2"]] },
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/stale anchor/);

				const after = await servedArray(ctx, abs);
				const fPositions = positionsOf(after, fRef);
				expect(fPositions.length).toBeLessThanOrEqual(1);
				expect(fPositions[0]).toBe(0);
			},
		);
	});
});
