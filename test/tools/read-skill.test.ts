import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

const minimalPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

describe("read_skill tool", () => {
	it("returns skill content as plain text without hash anchors", async () => {
		await withTempFile("SKILL.md", "# Demo\n\nStep one.\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const tool = getTool("read_skill");

			const result = await tool.execute(
				"r1",
				{ path: "SKILL.md" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			const text = result.content[0].text;
			expect(text).toContain("# Demo");
			expect(text).toContain("Step one.");
			const hashedLines = text
				.split("\n")
				.filter((line: string) => /^[A-Za-z0-9]{3}│/.test(line));
			expect(hashedLines).toHaveLength(0);
		});
	});

	it("reads any path as plain text (not restricted to skills)", async () => {
		await withTempFile("notes.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const tool = getTool("read_skill");

			const result = await tool.execute(
				"r1",
				{ path: "notes.txt" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			const text = result.content[0].text;
			expect(text).toContain("alpha");
			expect(text).toContain("beta");
			expect(
				text.split("\n").some((line: string) => /^[A-Za-z0-9]{3}│/.test(line)),
			).toBe(false);
		});
	});

	it("accepts the file_path alias", async () => {
		await withTempFile("SKILL.md", "content\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const tool = getTool("read_skill");

			const result = await tool.execute(
				"r1",
				{ file_path: "SKILL.md" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(result.content[0].text).toContain("content");
		});
	});

	it("delegates image reads to the builtin read (image attachment)", async () => {
		await withTempFile("test.png", "", async ({ cwd }) => {
			const path = join(cwd, "test.png");
			await writeFile(path, minimalPng);

			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const tool = getTool("read_skill");

			const result = await tool.execute(
				"r1",
				{ path: "test.png" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(
				result.content.some(
					(entry: { type: string }) => entry.type === "image",
				),
			).toBe(true);
		});
	});

	it("reports a missing file with the extension's error contract", async () => {
		await withTempFile("x.txt", "x\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const tool = getTool("read_skill");

			await expect(
				tool.execute("r1", { path: "missing.md" }, undefined, undefined, {
					cwd,
				} as any),
			).rejects.toThrow("E_NOT_FOUND");
		});
	});

	it("borrows the builtin read's TUI renderers so output is collapsible", () => {
		const { pi, getTool } = makeFakePiRegistry();
		register(pi);
		const tool = getTool("read_skill");
		const theme = {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		const result = { content: [{ type: "text", text: "alpha\nbeta" }], isError: false };
		const baseContext = { args: { path: "notes.txt" }, cwd: "/tmp", showImages: true, isError: false };
		const collapsed = tool.renderResult(result, { expanded: false }, theme, baseContext);
		const expanded = tool.renderResult(result, { expanded: true }, theme, baseContext);
		expect(collapsed.render(80)).toEqual([]);
		expect(expanded.render(80).join("\n")).toContain("alpha");
	});
});
