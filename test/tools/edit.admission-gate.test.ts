import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { createEditTool } from "../../src/edit-tool.js";
import { assertReq, normReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { withTempFile, setupIntegrationTest } from "../support/fixtures";

const STRUCTURAL_PREFIX =
  'Edit request must be exactly { file, edits: [{ anchor_from, anchor_to, replace_with }, ...], mode?: "general" | "literal" }.';

async function executeWithFile(cwd: string, fileValue: unknown): Promise<Error> {
  const { ctx, readTool } = setupIntegrationTest(cwd);
  const hashes = await lineHashes("aaa\nbbb\n", `${cwd}/sample.ts`);
  await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
  const tool = createEditTool();
  const payload: Record<string, unknown> = {
    edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "AAA" }],
  };
  if (fileValue !== undefined) payload.file = fileValue;
  return tool.execute(payload, undefined, ctx).then(
    () => {
      throw new Error("expected rejection");
    },
    (entry) => entry as Error,
  );
}

function messageOf(shape: unknown): string {
  try {
    assertReq(normReq(shape));
  } catch (entry) {
    return String((entry as Error).message);
  }
  throw new Error("expected rejection");
}

describe("edit admission gate — single structural hint", () => {
  it("rejects a null file with the structural hint and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, null);
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(STRUCTURAL_PREFIX);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a missing file with the structural hint and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, undefined);
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(STRUCTURAL_PREFIX);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects an empty-string file with the structural hint and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, "");
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(STRUCTURAL_PREFIX);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a whitespace-only file with the structural hint and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, "   ");
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(STRUCTURAL_PREFIX);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a non-string file with the structural hint and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, 123);
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(STRUCTURAL_PREFIX);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a preview with a null file carrying the structural hint and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", path);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const tool = createEditTool();
      const result = await tool.preview(
        {
          file: null,
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "AAA" }],
        },
        cwd,
        ctx,
      );
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("[E_BAD_PAYLOAD]");
        expect(result.error).toContain(STRUCTURAL_PREFIX);
      }
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("assertReq reports one hint for every invalid class", () => {
    const shapes: unknown[] = [
      { edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" }] },
      { file: null, edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" }] },
      { file: 123, edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" }] },
      { file: "", edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" }] },
      { file: "   ", edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" }] },
      { file: "sample.ts", edits: [{ anchor_from: "aB3", anchor_to: "cD4" }] },
      "bare-string",
    ];
    const messages = shapes.map((shape) => messageOf(shape));
    for (const message of messages) {
      expect(message).toContain("[E_BAD_PAYLOAD]");
      expect(message).toContain(STRUCTURAL_PREFIX);
    }
    for (const message of messages) {
      expect(message).toBe(messages[0]);
    }
  });

  it("fails closed for a valid file with malformed edits and for a non-object", () => {
    const badEdits = messageOf({
      file: "sample.ts",
      edits: [{ anchor_from: "aB3", anchor_to: "cD4" }],
    });
    expect(badEdits).toContain("[E_BAD_PAYLOAD]");
    expect(badEdits).toContain(STRUCTURAL_PREFIX);
    const nonObject = messageOf("bare-string");
    expect(nonObject).toContain("[E_BAD_PAYLOAD]");
    expect(nonObject).toContain(STRUCTURAL_PREFIX);
    expect(badEdits).toBe(nonObject);
  });

  it("the narrowed request carries a string file (null is unrepresentable)", () => {
    const typed: NormalizedEditRequest = {
      file: "sample.ts",
      edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" }],
    };
    expect(typed.file).toBe("sample.ts");
    expect(() => assertReq(normReq(typed))).not.toThrow();
  });
});
