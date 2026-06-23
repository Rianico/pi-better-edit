import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import {
	assertReq,
	editToolSchema,
	regReplace,
} from "../../src/replace";
import { lineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";
import register from "../../index";

describe("assertReq", () => {
	it("rejects unknown or unsupported root fields", () => {
		expect(() =>
			assertReq({ path: "a.ts", legacy_field: [] } as any),
		).toThrow(/unknown or unsupported fields/i);
	});

	it("rejects top-level oldText/newText with E_LEGACY_SHAPE", () => {

		expect(() =>
			assertReq({
				path: "a.ts",
				oldText: "before",
				newText: "after",
			} as any),
		).toThrow(/E_LEGACY_SHAPE/);
	});

	it("rejects top-level old_text/new_text with E_LEGACY_SHAPE", () => {
		expect(() =>
			assertReq({
				path: "a.ts",
				old_text: "before",
				new_text: "after",
			} as any),
		).toThrow(/E_LEGACY_SHAPE/);
	});

});

describe("regReplace", () => {
	it("publishes a schema with expected structure", () => {
		const schema = editToolSchema as any;

		expect(schema.type).toBe("object");

		const props = schema.properties;
		expect(props).toBeDefined();
		expect(props.path).toBeDefined();
		expect(props.edits).toBeDefined();

		expect(props.oldText).toBeUndefined();
		expect(props.newText).toBeUndefined();
		expect(props.old_text).toBeUndefined();
		expect(props.new_text).toBeUndefined();

		expect(schema.additionalProperties).toBe(false);
	});

	it("publishes a top-level object schema for pi tool registration", () => {
		expect((editToolSchema as any).type).toBe("object");
		expect((editToolSchema as any).anyOf).toBeUndefined();
	});

	it("prepareArguments passes hash-anchored requests through unchanged", () => {
		let registered:
			| {
					parameters?: any;
					prepareArguments?: (args: unknown) => unknown;
			  }
			| undefined;
		const pi = {
			registerTool(tool: {
				parameters?: any;
				prepareArguments?: (args: unknown) => unknown;
			}) {
				registered = tool;
			},
		} as any;

		regReplace(pi);

		expect(registered?.parameters).toEqual(editToolSchema);
		expect(typeof registered?.prepareArguments).toBe("function");

		const result = registered?.prepareArguments?.({
			path: "a.ts",
			edits: [{ hash_range_incl: ["ZZPM", "ZZPM"], new_lines: ["x"] }],
		});
		expect(result).toEqual({
			path: "a.ts",
			edits: [{ hash_range_incl: ["ZZPM", "ZZPM"], new_lines: ["x"] }],
		});
	});

	it("rejects malformed null lines during direct execute without modifying the file", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("replace");

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.txt",
						edits: [
							{
								hash_range_incl: [`${lineHash(1, "aaa")}`, `${lineHash(1, "aaa")}`], new_lines: null,
							},
						],
					},
					undefined,
					undefined,
					{ cwd } as any,
				),
			).rejects.toThrow(/lines" must be a string array/i);

			expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
		});
	});

	it("validates direct execute path before resolving mutation target", async () => {
		const { pi, getTool } = makeFakePiRegistry();
		register(pi);
		const editTool = getTool("replace");

		await expect(
			editTool.execute(
				"e1",
					{ edits: [{ hash_range_incl: ["aB3x", "aB3x"], new_lines: ["x"] }] },
				undefined,
				undefined,
				{ cwd: process.cwd() } as any,
			),
		).rejects.toThrow(/requires a non-empty "path" string/i);
	});

	it("renders details diff while keeping diff out of LLM-visible text", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("replace");

			const editArgs = {
				path: "sample.txt",
				edits: [
					{
						hash_range_incl: [lineHash(2, "bbb"), lineHash(2, "bbb")], new_lines: ["BBB"],
					},
				],
			};

			const result = await editTool.execute(
				"e1",
				editArgs,
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(typeof editTool.renderResult).toBe("function");

			const component = editTool.renderResult(
				result,
				{ expanded: false, isPartial: false },
				{
					bold: (text: string) => text,
					fg: (token: string, text: string) => `[${token}]${text}[/${token}]`,
				},
				{
					args: editArgs,
					isError: false,
					lastComponent: undefined,
				} as any,
			) as { render: (width: number) => string[] };

			const rendered = component.render(200).join("\n");

			expect(rendered).not.toContain("Changes: +1 -1");
			expect(rendered).not.toContain("Diff preview:");
			expect(rendered).not.toContain("```diff");
			expect(rendered).toContain(`${lineHash(2, "BBB")}│BBB`);
			expect(rendered).not.toContain("Updated sample.txt");
		expect(result.details?.diff).toContain(`+${lineHash(2, "BBB")}`);
		});
	});
});
