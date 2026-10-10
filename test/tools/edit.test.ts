import { describe, expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";
import { contentOnlyHashes } from "../../src/hashline/hash";
import { applyEdit } from "../../src/hashline/apply";
import { canonDigest } from "../../src/hashline/hash-identity";
import type { LeaseIdentityView, LeaseSpanSource, HEdit } from "../../src/hashline/resolve";
import { HASH_RE } from "../../src/hashline/alphabet.js";
import { withTempFile, setupIntegrationTest, useTestHome, extractHash } from "../support/fixtures";
import { DIFF_REMOVED_CAP, DIFF_REMOVED_EDGE } from "../../src/constants";

useTestHome();

describe("regEdit", () => {
  it("rejects malformed null lines during direct execute without modifying the file", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);

      await expect(
        editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: null }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow();
    });
  });

  it("accepts multi-line text with \\n separators", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);

      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "a\nb" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully edited");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("a\nb\nbbb\n");
    });
  });

  it("renders the anchored diff in the model-visible text alongside the details diff", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);

      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BBB" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully edited");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
      expect(result.details?.diff).toBeDefined();
      expect(result.details?.diff).toContain("BBB");
      // Re-pointed for I4 (spec §5): the anchored diff now travels in content[0].text, not only in
      // details.diff — the details field stays byte-identical for TUI presentation clients.
      expect(result.content[0].text).toContain(result.details!.diff);
    });
  });

  it("refuses a reproduced served row in text with E_SUSPICIOUS_TEXT (deny, not strip)", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const before = await readFile(path, "utf-8");
      await expect(
        editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: `${hashes[1]!}│bbb` }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_SUSPICIOUS_TEXT/);
      const after = await readFile(path, "utf-8");
      expect(after).toBe(before);
    });
  });

  it("writes never-served HASH│ bytes through byte-exact", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      // WHY: premise guard — the never-served row below reaches the served-set
      // WHY: logic only if the served set itself is live-width.
      expect(hashes.every((h) => HASH_RE.test(h))).toBe(true);
      // WHY: width-5 tripwire — pins the fixture token itself row-shaped, so
      // WHY: this fixture reddens (not just its differential) if a flip strands it.
      expect(HASH_RE.test("Zz99")).toBe(true);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "Zz99│BBB" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully edited");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nZz99│BBB\nccc\n");
    });
  });

  it("refuses the fixture token when served (tier live)", () => {
    // WHY: drives the fixture token itself — with "Zz99" served, the same
    // WHY: "Zz99│BBB" row the byte-exact test writes through is refused. At any
    // WHY: width where Zz99 is not row-shaped this reddens (no refusal), so the
    // WHY: F1 vacuity cannot recur silently.
    const content = "aaa\nbbb\nccc\n";
    const hashes = contentOnlyHashes(content);
    expect(hashes.every((h) => HASH_RE.test(h))).toBe(true);
    const served: (string | null)[] = ["Zz99", ...hashes.slice(1)];
    const leases: Record<string, LeaseIdentityView> = {
      Zz99: {
        lineId: 1,
        canonHash: canonDigest("BBB"),
        servedSnapshotHash: "S",
        servedLineNumber: 1,
        retiredAt: null,
      },
    };
    const identity: LeaseSpanSource = {
      currentSnapshotHash: "C",
      leaseFor: (anchor) => leases[anchor],
      rebasedLineOf: (lineId) => lineId,
    };
    const edit = {
      hash_bounds: [{ hash: "Zz99" }, { hash: "Zz99" }],
      content_lines: ["Zz99│BBB"],
    } as unknown as HEdit;
    expect(() =>
      applyEdit(content, edit, undefined, hashes, {
        filePath: "sample.ts",
        served,
        canonDigests: [canonDigest("BBB"), null, null],
        identity,
      }),
    ).toThrow(/E_SUSPICIOUS_TEXT/);
  });

  it("writes diff-marker HASH│ bytes through byte-exact", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const marker = `+${hashes[1]!}│BBB`;
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: marker }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully edited");
      const content = await readFile(path, "utf-8");
      expect(content).toBe(`aaa\n${marker}\nccc\n`);
    });
  });

  it("autocorrects reversed anchor_from/anchor_to with correct line counts", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);

      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[2]!, anchor_to: hashes[1]!, text: "X" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully edited");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 2 line(s).");
      expect(result.content[0].text).toContain("[USER] [W_REVERSED_ANCHORS]");
      expect(result.content[0].text).toContain("were reversed");
      expect(result.details?.diff).toContain("X");
    });
  });

  it("autocorrects HASH│ rows in anchor_from/anchor_to with a warning", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);

      await expect(
        editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [
              { anchor_from: `${hashes[1]!}│bbb`, anchor_to: `${hashes[1]!}│bbb`, text: "BBB" },
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/\[E_MALFORMED_ANCHOR\]/);
    });
  });
});

describe("regEdit — robustness", () => {
  it("reports success even when the post-edit snapshot fails", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const fileReader = await import("../../src/file-reader");
      const spy = vi.spyOn(fileReader, "fileSnap").mockRejectedValue(new Error("stat failed"));
      try {
        const result = await editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BBB" }],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(result.content[0].text).toContain("Successfully edited");
        expect(result.details?.snapshotId).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("reports success even when the noop-path snapshot fails", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const fileReader = await import("../../src/file-reader");
      const spy = vi.spyOn(fileReader, "fileSnap").mockRejectedValue(new Error("stat failed"));
      try {
        const result = await editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" }],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(result.content[0].text).toContain("No changes made");
        expect(result.details?.classification).toBe("noop");
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("applies the edit even when snapshot persistence fails", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const hashStore = await import("../../src/snapshot-store");
      const spy = vi.spyOn(hashStore, "upsertSnapshot").mockImplementation(() => {
        throw new Error("store down");
      });
      try {
        const result = await editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BBB" }],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(result.content[0].text).toContain("Successfully edited");
      } finally {
        spy.mockRestore();
      }
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("reports success with a deferred store-synchronization warning when the post-write snapshot fails", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const hashStore = await import("../../src/snapshot-store");
      const spy = vi
        .spyOn(hashStore, "upsertSnapshotFor")
        .mockRejectedValue(new Error("store busy"));
      try {
        const result = await editTool.execute(
          "e1",
          {
            file: "sample.ts",
            edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BBB" }],
          },
          undefined,
          undefined,
          ctx,
        );
        // SPEC §3.6.2: the bytes are on disk, so the tool still reports success…
        expect(result.content[0].text).toContain("Successfully edited");
        // …along with the warning that store synchronization is deferred.
        expect(result.content[0].text).toContain("Store synchronization deferred");
        const warnings = (result.details as { warnings?: string[] } | undefined)?.warnings;
        expect(warnings?.some((w) => w.includes("Store synchronization deferred"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("still refuses the edit when undo persistence fails", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const undoStore = await import("../../src/undo-store");
      const spy = vi.spyOn(undoStore, "writeUndo").mockImplementation(() => {
        throw new Error("store down");
      });
      try {
        await expect(
          editTool.execute(
            "e1",
            {
              file: "sample.ts",
              edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BBB" }],
            },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/E_UNDO_UNAVAILABLE/);
      } finally {
        spy.mockRestore();
      }
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nbbb\nccc\n");
    });
  });
});

/**
 * I4 (spec §5): the edit tool's model-visible text is `<summary line>\n\n<anchored diff>`; the diff
 * stays collapsed by the #174 single-projection rule, and the rows it shows are leased before the
 * tool result returns — so a follow-up edit anchors on a just-modified row with no intermediate read.
 */
describe("I4 — model-visible anchored diff", () => {
  it("T1: returns the summary line, a blank line, then the anchored diff", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);

      const result = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BBB" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const text: string = result.content[0]!.text;
      const [summaryLine, blankLine, ...diffRows] = text.split("\n");
      expect(summaryLine).toBe(
        "Successfully edited 1 file(s) — 1 of 1 edit(s) applied. Added 1 line(s), removed 1 line(s).",
      );
      expect(blankLine).toBe("");
      const modelDiff = diffRows.join("\n");
      expect(modelDiff).toBe(result.details!.diff);
      expect(modelDiff).toMatch(/^[ +-][A-Za-z0-9]{4}│/m);
      expect(modelDiff).toContain("│BBB");
    });
  });

  it("T2: chains a second edit onto a row the first edit modified with no intermediate read", async () => {
    await withTempFile("sample.ts", "l1\nl2\nl3\nl4\nl5\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("l1\nl2\nl3\nl4\nl5\n", join(cwd, "sample.ts"));
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);

      const first = await editTool.execute(
        "e1",
        {
          file: "sample.ts",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "MID" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0]!.text).toContain("Successfully edited");
      const modifiedRow = first.content[0]!.text.split("\n").find(
        (line: string) => line.startsWith("+") && line.includes("│MID"),
      )!;
      const modifiedRef = extractHash(modifiedRow.slice(1));

      const second = await editTool.execute(
        "e2",
        {
          file: "sample.ts",
          edits: [{ anchor_from: modifiedRef, anchor_to: modifiedRef, text: "DONE" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(second.content[0]!.text).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("l1\nDONE\nl3\nl4\nl5\n");
    });
  });

  it("T3: keeps the model-visible diff collapsed with deleted-span counting", async () => {
    const content = `${Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    await withTempFile("big.ts", content, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes(content, join(cwd, "big.ts"));
      await readTool.execute("r1", { file: "big.ts" }, undefined, undefined, ctx);

      const result = await editTool.execute(
        "e1",
        {
          file: "big.ts",
          edits: [{ anchor_from: hashes[2]!, anchor_to: hashes[201]!, text: "REPLACED" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const text: string = result.content[0]!.text;
      const modelDiff = text.split("\n").slice(2).join("\n");
      expect(modelDiff).toBe(result.details!.diff);
      expect(modelDiff.split("\n")).toContain(" - ... [196 lines deleted] ...");
      expect(modelDiff).not.toContain("│line 100");
      // WHY: deleted-span counting is the DIFF_REMOVED_CAP / DIFF_REMOVED_EDGE collapse in
      // WHY: src/edit-diff.ts pushRemovedLines: a deleted span is emitted either in full (at most
      // WHY: DIFF_REMOVED_CAP anchored rows) or as DIFF_REMOVED_EDGE head rows + the exact-size marker
      // WHY: + DIFF_REMOVED_EDGE tail rows, never all 200. Only anchored rows are counted here; the
      // WHY: "--- <path> ---" header row also starts with "-" but is not an anchored row.
      const removedRows = modelDiff.split("\n").filter((line) => /^-[A-Za-z0-9]{4}│/.test(line));
      expect(removedRows.length).toBeLessThanOrEqual(
        Math.max(DIFF_REMOVED_CAP, DIFF_REMOVED_EDGE * 2),
      );
    });
  });
});
