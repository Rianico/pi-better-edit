import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";
import { withTempDir, setupIntegrationTest, getText } from "../support/fixtures";

describe("edit multi-item undo", () => {
	it("creates one undo record and undo restores the pre-call content", async () => {
		await withTempDir("edit-undo-", async (dir) => {
			const first = join(dir, "a.txt");
			await writeFile(first, "alpha\nbeta\ngamma\ndelta\n", "utf-8");

			const { ctx, readTool, editTool, getTool } = setupIntegrationTest(dir);
			const undoTool = getTool("undo_last_edit");
			const hashes = await lineHashes("alpha\nbeta\ngamma\ndelta\n", first);
			await readTool.execute("r1", { path: "a.txt" }, undefined, undefined, ctx);

			const result = await editTool.execute(
				"e1",
				{
					path: "a.txt",
					edits: [
						[hashes[0]!, hashes[0]!, "ALPHA"],
						[hashes[2]!, hashes[2]!, "GAMMA"],
					],
				},
				undefined,
				undefined,
				ctx,
			);
			expect(getText(result)).toContain("Successfully edited 1 file(s)");
			expect(await readFile(first, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");

			const undoA = await undoTool.execute(
				"u1",
				{ path: "a.txt" },
				undefined,
				undefined,
				ctx,
			);
			expect(undoA.isError).toBeFalsy();
			expect(await readFile(first, "utf-8")).toBe("alpha\nbeta\ngamma\ndelta\n");
		});
	});
});
