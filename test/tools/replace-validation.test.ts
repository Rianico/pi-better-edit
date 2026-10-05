import { describe, expect, it } from "vitest";
import { assertReq, buildToolDef } from "../../src/edit";
import { normReq } from "../../src/edit-normalize";
import { testSessionManager } from "../support/fixtures";

describe("assertReq", () => {
  it("throws for non-object payloads", () => {
    expect(() => assertReq("string")).toThrow("E_BAD_PAYLOAD");
    expect(() => assertReq(null)).toThrow("E_BAD_PAYLOAD");
    expect(() => assertReq({ path: "test.txt" })).toThrow("E_BAD_PAYLOAD");
  });

  it("rejects flat named fields without the edits wrapper", () => {
    expect(() =>
      assertReq({
        file: "test.txt",
        anchor_from: "AAA",
        anchor_to: "BBB",
        replace_with: "new",
      }),
    ).toThrow("exactly");
  });

  it("accepts canonical payloads and rejects a null file fail-closed", () => {
    expect(() =>
      assertReq(
        normReq({
          file: "test.txt",
          edits: [{ anchor_from: "AAA", anchor_to: "BBB", text: "new" }],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertReq(
        normReq({ file: null, edits: [{ anchor_from: "AAA", anchor_to: "BBB", text: "new" }] }),
      ),
    ).toThrow("exactly");
  });

  it("rejects malformed shapes and member types", () => {
    expect(() => assertReq("string")).toThrow("E_BAD_PAYLOAD");
    expect(() => assertReq({ file: "test.txt", edits: [["AAA"]] })).toThrow("E_BAD_PAYLOAD");
    expect(() =>
      assertReq({
        file: "test.txt",
        edits: [{ anchor_from: "AAA", anchor_to: "BBB", text: null }],
      }),
    ).toThrow("E_BAD_PAYLOAD");
    expect(() =>
      assertReq({ file: "", edits: [{ anchor_from: "AAA", anchor_to: "BBB", text: "new" }] }),
    ).toThrow("E_BAD_PAYLOAD");
    expect(() =>
      assertReq({ file: "test.txt", edits: [{ anchor_from: "AAA", anchor_to: 42, text: "new" }] }),
    ).toThrow("E_BAD_PAYLOAD");
  });
});

describe("anchor validation order", () => {
  it("rejects malformed anchors before any file I/O", async () => {
    const tool = buildToolDef();
    await expect(
      tool.execute(
        "e1",
        {
          file: "does-not-exist.ts",
          edits: [{ anchor_from: "abc", anchor_to: "abc", text: "x" }],
        },
        undefined,
        undefined,
        { cwd: "/tmp", sessionManager: testSessionManager } as any,
      ),
    ).rejects.toThrow(/\[E_MALFORMED_ANCHOR\]/);
  });
});
describe("prepareArguments normalization", () => {
  it("keeps the canonical object-root payload unchanged", () => {
    const tool = buildToolDef();
    const args = {
      file: "test.txt",
      edits: [{ anchor_from: "AAA", anchor_to: "BBB", text: "line1\nline2" }],
    };
    expect(tool.prepareArguments!(args)).toEqual(args);
  });

  it("keeps canonical items unchanged and fails closed on a null file", () => {
    const tool = buildToolDef();
    expect(
      tool.prepareArguments!({
        file: "test.txt",
        edits: [{ anchor_from: "AAA", anchor_to: "BBB", text: "x" }],
      }),
    ).toEqual({
      file: "test.txt",
      edits: [{ anchor_from: "AAA", anchor_to: "BBB", text: "x" }],
    });
    expect(() =>
      tool.prepareArguments!({
        file: null,
        edits: [{ anchor_from: "AAA", anchor_to: "BBB", text: "x" }],
      }),
    ).toThrow(/\[E_BAD_PAYLOAD\]/);
  });

  it("rejects malformed shapes with an actionable E_BAD_PAYLOAD hint", () => {
    const tool = buildToolDef();
    const bad = [
      undefined,
      {},
      "test.txt",
      ["test.txt", ["AAA", "BBB"], "x"],
      { edit: ["test.txt", ["AAA", "BBB"], "x"] },
      { file: "test.txt" },
      { file: "test.txt", edits: [] },
    ];
    for (const args of bad) {
      expect(() => tool.prepareArguments!(args)).toThrow(/\[E_BAD_PAYLOAD\]/);
      expect(() => tool.prepareArguments!(args)).toThrow(
        /canonical payload|it is exactly \{ file|an item is exactly/,
      );
    }
  });

  it("rejects flat named fields with the canonical-shape hint", () => {
    const tool = buildToolDef();
    expect(() =>
      tool.prepareArguments!({
        file: "test.txt",
        anchor_from: "AAA",
        anchor_to: "BBB",
        replace_with: "new",
      }),
    ).toThrow(/canonical payload|it is exactly \{ file/);
  });
});
