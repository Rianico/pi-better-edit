import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { Compile } from "typebox/compile";
import { editToolSchema, assertReq, buildToolDef, resolveMissingPath } from "../../src/edit";
import { normReq } from "../../src/edit-normalize";
import { lineHashes } from "../../src/hashline";
import { setupIntegrationTest, withTempFile } from "../support/fixtures";

describe("edit payload contract", () => {
	it("registers the object-root { file, edits } payload", () => {
		const validator = Compile(editToolSchema);
		expect(
			validator.Check({
				file: "sample.ts",
				edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
			}),
		).toBe(true);
		expect(
			validator.Check({
				file: "sample.ts",
				edits: [
					{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" },
					{ anchor_from: "qWe", anchor_to: "rTy", replace_with: "" },
				],
			}),
		).toBe(true);
		expect(
			validator.Check({
				file: null,
				edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
			}),
		).toBe(false);
		expect(
			validator.Check({ file: "sample.ts", edits: [["aB3", "cD4", "new"]] }),
		).toBe(false);
		expect(
			validator.Check({ file: "sample.ts", anchor_from: "aB3" }),
		).toBe(false);
		expect(validator.Check(["sample.ts", ["aB3", "cD4"], "new"])).toBe(false);
		expect(
			validator.Check({
				file: "",
				edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
			}),
		).toBe(false);
		expect(
			validator.Check({
				file: "sample.ts",
				edits: [],
			}),
		).toBe(false);
		expect(
			validator.Check({
				file: "sample.ts",
				edits: [
					{ remove_from: "aB3", remove_to: "cD4", replacement_text: "new" },
				],
			}),
		).toBe(false);
	});

	it("normalizes modern { file, edits } objects and folds legacy shapes", () => {
		const normalized = normReq({
			file: "sample.ts",
			edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
		});
		expect(normalized).toMatchObject({
			file: "sample.ts",
			edits: [
				{
					anchor_from: "aB3",
					anchor_to: "cD4",
					replace_with: "new",
				},
			],
		});
		expect(() => assertReq(normalized)).not.toThrow();
		// legacy tuple items fold to objects
		expect(
			normReq({ file: "sample.ts", edits: [["aB3", "cD4", "new"]] }),
		).toMatchObject({
			file: "sample.ts",
			edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
		});
		// legacy root key and legacy item keys fold
		expect(
			normReq({
				path: "sample.ts",
				edits: [{ remove_from: "aB3", remove_to: "cD4", replacement_text: "new" }],
			}),
		).toMatchObject({
			file: "sample.ts",
			edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
		});
		expect(() => assertReq(["sample.ts", ["aB3", "cD4"], "new"])).toThrow(
			"exactly",
		);
		expect(() =>
			assertReq({
				file: "sample.ts",
				anchor_from: "aB3",
				anchor_to: "cD4",
				replace_with: "new",
			}),
		).toThrow("exactly");
	});

	it("rejects malformed payloads before mutation", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
			const tool = buildToolDef();
			await expect(
				tool.execute(
					"e1",
					{ file: "sample.ts", edits: [{ anchor_from: "bad" }] } as any,
					undefined,
					undefined,
					{ cwd } as any,
				),
			).rejects.toThrow("E_BAD_PAYLOAD");
			expect(await readFile(path, "utf8")).toBe("aaa\nbbb\n");
		});
	});

	it("requires file on the tool surface; legacy inference lives in resolveMissingPath", async () => {
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
			// null file is rejected by the public schema: pass the file
			await expect(
				editTool.execute(
					"e1",
					{
						file: null,
						edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "AAA" }],
					},
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow("E_BAD_PAYLOAD");
			// legacy anchor inference still resolves internally when only one file matches
			const resolution = await resolveMissingPath({
				anchor_from: hashes[0]!,
				anchor_to: hashes[0]!,
			});
			expect(resolution?.file.endsWith("sample.ts")).toBe(true);
			expect(await readFile(path, "utf8")).toBe("aaa\nbbb\n");
		});
	});
});
