import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { Compile } from "typebox/compile";
import { editToolSchema, assertReq, buildToolDef } from "../../src/edit";
import { editItemSchema } from "../../src/payload-contract.js";
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

  it("pins the wire-shape key set against third-party shape adapters", () => {
    // WHY: pi-lens ships a shape-adapter registry over third-party edit tools
    // WHY: (`dist/clients/mutating-tool.js`): it recognizes `set_line` / `replace_lines`,
    // WHY: `operations` / `ops` batches and `remove_from` + `remove_to` + `replacement_lines`,
    // WHY: and it resolves bare 3-char anchors through a content-hash port
    // WHY: (`dist/clients/hashline-anchor.js`). Our payload matches none of those shapes, which is
    // WHY: exactly what keeps its read-guard inert for our edits (`reasonKind: "no_line_info"`);
    // WHY: its path resolver takes `path` / `filePath` / `file_path`, never our `file`.
    // WHY: Adding one of those keys — or renaming ours — would arm that adapter and let it judge
    // WHY: MVCC line identity with a divergent scheme, producing false "stale" and "out of range"
    // WHY: verdicts on edits our own verification accepts. Change this list deliberately, never
    // WHY: casually: the coupling is the consequence.
    const root = editToolSchema as unknown as {
      properties: Record<string, unknown>;
      additionalProperties?: unknown;
    };
    const item = editItemSchema as unknown as {
      properties: Record<string, unknown>;
      additionalProperties?: unknown;
    };

    expect(Object.keys(root.properties).sort()).toEqual(["edits", "file", "mode"]);
    expect(Object.keys(item.properties).sort()).toEqual([
      "anchor_from",
      "anchor_to",
      "replace_with",
    ]);
    expect(root.additionalProperties).toBe(false);
    expect(item.additionalProperties).toBe(false);

    const aliases = [
      "path",
      "filePath",
      "file_path",
      "set_line",
      "replace_lines",
      "operations",
      "ops",
      "remove_from",
      "remove_to",
      "replacement_lines",
      "replacement_text",
    ];
    for (const alias of aliases) {
      expect(Object.keys(root.properties)).not.toContain(alias);
      expect(Object.keys(item.properties)).not.toContain(alias);
    }
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
          target: { anchor_from: "aB3", anchor_to: "cD4" },
          at: "replace",
          payload: { kind: "hand-written", text: "new" },
        },
      ],
    });
    expect(() => assertReq(normalized)).not.toThrow();
    // legacy tuple items fold to normalized items
    expect(normReq({ file: "sample.ts", edits: [["aB3", "cD4", "new"]] })).toMatchObject({
      file: "sample.ts",
      edits: [
        {
          target: { anchor_from: "aB3", anchor_to: "cD4" },
          at: "replace",
          payload: { kind: "hand-written", text: "new" },
        },
      ],
    });
    // legacy root key and legacy item keys fold
    expect(
      normReq({
        path: "sample.ts",
        edits: [{ remove_from: "aB3", remove_to: "cD4", replacement_text: "new" }],
      }),
    ).toMatchObject({
      file: "sample.ts",
      edits: [
        {
          target: { anchor_from: "aB3", anchor_to: "cD4" },
          at: "replace",
          payload: { kind: "hand-written", text: "new" },
        },
      ],
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
