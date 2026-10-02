import { describe, expect, it } from "vitest";
import { normReq } from "../../src/edit-normalize";

describe("normReq", () => {
  it("returns non-objects as-is for runtime validation", () => {
    expect(normReq("string")).toBe("string");
    expect(normReq(null)).toBe(null);
    expect(normReq({ file: "test.txt" })).toEqual({ file: "test.txt" });
  });

  it("normalizes the exact { file, edits } shape", () => {
    expect(
      normReq({
        file: "src/main.ts",
        edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "new" }],
      }),
    ).toMatchObject({
      file: "src/main.ts",
      edits: [
        {
          target: { anchor_from: "aB3", anchor_to: "cD4" },
          at: "in-place",
          payload: { kind: "literal", text: "new" },
        },
      ],
    });
  });

  it("folds an empty text to an empty payload", () => {
    expect(
      normReq({ file: "src/main.ts", edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "" }] }),
    ).toMatchObject({
      file: "src/main.ts",
      edits: [
        {
          target: { anchor_from: "aB3", anchor_to: "cD4" },
          at: "in-place",
          payload: { kind: "empty" },
        },
      ],
    });
  });

  it("rejects a null file fail-closed", () => {
    const input = { file: null, edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "new" }] };
    expect(normReq(input)).toBe(input);
  });

  it("does not normalize malformed payloads", () => {
    const malformed = { file: "test.txt", edits: [["aB3"], "new"] };
    expect(normReq(malformed)).toBe(malformed);
    expect(normReq({ file: "test.txt", edits: [] })).toEqual({
      file: "test.txt",
      edits: [],
    });
  });

  it("does not mutate input", () => {
    const input = {
      file: "test.txt",
      edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "new" }],
    };
    normReq(input);
    expect(input).toEqual({
      file: "test.txt",
      edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "new" }],
    });
  });
});
