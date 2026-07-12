import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

const minimalPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

describe("read tool image delegation", () => {
	it("delegates a PNG read to the built-in read tool and returns an image attachment", async () => {
		await withTempFile("test.png", "", async ({ cwd }) => {
			const path = join(cwd, "test.png");
			await writeFile(path, minimalPng);

			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const readTool = getTool("read");

			const result = await readTool.execute(
				"r1",
				{ path: "test.png" },
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(result.content).toBeDefined();
			expect(result.content.length).toBeGreaterThan(0);
			expect(result.content.some((entry: { type: string }) => entry.type === "image")).toBe(true);
		});
	});

	it("delegates an image read even when the filename contains spaces", async () => {
		await withTempFile("test.png", "", async ({ cwd }) => {
			const fileName = "Screenshot 2026-06-22 at 15.02.44.png";
			const path = join(cwd, fileName);
			await writeFile(path, minimalPng);

			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const readTool = getTool("read");

			const result = await readTool.execute(
				"r1",
				{ path: fileName },
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(result.content).toBeDefined();
			expect(result.content.some((entry: { type: string }) => entry.type === "image")).toBe(true);
		});
	});
});
