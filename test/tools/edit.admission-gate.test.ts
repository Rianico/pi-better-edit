import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { createEditTool } from "../../src/edit-tool.js";
import { assertReq, normReq } from "../../src/payload-contract.js";
import { withTempFile, setupIntegrationTest } from "../support/fixtures";

// WHY: (ticket-04 §3) the admission analyzer now names the per-class failure reason, so the old
// WHY: verbatim one-hint-for-everything prefix is gone; what every rejection still shares is the
// WHY: canonical payload phrase.
// WHY: (ADR-0036) the refusal now says "payload field"; the shared substring is the leading phrase.
const PAYLOAD_HINT = "exactly one payload";

async function executeWithFile(cwd: string, fileValue: unknown): Promise<Error> {
  const { ctx, readTool } = setupIntegrationTest(cwd);
  const hashes = await lineHashes("aaa\nbbb\n", `${cwd}/sample.ts`);
  await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
  const tool = createEditTool();
  const payload: Record<string, unknown> = {
    edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "AAA" }],
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

describe("edit admission gate — shared payload hint", () => {
  it("rejects a null file with the shared payload hint and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, null);
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(PAYLOAD_HINT);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a missing file with the shared payload hint and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, undefined);
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(PAYLOAD_HINT);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects an empty-string file with the shared payload hint and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, "");
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(PAYLOAD_HINT);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a whitespace-only file with the shared payload hint and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, "   ");
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(PAYLOAD_HINT);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a non-string file with the shared payload hint and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const error = await executeWithFile(cwd, 123);
      expect(String(error.message)).toContain("[E_BAD_PAYLOAD]");
      expect(String(error.message)).toContain(PAYLOAD_HINT);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("rejects a preview with a null file carrying the structural hint and writes nothing", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", path);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const tool = createEditTool();
      const result = await tool.preview(
        {
          file: null,
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "AAA" }],
        },
        cwd,
        ctx,
      );
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("[E_BAD_PAYLOAD]");
        expect(result.error).toContain(PAYLOAD_HINT);
      }
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("assertReq names every invalid class with the payload hint", () => {
    const shapes: unknown[] = [
      { edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "x" }] },
      { file: null, edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "x" }] },
      { file: 123, edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "x" }] },
      { file: "", edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "x" }] },
      { file: "   ", edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "x" }] },
      { file: "sample.ts", edits: [{ anchor_from: "aB3", anchor_to: "cD4" }] },
      "bare-string",
    ];
    const messages = shapes.map((shape) => messageOf(shape));
    for (const message of messages) {
      expect(message).toContain("[E_BAD_PAYLOAD]");
      expect(message).toContain(PAYLOAD_HINT);
    }
  });

  it("fails closed for a valid file with malformed edits and for a non-object", () => {
    const badEdits = messageOf({
      file: "sample.ts",
      edits: [{ anchor_from: "aB3", anchor_to: "cD4" }],
    });
    expect(badEdits).toContain("[E_BAD_PAYLOAD]");
    expect(badEdits).toContain(PAYLOAD_HINT);
    const nonObject = messageOf("bare-string");
    expect(nonObject).toContain("[E_BAD_PAYLOAD]");
    expect(nonObject).toContain(PAYLOAD_HINT);
  });

  it("the narrowed request carries a string file (null is unrepresentable)", () => {
    const wire = {
      file: "sample.ts",
      edits: [{ anchor_from: "aB3", anchor_to: "cD4", text: "x" }],
    };
    const narrowed = normReq(wire);
    assertReq(narrowed);
    expect(narrowed.file).toBe("sample.ts");
  });
});
