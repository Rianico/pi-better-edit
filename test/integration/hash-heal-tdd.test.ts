import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import { _lineHashesPure } from "../../src/hashline/hash";
import { initHasher } from "../../src/hashline/hasher";
import { verifyServedRange } from "../../src/hashline/served";

/**
 * ADR-0008 heuristic canon healing is retired (spec §3.3). Coordinate realignment across an
 * external shift is owned exclusively by MVCC `pairSnapshots` + `line_lineage`, so these two cases
 * assert the tool silently rebases through the lease identity, and that a direct un-rebased
 * verification call fails closed instead of relocating by canon scan.
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
        { path: "sample.ts", edits: [[bHash, cHash, "B\nC2"]] },
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
        { path: "sample.ts", edits: [[tHash, tHash, "const t = healed;"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe(`a\n${collidingInsert}\nconst t = healed;\nc`);
    });
  });

  it("un-rebased served coordinates fail closed instead of healing via canon", async () => {
    await initHasher();
    const oldContent = "a\nb\nc";
    const collidingInsert = "1";
    const newContent = `a\n${collidingInsert}\nb\nc`;
    const oldHashes = _lineHashesPure(oldContent);
    const newHashesPure = _lineHashesPure(newContent);
    expect(oldHashes[1] === newHashesPure[2]).toBe(true);
    const served = [...oldHashes];
    const fileLines = newContent.split("\n");
    const fileHashes = newHashesPure;
    const bHash = oldHashes[1]!;
    const cHash = oldHashes[2]!;
    // Old coordinates (2..3): the served array is not rebased, so the current line 2 holds the
    // inserted `1` whose anchor was never served. ADR-0008 used to relocate this by canon scan.
    expect(() =>
      verifyServedRange({
        served,
        startHash: bHash,
        endHash: cHash,
        startLine: 2,
        endLine: 3,
        fileHashes,
        fileLines,
      }),
    ).toThrow(/E_STALE_RANGE/);
  });
});
