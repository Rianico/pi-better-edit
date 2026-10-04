import { describe, expect, it } from "vitest";
import { getPreviewInput } from "../../src/payload-contract";
import { getPreviewInput as renderPreviewInput } from "../../src/edit-render";

// WHY: (ticket-04 §3) the edit payload accepts ONLY `file` — the `path`/`file_path` aliases and
// WHY: their model-facing deprecation warning were shipped tolerance and are deliberately gone.
// WHY: The shared `normalizeFilePath` alias used by the non-edit tools is now removed too: there
// WHY: is no compatibility window, so `file_path` is an unknown field on every surface. What
// WHY: remains is the invalid-payload parity check between the contract and the render preview.
describe("edit preview parity", () => {
  it("getPreviewInput returns null for invalid payload, consistent with editRequestFrom", () => {
    expect(getPreviewInput({ file: "sample.ts", edits: [] })).toBeNull();
    expect(renderPreviewInput({ file: "sample.ts", edits: [] })).toBeNull();
  });
});
