import { describe, expect, it } from "vitest";
import { writeFile, readFile } from "fs/promises";
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
		const line = lines.find((l) => l.includes(needle));
		if (!line) throw new Error(`read output did not show "${needle}"`);
		out[needle] = extractHash(line);
	}
	return out;
}

const RENDER_SRC = [
	"function render(items) {",
	"  const out = [];",
	"  for (const it of items) {",
	"    if (it.active) {",
	"      out.push(it.name);",
	"    }",
	"  }",
	"  return out.join(\", \");",
	"}",
	"",
].join("\n");

const RENDER_LINTED = [
	"function render(items) {",
	"  const out = [];",
	"  for (const it of items) {",
	"    if (it.active) {",
	"      try {",
	"        out.push(it.name);",
	"      } catch {}",
	"    }",
	"  }",
	"  return out.join(\", \");",
	"}",
	"",
].join("\n");

describe("whitespace-insensitive anchors at the tool seam (ADR-0005)", () => {
	it("edit -> external whitespace-only rewrite -> edit applies with pre-rewrite anchors", async () => {
		await withTempFile(
			"render.ts",
			RENDER_SRC,
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
				const abs = join(cwd, "render.ts");

				const refs = await hashRefs(readTool, "render.ts", ctx, [
					"out.push(it.name);",
				]);
				const pushRef = refs["out.push(it.name);"]!;

				const edit1: any = await editTool.execute(
					"e1",
					{ path: "render.ts", edits: [[pushRef, pushRef, "try {\n          out.push(it.name);\n        } catch {}"]] },
					undefined,
					undefined,
					ctx,
				);
				expect(getText(edit1)).toContain("Successfully edited");

				await toolResultHandler(
					{
						toolName: "edit",
						isError: false,
						input: { path: "render.ts" },
						details: edit1.details,
						content: edit1.content,
					},
					ctx,
				);

				await writeFile(abs, RENDER_LINTED, "utf-8");

				const edit2: any = await editTool.execute(
					"e2",
					{ path: "render.ts", edits: [[pushRef, pushRef, "out.push(it.name); // tagged"]] },
					undefined,
					undefined,
					ctx,
				);
				expect(getText(edit2)).toContain("Successfully edited");
				const final = await readFile(abs, "utf-8");
				expect(final).toContain("out.push(it.name); // tagged");
				expect(final).toContain("try {");
			},
		);
	});

	it("brace merged onto the signature line rejects with E_STALE_ANCHOR", async () => {
		await withTempFile(
			"f.ts",
			"func hello()\n{\n    }\n",
			async ({ cwd }) => {
				const { getTool } = makeSeamPi();
				const readTool = getTool("read");
				const editTool = getTool("edit");
				const ctx = { cwd };
				const abs = join(cwd, "f.ts");

				const refs = await hashRefs(readTool, "f.ts", ctx, ["func hello()"]);
				const sigRef = refs["func hello()"]!;

				await writeFile(abs, "func hello() {\n    }\n", "utf-8");

				await expect(
					editTool.execute(
						"e1",
						{ path: "f.ts", edits: [[sigRef, sigRef, "func hello() /* marked */"]] },
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow(/E_STALE_ANCHOR|stale anchor/);
			},
		);
	});

	it("chained edits through format churn apply without re-read", async () => {
		await withTempFile(
			"sample.ts",
			[
				"const alpha = 1;",
				"  const beta = 2;",
				"    const gamma = 3;",
				"      const delta = 4;",
				"",
			].join("\n"),
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
				const abs = join(cwd, "sample.ts");

				const refs = await hashRefs(readTool, "sample.ts", ctx, [
					"const beta = 2;",
				]);
				const betaRef = refs["const beta = 2;"]!;

				const edit1: any = await editTool.execute(
					"e1",
					{ path: "sample.ts", edits: [[betaRef, betaRef, "const beta = 22;"]] },
					undefined,
					undefined,
					ctx,
				);
				expect(getText(edit1)).toContain("Successfully edited");
				await toolResultHandler(
					{
						toolName: "edit",
						isError: false,
						input: { path: "sample.ts" },
						details: edit1.details,
						content: edit1.content,
					},
					ctx,
				);

				const diffLines = (edit1.details.diff as string).split("\n");
				const gammaRef = diffLines
					.find(
						(l) =>
							l.startsWith(" ") &&
							l.includes("const gamma = 3;") &&
							!l.startsWith("  "),
					)!
					.slice(1, 4);

				await writeFile(
					abs,
					[
						"const alpha = 1;",
						"const beta = 22;",
						"const gamma = 3;",
						"const delta = 4;",
						"",
					].join("\n"),
					"utf-8",
				);

				const edit2: any = await editTool.execute(
					"e2",
					{ path: "sample.ts", edits: [[gammaRef, gammaRef, "const gamma = 33;"]] },
					undefined,
					undefined,
					ctx,
				);
				expect(getText(edit2)).toContain("Successfully edited");
				expect(await readFile(abs, "utf-8")).toBe(
					[
						"const alpha = 1;",
						"const beta = 22;",
						"const gamma = 33;",
						"const delta = 4;",
						"",
					].join("\n"),
				);
			},
		);
	});
});
