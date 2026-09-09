import { describe, expect, it, vi } from "vitest";
import { editRequestFrom, getPreviewInput, prepareEditArguments } from "../../src/payload-contract";
import { normalizeFilePath } from "../../src/utils";
import { getPreviewInput as renderPreviewInput } from "../../src/edit-render";
import { setupIntegrationTest, withTempFile } from "../support/fixtures";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";

describe("payload-contract file_path deprecation", () => {
	it("editRequestFrom accepts file_path alias and warns", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = editRequestFrom({ file_path: "sample.ts", edits: [["AAA", "BBB", "x"]] });
		expect(result).toEqual({ file: "sample.ts", edits: [{ anchor_from: "AAA", anchor_to: "BBB", replace_with: "x" }] });
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("file_path"));
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("DEPRECATED"));
		warnSpy.mockRestore();
	});

	it("editRequestFrom prefers path over file_path but still warns", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = editRequestFrom({ file: "real.ts", file_path: "alias.ts", edits: [["AAA", "BBB", "x"]] });
		expect(result?.file).toBe("real.ts");
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("prepareEditArguments handles file_path alias and warns", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = prepareEditArguments({ file_path: "sample.ts", edits: [["AAA", "BBB", "x"]] });
		expect(result.file).toBe("sample.ts");
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("getPreviewInput handles file_path alias (no flicker vs execute)", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const previewViaContract = getPreviewInput({ file_path: "sample.ts", edits: [["AAA", "BBB", "x"]] });
		const previewViaRender = renderPreviewInput({ file_path: "sample.ts", edits: [["AAA", "BBB", "x"]] });
		expect(previewViaContract).not.toBeNull();
		expect(previewViaRender).not.toBeNull();
		expect(previewViaContract?.file).toBe("sample.ts");
		expect(previewViaRender?.file).toBe("sample.ts");
		expect(previewViaContract).toEqual(previewViaRender);
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("getPreviewInput returns null for invalid payload, consistent with editRequestFrom", () => {
		expect(getPreviewInput({ file_path: "sample.ts", edits: [] })).toBeNull();
		expect(renderPreviewInput({ file_path: "sample.ts", edits: [] })).toBeNull();
	});

	it("normalizeFilePath warns for file_path alias", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const record: Record<string, unknown> = { file_path: "sample.ts" };
		normalizeFilePath(record);
		expect(record.path).toBe("sample.ts");
		expect(record.file_path).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("DEPRECATED"));
		warnSpy.mockRestore();
	});

	it("normalizeFilePath warns and drops file_path when path already present", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const record: Record<string, unknown> = { path: "real.ts", file_path: "alias.ts" };
		normalizeFilePath(record);
		expect(record.path).toBe("real.ts");
		expect(record.file_path).toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

describe("edit tool file_path integration", () => {
	it("edits via file_path alias (deprecated) and warns", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\n", path);
			await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const result = await editTool.execute(
				"e1",
				{ file_path: "sample.ts", edits: [[hashes[0]!, hashes[0]!, "AAA"]] } as any,
				undefined,
				undefined,
				ctx,
			);
			expect(result.content[0].text).toContain("Successfully edited");
			expect(await readFile(path, "utf8")).toBe("AAA\nbbb\n");
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("DEPRECATED"));
			warnSpy.mockRestore();
		});
	});

	it("preview via file_path is consistent with execute (no flicker)", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { ctx, readTool } = setupIntegrationTest(cwd);
			const hashes = await lineHashes("aaa\nbbb\n", path);
			await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
			const { getPreviewInput } = await import("../../src/edit-render");
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const previewInput = getPreviewInput({ file_path: "sample.ts", edits: [[hashes[0]!, hashes[0]!, "AAA"]] } as any);
			expect(previewInput).not.toBeNull();
			expect(previewInput?.file).toBe("sample.ts");
			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});
	});
});
