import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { createEditTool } from "../../src/edit-tool.js";
import { assertReq, normReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { withTempFile, setupIntegrationTest } from "../support/fixtures";

const FILE_REQUIRED_MESSAGE =
  'Edit request "file" must be a non-empty string naming the text file to edit (never a directory); nothing was written.';

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

describe("edit admission gate — file is the sole entry check", () => {
  it("rejects a null file with the exact E_BAD_PAYLOAD message and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, null);
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(FILE_REQUIRED_MESSAGE);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a missing file with the exact E_BAD_PAYLOAD message and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, undefined);
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(FILE_REQUIRED_MESSAGE);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects an empty-string file with the exact E_BAD_PAYLOAD message and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, "");
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(FILE_REQUIRED_MESSAGE);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a whitespace-only file with the exact E_BAD_PAYLOAD message and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, "   ");
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(FILE_REQUIRED_MESSAGE);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a non-string file with the exact E_BAD_PAYLOAD message and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, 123);
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(FILE_REQUIRED_MESSAGE);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a preview with a null file carrying the exact message and writes nothing", async () => {
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
      );
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("[E_BAD_PAYLOAD]");
        expect(result.error).toContain(FILE_REQUIRED_MESSAGE);
      }
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("assertReq fails closed on every unusable file shape with no remedy", async () => {
    const shapes: unknown[] = [
      { file: null, edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" }] },
      { edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" }] },
      { file: "", edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" }] },
      { file: "   ", edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" }] },
      { file: 123, edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x" }] },
    ];
    for (const shape of shapes) {
      let error: unknown;
      try {
        assertReq(normReq(shape));
      } catch (entry) {
        error = entry;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).toContain("[E_BAD_PAYLOAD]");
      expect(String((error as Error).message)).toContain(FILE_REQUIRED_MESSAGE);
      const payload = (error as { payload?: Record<string, unknown> }).payload;
      if (payload !== undefined) {
        expect(payload).toEqual({ message: FILE_REQUIRED_MESSAGE });
      }
    }
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
