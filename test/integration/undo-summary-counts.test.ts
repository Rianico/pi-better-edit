import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

/**
 * Issue #173: the undo summary counts must derive from the source line multisets, never from the
 * rendered context-0 projection — a deleted run longer than `DIFF_REMOVED_CAP` collapses behind a
 * marker row, so counting `-` rows underreports the restored lines.
 */

const TWENTY_LINES = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";

async function undoAfterEdit(
  file: string,
  original: string,
  edits: (readLines: string[]) => unknown[],
  assert: (undone: { details?: unknown }, text: string, restored: string) => void,
): Promise<void> {
  await withTempFile(file, original, async ({ cwd, path }) => {
    const { ctx, readTool, editTool, undoTool } = setupIntegrationTest(cwd);
    const r1 = await readTool.execute("r1", { path: file }, undefined, undefined, ctx);
    await editTool.execute(
      "e1",
      { file: file, edits: edits(getText(r1).split("\n")) },
      undefined,
      undefined,
      ctx,
    );
    const undone = await undoTool.execute("u1", { path: file }, undefined, undefined, ctx);
    assert(undone, getText(undone), await readFile(path, "utf-8"));
  });
}

describe("undo_last_edit summary counts (#173)", () => {
  it("counts a large deleted run exactly even though the rendered diff collapses it", async () => {
    await undoAfterEdit(
      "undo_counts_bigdelete.txt",
      TWENTY_LINES,
      (readLines) => [
        // Delete lines 3..16 (14 lines, beyond the 6-line removal cap) and add one line.
        {
          anchor_from: extractHash(readLines[2]!),
          anchor_to: extractHash(readLines[15]!),
          text: "REPLACED",
        },
      ],
      (undone, text, restored) => {
        expect(restored).toBe(TWENTY_LINES);
        expect(text).toContain(
          "Removed 1 line(s) that were added and restored 14 line(s) that were removed.",
        );
        const metrics = (undone.details as { metrics?: Record<string, number> }).metrics;
        // The undo restores the 14 lines the edit removed and drops the 1 line it added.
        expect(metrics?.added_lines).toBe(14);
        expect(metrics?.removed_lines).toBe(1);
      },
    );
  });

  it("keeps exact counts for a small (non-collapsed) deleted run beside added lines", async () => {
    await undoAfterEdit(
      "undo_counts_smalldelete.txt",
      TWENTY_LINES,
      (readLines) => [
        {
          anchor_from: extractHash(readLines[2]!),
          anchor_to: extractHash(readLines[4]!),
          text: "A\nB",
        },
      ],
      (undone, text, restored) => {
        expect(restored).toBe(TWENTY_LINES);
        expect(text).toContain(
          "Removed 2 line(s) that were added and restored 3 line(s) that were removed.",
        );
        const metrics = (undone.details as { metrics?: Record<string, number> }).metrics;
        expect(metrics?.added_lines).toBe(3);
        expect(metrics?.removed_lines).toBe(2);
      },
    );
  });
});
