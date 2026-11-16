import { describe, expect, it } from "vitest";
import { getPreviewInput } from "../../src/payload-contract";
import { getPreviewInput as renderPreviewInput } from "../../src/edit-render";

describe("edit preview parity", () => {
  it("getPreviewInput returns null for invalid payload, consistent with editRequestFrom", () => {
    expect(getPreviewInput({ file: "sample.ts", edits: [] })).toBeNull();
    expect(renderPreviewInput({ file: "sample.ts", edits: [] })).toBeNull();
  });
});
