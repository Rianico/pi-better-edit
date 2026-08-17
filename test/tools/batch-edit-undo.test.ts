import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";
import { withTempDir, setupIntegrationTest, getText } from "../support/fixtures";

describe("batch_edit undo", () => {
	it("creates one undo record per touched file and undo restores pre-batch content", async () => {
		await withTempDir("batch-undo-", async (dir) => {
			const first = join(dir, "a.txt");
			const second = join(dir, "b.txt");
			await writeFile(first, "alpha\nbeta\ngamma\n", "utf-8");
			await writeFile(second, "one\ntwo\nthree\n", "utf-8");

			const { ctx, readTool, getTool } = setupIntegrationTest(dir);
			const batchTool = getTool("batch_edit");
			const undoTool = getTool("undo_last_edit");
			const aHashes = await lineHashes("alpha\nbeta\ngamma\n", first);
			const bHashes = await lineHashes("one\ntwo\nthree\n", second);
			await readTool.execute("r1", { path: "a.txt" }, undefined, undefined, ctx);
			await readTool.execute("r1", { path: "b.txt" }, undefined, undefined, ctx);

			const result = await batchTool.execute(
				"b1",
				[
						["a.txt", [aHashes[1]!, aHashes[1]!], "BETA"],
						["b.txt", [bHashes[1]!, bHashes[1]!], "TWO"],
					],
				undefined,
				undefined,
				ctx,
			);
			expect(getText(result)).toContain("Successfully edited 2 file(s)");

			const undoA = await undoTool.execute("u1", { path: "a.txt" }, undefined, undefined, ctx);
			expect(undoA.isError).toBeFalsy();
			expect(await readFile(first, "utf-8")).toBe("alpha\nbeta\ngamma\n");

			const undoB = await undoTool.execute("u1", { path: "b.txt" }, undefined, undefined, ctx);
			expect(undoB.isError).toBeFalsy();
			expect(await readFile(second, "utf-8")).toBe("one\ntwo\nthree\n");
		});
	});
});
