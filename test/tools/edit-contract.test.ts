import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { Compile } from "typebox/compile";
import { editToolSchema, assertReq, buildToolDef } from "../../src/edit";
import { createEditTool } from "../../src/edit-tool.js";
import { normReq } from "../../src/edit-normalize";
import { lineHashes } from "../../src/hashline";
import { setupIntegrationTest, withTempFile } from "../support/fixtures";

describe("edit payload contract", () => {
  it("registers the object-root { file, edits } payload", () => {
    const validator = Compile(editToolSchema);
    expect(
      validator.Check({
        file: "sample.ts",
        edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
      }),
    ).toBe(true);
    expect(
      validator.Check({
        file: "sample.ts",
        edits: [
          { anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" },
          { anchor_from: "qWe", anchor_to: "rTy", replace_with: "" },
        ],
      }),
    ).toBe(true);
    expect(
      validator.Check({
        file: null,
        edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
      }),
    ).toBe(false);
    expect(validator.Check({ file: "sample.ts", edits: [["aB3", "cD4", "new"]] })).toBe(false);
    expect(validator.Check({ file: "sample.ts", anchor_from: "aB3" })).toBe(false);
    expect(validator.Check(["sample.ts", ["aB3", "cD4"], "new"])).toBe(false);
    expect(
      validator.Check({
        file: "",
        edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
      }),
    ).toBe(false);
    expect(
      validator.Check({
        file: "sample.ts",
        edits: [],
      }),
    ).toBe(false);
    expect(
      validator.Check({
        file: "sample.ts",
        edits: [{ remove_from: "aB3", remove_to: "cD4", replacement_text: "new" }],
      }),
    ).toBe(false);
  });

  it("normalizes modern { file, edits } objects and folds legacy shapes", () => {
    const normalized = normReq({
      file: "sample.ts",
      edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
    });
    expect(normalized).toMatchObject({
      file: "sample.ts",
      edits: [
        {
          anchor_from: "aB3",
          anchor_to: "cD4",
          replace_with: "new",
        },
      ],
    });
    expect(() => assertReq(normalized)).not.toThrow();
    // legacy tuple items fold to objects
    expect(normReq({ file: "sample.ts", edits: [["aB3", "cD4", "new"]] })).toMatchObject({
      file: "sample.ts",
      edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
    });
    // legacy root key and legacy item keys fold
    expect(
      normReq({
        path: "sample.ts",
        edits: [{ remove_from: "aB3", remove_to: "cD4", replacement_text: "new" }],
      }),
    ).toMatchObject({
      file: "sample.ts",
      edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
    });
    expect(() => assertReq(["sample.ts", ["aB3", "cD4"], "new"])).toThrow("exactly");
    expect(() =>
      assertReq({
        file: "sample.ts",
        anchor_from: "aB3",
        anchor_to: "cD4",
        replace_with: "new",
      }),
    ).toThrow("exactly");
  });

  it("rejects malformed payloads before mutation", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const tool = buildToolDef();
      await expect(
        tool.execute(
          "e1",
          { file: "sample.ts", edits: [{ anchor_from: "bad" }] } as any,
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow("E_BAD_PAYLOAD");
      expect(await readFile(path, "utf8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a null file fail-closed with E_BAD_PAYLOAD", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", path);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const tool = createEditTool();
      const error = await tool
        .execute(
          {
            file: null,
            edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "AAA" }],
          },
          undefined,
          ctx,
        )
        .then(
          () => {
            throw new Error("expected rejection");
          },
          (entry) => entry as Error,
        );
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain("Edit request must be exactly");
      expect(await readFile(path, "utf8")).toBe("aaa\nbbb\n");
    });
  });
});
