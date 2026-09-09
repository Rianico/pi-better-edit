import { describe, expect, it, vi, afterEach } from "vitest";
import {
	editRequestFrom,
	normReq,
	prepareEditArguments,
	assertReq,
} from "../../src/payload-contract";

afterEach(() => {
	vi.restoreAllMocks();
});

const ITEM = { anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" };

describe("legacy payload folding (ADR-0015 shim)", () => {
	it("folds legacy tuples to objects", () => {
		expect(
			editRequestFrom({ file: "a.ts", edits: [["aB3", "cD4", "new"]] }),
		).toEqual({ file: "a.ts", edits: [ITEM] });
	});

	it("folds the legacy path root key to file", () => {
		expect(
			editRequestFrom({ path: "a.ts", edits: [["aB3", "cD4", "new"]] }),
		).toEqual({ file: "a.ts", edits: [ITEM] });
	});

	it("folds legacy item keys to the modern triple", () => {
		expect(
			editRequestFrom({
				file: "a.ts",
				edits: [
					{ remove_from: "aB3", remove_to: "cD4", replacement_text: "new" },
				],
			}),
		).toEqual({ file: "a.ts", edits: [ITEM] });
	});

	it("prefers file over path and still warns for file_path", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = editRequestFrom({
			file: "real.ts",
			path: "legacy.ts",
			file_path: "alias.ts",
			edits: [ITEM],
		});
		expect(result?.file).toBe("real.ts");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('"file_path" is deprecated, use "file"'),
		);
	});

	it("keeps legacy null file for anchor inference (undocumented)", () => {
		expect(
			editRequestFrom({ path: null, edits: [["aB3", "cD4", "new"]] }),
		).toEqual({ file: null, edits: [ITEM] });
	});

	it("rejects mixed old/new item keys and extra item keys", () => {
		expect(
			editRequestFrom({
				file: "a.ts",
				edits: [{ anchor_from: "aB3", remove_to: "cD4", replace_with: "x" }],
			}),
		).toBeUndefined();
		expect(
			editRequestFrom({
				file: "a.ts",
				edits: [{ ...ITEM, file: "a.ts" }],
			}),
		).toBeUndefined();
	});

	it("prepareEditArguments returns schema-ready folded objects", () => {
		expect(
			prepareEditArguments({ path: "a.ts", edits: [["aB3", "cD4", "new"]] }),
		).toEqual({ file: "a.ts", edits: [ITEM] });
	});

	it("assertReq accepts folded output and names the new shape", () => {
		const folded = normReq({
			path: "a.ts",
			edits: [["aB3", "cD4", "new"]],
		});
		expect(() => assertReq(folded)).not.toThrow();
		expect(() => assertReq({ file: "a.ts" })).toThrow("exactly");
	});
});
