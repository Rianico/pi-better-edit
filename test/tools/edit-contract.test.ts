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
        edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "new" }],
      }),
    ).toBe(true);
    expect(
      validator.Check({
        file: "sample.ts",
        edits: [
          { anchor_from: "aB3", anchor_to: "cD4", text: "x" },
          { anchor_from: "qWe", anchor_to: "rTy", text: "" },
        ],
      }),
    ).toBe(true);
    expect(
      validator.Check({
        file: null,
        edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "new" }],
      }),
    ).toBe(false);
    // WHY: (ticket-04 §3) tuple items are refused outright — the legacy fold is gone.
    expect(validator.Check({ file: "sample.ts", edits: [["aB3", "cD4", "new"]] })).toBe(false);
    expect(validator.Check({ file: "sample.ts", anchor_from: "aB3" })).toBe(false);
    expect(validator.Check(["sample.ts", ["aB3", "cD4"], "new"])).toBe(false);
    expect(
      validator.Check({
        file: "",
        edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "new" }],
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
    // WHY: and it resolves bare 4-char anchors through a content-hash port
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
      "at",
      "text",
      "text_ref",
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
      // WHY: (ticket-04 §3) the retired wire spellings must not sneak back in either.
      "replace_with",
      "op",
    ];
    for (const alias of aliases) {
      expect(Object.keys(root.properties)).not.toContain(alias);
      expect(Object.keys(item.properties)).not.toContain(alias);
    }
  });

  it("normalizes modern { file, edits } objects", () => {
    const normalized = normReq({
      file: "sample.ts",
      edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "new" }],
    });
    expect(normalized).toMatchObject({
      file: "sample.ts",
      edits: [
        {
          target: { anchor_from: "aB3", anchor_to: "cD4" },
          at: "in-place",
          payload: { kind: "literal", text: "new" },
        },
      ],
    });
    expect(() => assertReq(normalized)).not.toThrow();
    // WHY: (ticket-04 §3) tuples and legacy item keys are REFUSED, not folded: `normReq`
    // WHY: passes the raw input through untouched.
    const tupleReq = { file: "sample.ts", edits: [["aB3", "cD4", "new"]] };
    expect(normReq(tupleReq)).toBe(tupleReq);
    const legacyKeys = {
      file: "sample.ts",
      edits: [{ remove_from: "aB3", remove_to: "cD4", replacement_text: "new" }],
    };
    expect(normReq(legacyKeys)).toBe(legacyKeys);
    expect(() => assertReq(["sample.ts", ["aB3", "cD4"], "new"])).toThrow("exactly");
    expect(() =>
      assertReq({
        file: "sample.ts",
        anchor_from: "aB3",
        anchor_to: "cD4",
        text: "new",
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
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const tool = createEditTool();
      const error = await tool
        .execute(
          {
            file: null,
            edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "AAA" }],
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
      expect(String(error.message)).toContain(
        'Edit request "file" must be a non-empty string path to a text file',
      );
      expect(await readFile(path, "utf8")).toBe("aaa\nbbb\n");
    });
  });
});
