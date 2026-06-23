import { describe, expect, it, vi, beforeEach } from "vitest";
import { chmod } from "fs/promises";
import { compPreview } from "../../src/replace";
import { lineHash } from "../../src/hashline";
import { withTempFile } from "../support/fixtures";

vi.mock("../../src/file-kind", () => ({
  loadFileKindAndText: vi.fn(),
  classifyFileKind: vi.fn(),
}));

import * as fileKindMod from "../../src/file-kind";

describe("compPreview", () => {
  beforeEach(() => {
    vi.mocked(fileKindMod.loadFileKindAndText).mockReset();
    vi.mocked(fileKindMod.classifyFileKind).mockReset();
  });

  it("returns a diff for strict hashline edits before execution", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({ kind: "text", text: "aaa\nbbb\nccc\n" });

      const betaRef = lineHash(2, "bbb");
      const preview = await compPreview(
        {
          path: "sample.txt",
          edits: [{ hash_range_incl: [betaRef, betaRef], new_lines: ["BBB"] }],
        },
        cwd,
      );

      expect("diff" in preview).toBe(true);
      if (!("diff" in preview)) {
        return;
      }
      expect(preview.diff).toContain(`+${lineHash(2, "BBB")}`);
	      expect(preview.diff).toContain("│BBB");
    });
  });

  it("returns a diff for a hash-anchored replace before execution", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
        kind: "text",
        text: "alpha\nbeta\ngamma\n",
      });

      const betaRef = lineHash(2, "beta");
      const preview = await compPreview(
        {
          path: "sample.txt",
          edits: [{ hash_range_incl: [betaRef, betaRef], new_lines: ["BETA"] }],
        },
        cwd,
      );

      expect("diff" in preview).toBe(true);
      if (!("diff" in preview)) {
        return;
      }
      expect(preview.diff).toContain("BETA");
    });
  });

  it("still computes a preview diff for read-only files", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({ kind: "text", text: "aaa\nbbb\nccc\n" });

      await chmod(path, 0o444);
      const betaRef = lineHash(2, "bbb");

      try {
        const preview = await compPreview(
          {
            path: "sample.txt",
            edits: [{ hash_range_incl: [betaRef, betaRef], new_lines: ["BBB"] }],
          },
          cwd,
        );

        expect("diff" in preview).toBe(true);
        if (!("diff" in preview)) {
          return;
        }
	        expect(preview.diff).toContain("│BBB");
      } finally {
        await chmod(path, 0o644);
      }
    });
  });

  it("uses the shared text loader for preview instead of classifying then re-reading text", async () => {
    await withTempFile("sample.txt", "ignored\n", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({ kind: "text", text: "aaa\nbbb\nccc\n" });
      vi.mocked(fileKindMod.classifyFileKind).mockRejectedValue(
        new Error("preview should not call classifyFileKind on text paths"),
      );

      const betaRef = lineHash(2, "bbb");
      const preview = await compPreview(
        {
          path: "sample.txt",
          edits: [{ hash_range_incl: [betaRef, betaRef], new_lines: ["BBB"] }],
        },
        cwd,
      );

      expect("diff" in preview).toBe(true);
      if (!("diff" in preview)) {
        return;
      }
	      expect(preview.diff).toContain("│BBB");
      expect(vi.mocked(fileKindMod.classifyFileKind)).not.toHaveBeenCalled();
    });
  });

  it("does not let a delayed preview resurrect after a settled result", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      let loadCount = 0;
      vi.mocked(fileKindMod.loadFileKindAndText).mockImplementation(async () => {
        loadCount += 1;
        if (loadCount === 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return { kind: "text", text: "aaa\nbbb\nccc\n" };
      });

      const betaRef = lineHash(2, "bbb");
      const editArgs = {
        path: "sample.txt",
        edits: [{ hash_range_incl: [betaRef, betaRef], new_lines: ["BBB"] }],
      };

      const { regReplace } = await import("../../src/replace");
      const tools = new Map<string, any>();
      const pi = {
        registerTool(tool: any) {
          tools.set(tool.name, tool);
        },
        on() {},
      };
      regReplace(pi as any);
      const tool = tools.get("replace");
      if (!tool) throw new Error("Tool not registered: edit");

      const theme = {
        bold: (text: string) => text,
        fg: (_token: string, text: string) => text,
      };
      const state: Record<string, unknown> = {};

      tool.renderCall(editArgs, theme, {
        argsComplete: true,
        state,
        cwd,
        expanded: false,
        lastComponent: undefined,
        invalidate() {},
      });

      const result = await tool.execute(
        "e1",
        editArgs,
        undefined,
        undefined,
        { cwd },
      );
      tool.renderResult(
        result,
        { expanded: false, isPartial: false },
        theme,
        {
          args: editArgs,
          state,
          isError: false,
          lastComponent: undefined,
          invalidate() {},
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(state.preview ?? null).toBeNull();
    });
  });
});
