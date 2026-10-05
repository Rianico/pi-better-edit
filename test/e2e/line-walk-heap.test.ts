import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { walkLines } from "../../src/file-content/line-walker.js";

// WHY: the numbers behind "page the file", as this probe measures them: a 29,888,890-byte, one-million-line
// WHY: text costs +47.2 MB of heap as `split("\n")` — 50 B per line — while a fifty-line page walked out of
// WHY: the same text costs +38.8 KB, and counting every line costs +20.6 KB. A heap delta moves a little
// WHY: run to run, so the JSON is authoritative and those figures are one run of it. (The brief's 4.56x
// WHY: figure was measured on a fixture with shorter lines and is not this probe's number.) Behind
// WHY: RUN_EVAL because a delta is only comparable on an idle, warmed process: run `pnpm run eval:heap`.
const RUN = process.env.RUN_EVAL === "1";
const LINES = 1_000_000;
const PAGE = 50;

/**
 * WHY: the materialized value is handed back to the caller so the measurement cannot be flattered by a
 * collection of a result nothing holds any more.
 */
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
