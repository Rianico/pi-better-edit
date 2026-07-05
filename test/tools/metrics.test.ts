import { describe, expect, it } from "vitest";
import register from "../../index";
import { lineHashes } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile, getText } from "../support/fixtures";

describe("details.metrics surface (Phase 2 C — host-only observability)", () => {
  it("read exposes truncation + next_offset metrics, never in text", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join("\n");
    await withTempFile("big.txt", `${lines}\n`, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "big.txt", limit: 50 },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.details?.metrics).toEqual({
        truncated: expect.any(Boolean),
        ...(result.details?.nextOffset !== undefined
          ? { next_offset: result.details.nextOffset }
          : {}),
      });
      expect(getText(result)).not.toContain("metrics");
    });
  });

  it("changed-mode edit reports applied classification + edits_attempted", async () => {
    await withTempFile("a.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("replace");

      const result = await editTool.execute(
        "e1",
        {
          path: "a.txt",
          changes: [
            {
              hash_range_inclusive: [lineHashes("alpha\nbeta\ngamma\n")[1], lineHashes("alpha\nbeta\ngamma\n")[1]], content_lines: ["BETA"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(result.details?.metrics).toMatchObject({
        edits_attempted: 1,
        edits_noop: 0,
        warnings: 0,
        classification: "applied",
        changed_lines: { first: 2, last: 2 },
      });
      expect(getText(result)).not.toContain("metrics");
    });
  });

  it("noop edit reports classification noop and edits_noop count", async () => {
    await withTempFile("b.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("replace");

      const result = await editTool.execute(
        "e1",
        {
          path: "b.txt",
          changes: [
            {
              hash_range_inclusive: [lineHashes("alpha\nbeta\n")[1], lineHashes("alpha\nbeta\n")[1]], content_lines: ["beta"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(result.details?.metrics).toMatchObject({
        edits_attempted: 1,
        edits_noop: 1,
        classification: "noop",
      });
      expect(result.details?.metrics?.changed_lines).toBeUndefined();
    });
  });

  it("hash-anchored replace records a single edit in metrics", async () => {
    await withTempFile("c.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("replace");

      const result = await editTool.execute(
        "e1",
        {
          path: "c.txt",
          changes: [
            {
              hash_range_inclusive: [lineHashes("one\ntwo\nthree\n")[1], lineHashes("one\ntwo\nthree\n")[1]], content_lines: ["TWO"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(result.details?.metrics).toMatchObject({
        edits_attempted: 1,
        classification: "applied",
      });
    });
  });

  it("metrics field never appears in user-visible text", async () => {
    await withTempFile("e.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("replace");

      const result = await editTool.execute(
        "e1",
        {
          path: "e.txt",
          changes: [
            {
              hash_range_inclusive: [lineHashes("alpha\nbeta\n")[1], lineHashes("alpha\nbeta\n")[1]], content_lines: ["beta"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).not.toMatch(/metrics|edits_attempted|edits_noop/);
    });
  });
});
