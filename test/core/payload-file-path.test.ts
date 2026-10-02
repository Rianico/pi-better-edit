import { describe, expect, it, vi } from "vitest";
import { getPreviewInput } from "../../src/payload-contract";
import { normalizeFilePath } from "../../src/utils";
import { getPreviewInput as renderPreviewInput } from "../../src/edit-render";

// WHY: (ticket-04 §3) the edit payload accepts ONLY `file` — the `path`/`file_path` aliases and
// WHY: their model-facing deprecation warning were shipped tolerance and are deliberately gone.
// WHY: What remains here is the shared `normalizeFilePath` alias used by the non-edit tools
// WHY: (read/write), which the edit wire never went through, plus the invalid-payload parity
// WHY: between the contract and render preview entry points.
describe("edit preview parity", () => {
  it("getPreviewInput returns null for invalid payload, consistent with editRequestFrom", () => {
    expect(getPreviewInput({ file: "sample.ts", edits: [] })).toBeNull();
    expect(renderPreviewInput({ file: "sample.ts", edits: [] })).toBeNull();
  });
});

describe("utils normalizeFilePath file_path alias (non-edit tools)", () => {
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
