import { writeFile } from "fs/promises";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  image: { type: "image" as const, data: "aG9zdC1pbWFnZQ==", mimeType: "image/png" },
  structuredContent: {
    type: "image" as const,
    data: "aG9zdC1pbWFnZQ==",
    mimeType: "image/png",
    note: "host-owned note",
  },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createReadTool: () => ({
      execute: async () => ({
        content: [{ type: "text", text: "Read image file [image/png]" }, host.image],
        structuredContent: host.structuredContent,
      }),
    }),
  };
});

import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures";

const minimalPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("read tool image pass-through", () => {
  it("returns the builtin's structured result unchanged when the host supplies one", async () => {
    await withTempFile("test.png", "", async ({ cwd }) => {
      await writeFile(join(cwd, "test.png"), minimalPng);

      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute("r1", { file: "test.png" }, undefined, undefined, ctx);

      expect(getText(result)).toBe("Read image file [image/png]");
      expect(result.structuredContent).toBe(host.structuredContent);
    });
  });
});
