import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import { initHasher } from "../../src/hashline/hasher";

/**
 * ADR-0008 heuristic canon healing is retired (spec §3.3). Coordinate realignment across an
 * external shift is owned exclusively by MVCC `pairSnapshots` + `line_lineage`, so these two cases
 * assert the tool silently rebases through the lease identity.
 */
describe("hash heal TDD — MVCC rebase / fail-closed semantics", () => {
  it("multi-line b c silently rebases after an exterior insert above the range (no read)", async () => {
    await initHasher();
    const collidingInsert = "1";
    await withTempFile("sample.ts", "a\nb\nc", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const bHash = extractHash(text.split("\n").find((l) => l.includes("│b"))!);
      const cHash = extractHash(text.split("\n").find((l) => l.includes("│c"))!);
      await writeFile(path, `a\n${collidingInsert}\nb\nc`, "utf-8");
      const result = await editTool.execute(
        "e1",
        { file: "sample.ts", edits: [{ anchor_from: bHash, anchor_to: cHash, text: "B\nC2" }] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      const final = await readFile(path, "utf-8");
      expect(final).toBe("a\n1\nB\nC2");
    });
  });

  it("single-line anchor rebases via its leased line_id (exterior insert, no read)", async () => {
    await initHasher();
    const target = "const t = this.timer;";
    const collidingInsert = "private lastRenderMs21569 = 0;";
    await withTempFile("sample.ts", `a\n${target}\nc`, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const tHash = extractHash(text.split("\n").find((l) => l.includes("│const t"))!);
      await writeFile(path, `a\n${collidingInsert}\n${target}\nc`, "utf-8");
      // No try/catch retry: the lease identity survives the shift, so this must apply first try.
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: tHash, anchor_to: tHash, text: "const t = healed;" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe(`a\n${collidingInsert}\nconst t = healed;\nc`);
    });
  });
});
