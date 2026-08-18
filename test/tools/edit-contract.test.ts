import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { Compile } from "typebox/compile";
import { editToolSchema, assertReq, buildToolDef } from "../../src/edit";
import { normReq } from "../../src/edit-normalize";
import { lineHashes } from "../../src/hashline";
import { setupIntegrationTest, withTempFile } from "../support/fixtures";

describe("edit payload contract", () => {
	it("registers the object-root { path, edits } payload", () => {
		const validator = Compile(editToolSchema);
		expect(
			validator.Check({ path: "sample.ts", edits: [["aB3", "cD4", "new"]] }),
		).toBe(true);
		expect(
			validator.Check({ path: null, edits: [["aB3", "cD4", "new"]] }),
		).toBe(true);
		expect(
			validator.Check({
				path: "sample.ts",
				edits: [
					["aB3", "cD4", "x"],
					["qWe", "rTy", ""],
				],
			}),
		).toBe(true);
		expect(validator.Check({ path: "sample.ts", remove_from: "aB3" })).toBe(
			false,
		);
		expect(validator.Check(["sample.ts", ["aB3", "cD4"], "new"])).toBe(false);
		expect(validator.Check({ path: "", edits: [["aB3", "cD4", "new"]] })).toBe(
			false,
		);
		expect(validator.Check({ path: "sample.ts", edits: [] })).toBe(false);
		expect(validator.Check({ edit: ["sample.ts", ["aB3", "cD4"], "new"] })).toBe(
			false,
		);
	});

	it("normalizes only valid { path, edits } structure and rejects old shapes", () => {
		const normalized = normReq({
			path: "sample.ts",
			edits: [["aB3", "cD4", "new"]],
		});
		expect(normalized).toMatchObject({
			path: "sample.ts",
			edits: [
				{
					remove_from: "aB3",
					remove_to: "cD4",
					replacement_text: "new",
				},
			],
		});
		expect(() => assertReq(normalized)).not.toThrow();
		expect(() => assertReq(["sample.ts", ["aB3", "cD4"], "new"])).toThrow(
			"exactly",
		);
		expect(() =>
			assertReq({
				path: "sample.ts",
				remove_from: "aB3",
				remove_to: "cD4",
				replacement_text: "new",
			}),
		).toThrow("exactly");
	});

	it("rejects malformed payloads before mutation", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
			const tool = buildToolDef();
			await expect(
				tool.execute(
					"e1",
					{ path: "sample.ts", edits: [["bad"]] } as any,
					undefined,
					undefined,
					{ cwd } as any,
				),
			).rejects.toThrow("E_BAD_SHAPE");
			expect(await readFile(path, "utf8")).toBe("aaa\nbbb\n");
		});
	});

	it("uses null path for existing anchor-based inference", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\n", path);
			await readTool.execute(
				"r1",
				{ path: "sample.ts" },
				undefined,
				undefined,
				ctx,
			);
			const result = await editTool.execute(
				"e1",
				{
					path: null,
					edits: [[hashes[0]!, hashes[0]!, "AAA"]],
				},
				undefined,
				undefined,
				ctx,
			);
			expect(result.content[0].text).toContain("Successfully edited");
			expect(await readFile(path, "utf8")).toBe("AAA\nbbb\n");
		});
	});
});
