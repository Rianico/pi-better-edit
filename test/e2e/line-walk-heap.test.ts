import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { walkLines } from "../../src/file-content/line-walker.js";

/**
 * The numbers behind "page the file", as this probe measures them, on a 29,888,890-byte
 * one-million-line text: `split("\n")` costs +47.2 MB of heap (50 B per line), a fifty-line
 * page walked out of the same text +38.8 KB, and counting every line +20.6 KB. A heap delta
 * moves run to run, so the JSON this prints is authoritative. Behind RUN_EVAL because a
 * delta is only comparable on an idle, warmed process: run `pnpm run eval:heap`.
 */
const RUN = process.env.RUN_EVAL === "1";
const LINES = 1_000_000;
const PAGE = 50;

/** Hands the materialized value back so a collection cannot flatter the measurement. */
function heapDelta(run: () => unknown): { delta: number; kept: unknown } {
  const before = process.memoryUsage().heapUsed;
  const kept = run();
  return { delta: process.memoryUsage().heapUsed - before, kept };
}

describe.skipIf(!RUN)("the walk's heap against the split baseline", () => {
  it("holds one page where the split holds the file", () => {
    const text = `${Array.from({ length: LINES }, (_, index) => `line ${index} of the walk probe`).join("\n")}\n`;
    const split = heapDelta(() => text.split("\n"));
    const page = heapDelta(() => walkLines(text, [{ start: 0, end: PAGE }]));
    const counted = heapDelta(() => walkLines(text));
    const report = {
      textBytes: text.length,
      lines: LINES,
      splitBytes: split.delta,
      pageBytes: page.delta,
      countedBytes: counted.delta,
      splitBytesPerLine: Math.round(split.delta / LINES),
      ratio: Number((split.delta / Math.max(page.delta, 1)).toFixed(1)),
    };
    const out = process.env.HEAP_PROBE_OUT ?? join(tmpdir(), "pi-better-edit-heap.json");
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    expect((page.kept as { ranges: string[][] }).ranges[0]).toEqual(
      (split.kept as string[]).slice(0, PAGE),
    );
    expect((counted.kept as { total: number }).total).toBe(LINES);
    expect(report.ratio).toBeGreaterThan(10);
  }, 300_000);
});
